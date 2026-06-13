#!/usr/bin/env node
/**
 * Jack CLI — commands:
 *   jack               interactive mode (Jack asks what you want)
 *   jack "<task>"      run a task through the orchestrator
 *   jack doctor        show detected workers and their health
 *   jack workers       list registered workers
 *   jack brain [id]    show or set which worker Jack uses as his brain
 *   jack history       show this project's conversation history
 *   jack --help / --version
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Interface } from 'node:readline/promises';
import { createInterface } from 'node:readline/promises';
import { resolveBrain } from '../brain/brain.js';
import { buildRegistry, loadConfig } from '../config/load.js';
import { saveBrainChoice, savedBrainChoice } from '../config/persist.js';
import { orchestrate } from '../core/orchestrator.js';
import { RunStore, newRunId } from '../core/run-store.js';
import { SessionHistory } from '../core/session.js';
import type { WorkerRegistry } from '../workers/registry.js';
import {
  MultiProgress,
  banner,
  bold,
  cyan,
  dim,
  green,
  magenta,
  red,
  renderMarkdown,
  yellow,
} from './ui.js';

const VERSION = '0.1.0';

const HELP = `jack — route AI tasks to the subscriptions you already pay for

Usage:
  jack                 Interactive mode — Jack asks what you want
  jack "<task>"        Run a task (plan → route → execute → report)
  jack doctor          Detect installed CLIs and local model servers
  jack workers         List registered workers
  jack brain [id]      Show or set which worker Jack uses as his brain
  jack history         Show this project's conversation history
  jack --version       Print version
  jack --help          Show this help

Config: ~/.jack/config.json, overridden by ./jack.config.json
Runs are persisted under ./jack-runs/<id>/ (task, plan, logs, report).
Conversation history lives in ./jack-runs/history.json and is handed to
workers as context, so follow-up tasks can refer to earlier ones.
`;

const REPL_HELP = `  Type a task and Jack will plan, route and run it.
  Follow-ups can refer to earlier exchanges — Jack passes the history along.

  Commands:
    workers     list registered workers
    doctor      full environment check
    brain       show / change which AI Jack uses as his brain
    history     show the conversation so far
    clear       forget the conversation history
    help        this help
    exit        leave (also: quit, Ctrl+C, Ctrl+D)
`;

const REPL_COMMANDS = ['workers', 'doctor', 'brain', 'history', 'clear', 'help', 'exit', 'quit'];

const REPL_HISTORY_PATH = join(homedir(), '.jack', 'repl_history');

/** Input history for arrow-up recall, persisted across sessions (most recent first). */
async function loadReplHistory(): Promise<string[]> {
  try {
    const text = await readFile(REPL_HISTORY_PATH, 'utf8');
    return text.split('\n').filter(Boolean).slice(-200).reverse();
  } catch {
    return [];
  }
}

async function saveReplHistory(history: readonly string[]): Promise<void> {
  try {
    await mkdir(dirname(REPL_HISTORY_PATH), { recursive: true });
    await writeFile(REPL_HISTORY_PATH, `${[...history].reverse().join('\n')}\n`);
  } catch {
    // Best effort — losing input history is not worth failing over.
  }
}

function fail(message: string): never {
  console.error(red(`jack: ${message}`));
  process.exit(1);
}

interface JackSession {
  config: Awaited<ReturnType<typeof loadConfig>>;
  registry: WorkerRegistry;
  history: SessionHistory;
  brainId: string;
  /** Workers that hit auth/quota errors this session — deprioritized on later runs. */
  degraded: Set<string>;
}

async function loadSession(): Promise<JackSession> {
  const config = await loadConfig();
  const { registry } = await buildRegistry(config);
  if (registry.all().length === 0) {
    fail('no workers available. Run `jack doctor` to see what is missing.');
  }
  const history = await SessionHistory.load(config.runsDir);
  const brain = resolveBrain(registry, config.brain, { model: config.brainModel });
  return {
    config,
    registry,
    history,
    brainId: brain?.workerId ?? config.brain,
    degraded: new Set<string>(),
  };
}

function seconds(ms?: number): string {
  return ms === undefined ? '' : ` ${(ms / 1000).toFixed(1)}s`;
}

/** Run one task: history context in, exchange recorded out. */
async function executeTask(prompt: string, session: JackSession): Promise<boolean> {
  const brain = resolveBrain(session.registry, session.brainId, {
    model: session.config.brainModel,
  });
  const store = await RunStore.create(session.config.runsDir, newRunId());
  const task = {
    id: store.runId,
    prompt,
    cwd: process.cwd(),
    context: session.history.contextBlock(),
  };

  const startedAt = Date.now();
  const progress = new MultiProgress();
  progress.start();
  progress.spin('plan', `planning${brain ? dim(` (brain: ${brain.workerId})`) : ''}…`);

  // Live streaming: only for a single-subtask plan (the common case). With one
  // subtask the streamed tokens ARE the final answer, so we print them as they
  // arrive and skip re-printing the report. Parallel multi-subtask output would
  // interleave into garbage, so there we keep the progress block + final report.
  let streamSingle = false;
  let streamStarted = false;

  const record = await orchestrate(task, {
    registry: session.registry,
    store,
    brain,
    preferTier: session.config.routing.preferTier,
    maxConcurrency: session.config.routing.maxConcurrency,
    maxAttemptsPerSubtask: session.config.routing.maxAttemptsPerSubtask,
    degraded: session.degraded,
    events: {
      onPlan: (plan) => {
        streamSingle = plan.subtasks.length === 1;
        progress.info('plan', dim(`plan: ${plan.subtasks.length} subtask(s)`));
        // One live line per subtask, queued until dispatched.
        for (const s of plan.subtasks) {
          progress.spin(s.id, `${s.id} ${dim(`[${s.capability}]`)} ${dim('queued')}`);
        }
      },
      onDispatch: (subtask, decision, attempt) => {
        if (streamStarted) return; // already streaming the answer; don't redraw
        const suffix = attempt > 1 ? yellow(` (attempt ${attempt}, falling back)`) : '';
        progress.spin(
          subtask.id,
          `${subtask.id} ${dim(`[${subtask.capability}]`)} → ${bold(decision.workerId)}${suffix}`,
        );
      },
      onChunk: (_subtaskId, text) => {
        if (!streamSingle) return;
        if (!streamStarted) {
          streamStarted = true;
          progress.stop(); // freeze the plan/dispatch block above the answer
          process.stdout.write('\n');
        }
        process.stdout.write(text);
      },
      onSubtaskDone: (outcome) => {
        if (streamStarted) return; // streamed live already — no status churn
        const line = `${outcome.subtaskId} ← ${outcome.workerId}${dim(seconds(outcome.result.usage?.ms))}`;
        if (outcome.result.ok) progress.ok(outcome.subtaskId, line);
        else progress.err(outcome.subtaskId, `${line} ${red(outcome.result.error ?? 'failed')}`);
      },
    },
  }).finally(() => progress.stop());

  if (streamStarted) process.stdout.write('\n');
  else console.log(`\n${renderMarkdown(record.report)}`);
  console.log(
    dim(
      `\n  done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — run ${store.runId} (${store.dir})`,
    ),
  );
  if (session.degraded.size > 0) {
    console.log(
      yellow(
        `  ⚠ deprioritized this session (auth/quota): ${[...session.degraded].join(', ')} — fix with \`brain\` or re-login.`,
      ),
    );
  }

  // Always record the exchange — even a failure stays in the thread so Jack
  // keeps the context for the next question.
  await session.history.record({
    at: new Date().toISOString(),
    task: prompt,
    answer: record.report,
    runId: store.runId,
    ok: record.status !== 'failed',
  });

  if (record.status === 'failed') {
    console.error(red(`jack: run failed — see ${store.dir}`));
    return false;
  }
  return true;
}

async function cmdDoctor(): Promise<void> {
  const config = await loadConfig();
  const { registry, detection } = await buildRegistry(config);

  console.log(bold('Subscription CLIs:'));
  for (const cli of detection.clis) {
    const status = cli.found
      ? green(`OK  (${cli.version ?? 'version unknown'})`)
      : dim('not found');
    console.log(`  ${cli.command.padEnd(8)} ${status}`);
  }

  console.log(bold('\nLocal model servers:'));
  for (const server of detection.localServers) {
    const status = server.up
      ? green(
          `UP  (${server.models.length} model${server.models.length === 1 ? '' : 's'}${server.models[0] ? `, e.g. ${server.models[0]}` : ''})`,
        )
      : dim('down');
    console.log(`  ${server.label.padEnd(10)} ${server.baseUrl.padEnd(28)} ${status}`);
  }

  console.log(bold('\nRegistered workers (health):'));
  const health = await registry.healthReport();
  for (const worker of registry.all()) {
    const ok = health.get(worker.id) ? green('healthy') : red('UNHEALTHY');
    console.log(`  ${worker.id.padEnd(24)} tier=${worker.costTier.padEnd(12)} ${ok}`);
  }
  if (registry.all().length === 0) {
    console.log(dim('  (none — install claude/codex/gemini or start Ollama/LM Studio)'));
  }

  const brain = resolveBrain(registry, config.brain, { model: config.brainModel });
  console.log(
    `\n${bold('Brain:')} ${brain ? brain.workerId : 'none (single-subtask fallback mode)'}`,
  );
}

async function cmdWorkers(): Promise<void> {
  const config = await loadConfig();
  const { registry } = await buildRegistry(config);
  for (const worker of registry.all()) {
    console.log(
      `${bold(worker.id.padEnd(24))} tier=${worker.costTier.padEnd(12)} caps=${dim(worker.capabilities.join(','))}`,
    );
  }
  if (registry.all().length === 0) console.log('(no workers — run `jack doctor`)');
}

async function cmdHistory(): Promise<void> {
  const config = await loadConfig();
  const history = await SessionHistory.load(config.runsDir);
  const entries = history.all();
  if (entries.length === 0) {
    console.log(dim('(no history yet for this project)'));
    return;
  }
  for (const entry of entries) {
    const answer = entry.answer.length > 200 ? `${entry.answer.slice(0, 200)} […]` : entry.answer;
    console.log(`${dim(entry.at)} ${bold('you:')} ${entry.task}`);
    console.log(`${' '.repeat(25)}${magenta('jack:')} ${answer.replace(/\n/g, ' ')}\n`);
  }
}

/** Interactive brain picker; returns the (possibly unchanged) brain id. */
async function chooseBrain(
  rl: Interface,
  registry: WorkerRegistry,
  currentId: string,
): Promise<string> {
  const workers = registry.all();
  console.log('\n  Which AI should Jack use as his brain (planning, routing, synthesis)?');
  workers.forEach((w, i) => {
    const marker = w.id === currentId ? green('  ← current') : '';
    console.log(
      `    ${bold(String(i + 1))}. ${w.id.padEnd(24)} ${dim(`tier=${w.costTier}`)}${marker}`,
    );
  });
  const answer = (
    await rl.question(dim(`  choice [1-${workers.length}, Enter keeps ${currentId}]: `))
  ).trim();
  if (!answer) return currentId;
  const chosen = workers[Number(answer) - 1] ?? workers.find((w) => w.id === answer);
  if (!chosen) {
    console.log(yellow(`  unknown choice — keeping ${currentId}`));
    return currentId;
  }
  await saveBrainChoice(chosen.id);
  console.log(green(`  brain set to ${chosen.id}`) + dim(' (saved to ~/.jack/config.json)'));
  return chosen.id;
}

async function cmdBrain(workerId?: string): Promise<void> {
  const config = await loadConfig();
  const { registry } = await buildRegistry(config);
  if (!workerId) {
    const brain = resolveBrain(registry, config.brain, { model: config.brainModel });
    console.log(`Brain: ${bold(brain ? brain.workerId : 'none')}`);
    console.log(
      dim(
        `Available: ${registry
          .all()
          .map((w) => w.id)
          .join(', ')}`,
      ),
    );
    console.log(dim('Set with: jack brain <worker-id>'));
    return;
  }
  if (!registry.get(workerId)) {
    fail(
      `unknown worker "${workerId}". Available: ${registry
        .all()
        .map((w) => w.id)
        .join(', ')}`,
    );
  }
  await saveBrainChoice(workerId);
  console.log(green(`brain set to ${workerId}`) + dim(' (saved to ~/.jack/config.json)'));
}

async function cmdRun(prompt: string): Promise<void> {
  const session = await loadSession();
  const ok = await executeTask(prompt, session);
  if (!ok) process.exit(1);
}

/** `jack` with no arguments: Jack greets you and asks what you want, in a loop. */
async function cmdInteractive(): Promise<void> {
  const session = await loadSession();
  const workers = session.registry.all();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string): [string[], string] => {
      const hits = REPL_COMMANDS.filter((c) => c.startsWith(line));
      return [hits.length > 0 ? hits : REPL_COMMANDS, line];
    },
    history: await loadReplHistory(),
  });
  // `history` exists at runtime but is missing from the promises typings.
  const replHistory = (): readonly string[] =>
    (rl as unknown as { history?: string[] }).history ?? [];
  rl.on('SIGINT', () => {
    void saveReplHistory(replHistory()).finally(() => {
      console.log(`\n${magenta('🎩 See you!')}`);
      process.exit(0);
    });
  });

  banner(VERSION, 'route AI tasks to the subscriptions you already pay for');
  console.log(`  ${dim(`${workers.length} worker(s):`)} ${workers.map((w) => w.id).join(', ')}`);
  if (session.history.length > 0) {
    console.log(
      `  ${dim(`I remember our last ${Math.min(session.history.length, 50)} exchange(s) — follow-ups welcome.`)}`,
    );
  }

  // First start: ask which AI Jack should use as his brain, then remember it.
  const saved = await savedBrainChoice();
  if (!saved) {
    session.brainId = await chooseBrain(rl, session.registry, session.brainId);
  } else {
    console.log(`  ${dim('brain:')} ${session.brainId} ${dim('(change with "brain")')}`);
  }
  console.log(dim('  Type a task, or "help" for commands.\n'));

  while (true) {
    let line: string;
    try {
      line = await rl.question(`${cyan('jack')} ${dim('›')} `);
    } catch {
      break; // stdin closed (Ctrl+D)
    }
    const input = line.trim();
    if (!input) continue;

    if (input === 'exit' || input === 'quit') break;
    if (input === 'help') {
      console.log(REPL_HELP);
      continue;
    }
    if (input === 'doctor') {
      await cmdDoctor();
      continue;
    }
    if (input === 'workers') {
      await cmdWorkers();
      continue;
    }
    if (input === 'history') {
      await cmdHistory();
      continue;
    }
    if (input === 'clear') {
      await session.history.clear();
      console.log(dim('  history cleared — fresh start.'));
      continue;
    }
    if (input === 'brain' || input.startsWith('brain ')) {
      const arg = input.slice('brain'.length).trim();
      // Accept a worker id or its number from the `workers`/picker listing.
      const byIndex = session.registry.all()[Number(arg) - 1];
      const chosen = arg ? (session.registry.get(arg) ?? byIndex) : undefined;
      if (chosen) {
        await saveBrainChoice(chosen.id);
        session.brainId = chosen.id;
        console.log(green(`  brain set to ${chosen.id}`));
      } else if (arg) {
        console.log(yellow(`  unknown worker "${arg}"`));
      } else {
        session.brainId = await chooseBrain(rl, session.registry, session.brainId);
      }
      continue;
    }

    try {
      await executeTask(input, session);
    } catch (err) {
      console.error(red(`jack: ${err instanceof Error ? err.message : String(err)}`));
    }
    console.log(`\n${magenta('🎩')} ${dim('Anything else?')}\n`);
  }

  await saveReplHistory(replHistory());
  rl.close();
  console.log(`${magenta('🎩 See you!')}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const first = args[0];

  if (!first) {
    // No arguments: interactive mode when attached to a terminal, help otherwise.
    if (process.stdin.isTTY) return cmdInteractive();
    console.log(HELP);
    return;
  }
  if (first === '--help' || first === '-h') {
    console.log(HELP);
    return;
  }
  if (first === '--version' || first === '-v') {
    console.log(VERSION);
    return;
  }
  if (first === 'doctor') return cmdDoctor();
  if (first === 'workers') return cmdWorkers();
  if (first === 'history') return cmdHistory();
  if (first === 'brain') return cmdBrain(args[1]);

  // Everything else is treated as the task prompt.
  const prompt = args.join(' ').trim();
  if (!prompt) fail('empty task. Usage: jack "<task>"');
  return cmdRun(prompt);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
