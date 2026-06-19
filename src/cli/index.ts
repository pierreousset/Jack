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
import { saveBrainChoice, savedBrainChoice, setUserConfigPath } from '../config/persist.js';
import { BacklogStore } from '../core/backlog.js';
import { LearningStore } from '../core/learnings.js';
import { orchestrate } from '../core/orchestrator.js';
import { reflectOnRun } from '../core/reflect.js';
import { RunStore, newRunId } from '../core/run-store.js';
import { SessionHistory } from '../core/session.js';
import { TUNABLE, TuningStore, proposeTuning, runScore } from '../core/tuning.js';
import { ProposalStore, runWatch } from '../core/watch.js';
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
  jack cook ["<topic>"]  Autonomously work through the backlog (or a topic)
  jack live [cycles]   Continuous self-improving loop over the backlog
  jack add "<topic>"   Add a topic to the backlog for cook
  jack backlog         Show the backlog
  jack watch           Research AI developments Jack could adopt → proposals
  jack proposals       Show improvement proposals (add "clear" to reset)
  jack tune            Trial a config tweak; auto rolls back if quality drops
  jack doctor          Detect installed CLIs and local model servers
  jack workers         List registered workers
  jack brain [id]      Show or set which worker Jack uses as his brain
  jack history         Show this project's conversation history
  jack learnings       Show what Jack has learned (add "clear" to reset)
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
    cook        autonomously work through the backlog (cook "<topic>" for one)
    live        continuous self-improving loop over the backlog
    add "<t>"   add a topic to the backlog
    backlog     show the backlog
    watch       research AI developments Jack could adopt → proposals
    proposals   show improvement proposals (add "clear" to reset)
    tune        trial a config tweak (tune rollback to abort)
    history     show the conversation so far
    learnings   show what Jack has learned (add "clear" to reset)
    clear       forget the conversation history
    help        this help
    exit        leave (also: quit, Ctrl+C, Ctrl+D)
`;

const REPL_COMMANDS = [
  'workers',
  'doctor',
  'brain',
  'cook',
  'live',
  'add',
  'backlog',
  'watch',
  'proposals',
  'tune',
  'history',
  'learnings',
  'clear',
  'help',
  'exit',
  'quit',
];

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
  learnings: LearningStore;
  tuning: TuningStore;
  brainId: string;
  /** Workers that hit auth/quota errors this session — deprioritized on later runs. */
  degraded: Set<string>;
}

/** Read/write a dotted path (e.g. "routing.qualityBar") on a plain object. */
function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((node, k) => {
    return node && typeof node === 'object' ? (node as Record<string, unknown>)[k] : undefined;
  }, obj);
}
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let node: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i] as string;
    if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
    node = node[k] as Record<string, unknown>;
  }
  node[keys[keys.length - 1] as string] = value;
}

async function loadSession(): Promise<JackSession> {
  const config = await loadConfig();
  const { registry } = await buildRegistry(config);
  if (registry.all().length === 0) {
    fail('no workers available. Run `jack doctor` to see what is missing.');
  }
  const history = await SessionHistory.load(config.runsDir);
  const learnings = await LearningStore.load(config.runsDir);
  const tuning = await TuningStore.load(config.runsDir);
  const brain = resolveBrain(registry, config.brain, { model: config.brainModel });
  return {
    config,
    registry,
    history,
    learnings,
    tuning,
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
  const selfImprove = session.config.selfImprove;
  const task = {
    id: store.runId,
    prompt,
    cwd: process.cwd(),
    context: session.history.contextBlock(),
    guidance: selfImprove.enabled
      ? session.learnings.guidanceBlock(undefined, selfImprove.maxGuidance)
      : undefined,
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
    qualityBar: session.config.routing.qualityBar,
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
      onJudge: (subtaskId, score, accepted) => {
        if (accepted) return;
        if (streamStarted) {
          process.stdout.write(dim(`\n\n  ↑ quality ${score.toFixed(2)} — escalating…\n\n`));
        } else {
          progress.spin(
            subtaskId,
            `${subtaskId} ${dim(`quality ${score.toFixed(2)} — escalating to a stronger worker…`)}`,
          );
        }
      },
      onSubtaskDone: (outcome) => {
        if (streamStarted) return; // streamed live already — no status churn
        const q = outcome.score !== undefined ? dim(` q${outcome.score.toFixed(2)}`) : '';
        const line = `${outcome.subtaskId} ← ${outcome.workerId}${q}${dim(seconds(outcome.result.usage?.ms))}`;
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

  // Auto-critique: if the run failed or had to escalate, learn one lesson from
  // it and keep it for next time. Best-effort — never blocks the answer.
  if (selfImprove.enabled) {
    const learning = await reflectOnRun(record, brain);
    if (learning) {
      await session.learnings.add(learning);
      console.log(magenta(`\n  💡 learned: ${dim(learning.insight)}`));
    }
  }

  // Self-tuning feedback: feed this run's quality score to any active tuning
  // experiment. When enough samples are in, Jack keeps or auto-rolls-back the
  // config change on his own.
  if (session.config.tuning.enabled) {
    const resolution = await session.tuning.recordRunScore(
      runScore(record),
      session.config.tuning.margin,
    );
    if (resolution) {
      const { experiment: e, rollback } = resolution;
      if (rollback) {
        await setUserConfigPath(e.key, e.from);
        setPath(session.config as unknown as Record<string, unknown>, e.key, e.from);
        console.log(
          yellow(`\n  ↩ rolled back ${e.key} ${e.to}→${e.from}`) + dim(` (${e.verdict})`),
        );
      } else {
        console.log(green(`\n  ✓ kept ${e.key}=${e.to}`) + dim(` (${e.verdict})`));
      }
    }
  }

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

async function cmdLearnings(clear = false): Promise<void> {
  const config = await loadConfig();
  const store = await LearningStore.load(config.runsDir);
  if (clear) {
    await store.clear();
    console.log(dim('  learnings cleared.'));
    return;
  }
  const entries = store.all();
  if (entries.length === 0) {
    console.log(dim('(Jack has not learned anything yet — lessons appear after a run goes badly)'));
    return;
  }
  console.log(bold(`What Jack has learned (${entries.length}):`));
  for (const e of entries.slice(-20)) {
    const tag = e.capability ? dim(` [${e.capability}]`) : '';
    console.log(`  ${magenta('•')} ${e.insight}${tag}`);
  }
}

const nowIso = (): string => new Date().toISOString();

/**
 * Autonomous mode: work through the backlog unattended. Each topic is a normal
 * run, so it benefits from (and contributes to) the learnings — lessons from an
 * early topic guide later ones in the same cook. Guarded by cook.maxItems and a
 * consecutive-failure cutoff so it never runs away or burns quota on a dead CLI.
 */
async function runCook(session: JackSession, topics: string[]): Promise<void> {
  const backlog = await BacklogStore.load(session.config.runsDir);
  for (const t of topics) if (t.trim()) await backlog.add(t, nowIso());

  const queue = backlog.pending().slice(0, session.config.cook.maxItems);
  if (queue.length === 0) {
    console.log(
      dim('  nothing to cook — add topics with `jack add "<topic>"` or `jack cook "<topic>"`.'),
    );
    return;
  }

  const lessonsBefore = session.learnings.length;
  console.log(magenta(`\n🍳 cooking ${queue.length} topic(s)…`));
  let done = 0;
  let failed = 0;
  let consecutive = 0;

  for (const [i, item] of queue.entries()) {
    console.log(bold(`\n── ${i + 1}/${queue.length} ${dim('·')} ${item.topic}`));
    let ok = false;
    try {
      ok = await executeTask(item.topic, session);
    } catch (err) {
      console.error(red(`  jack: ${err instanceof Error ? err.message : String(err)}`));
    }
    await backlog.mark(item.id, ok ? 'done' : 'failed', nowIso());
    if (ok) {
      done += 1;
      consecutive = 0;
    } else {
      failed += 1;
      consecutive += 1;
      if (consecutive >= session.config.cook.stopAfterFailures) {
        console.log(
          yellow(`\n  ⏹ stopped after ${consecutive} consecutive failures — run \`jack doctor\`.`),
        );
        break;
      }
    }
  }

  const learned = session.learnings.length - lessonsBefore;
  const failedPart = failed > 0 ? red(`${failed} failed`) : '0 failed';
  const learnedPart = learned > 0 ? dim(`, ${learned} new lesson(s)`) : '';
  console.log(magenta(`\n🍳 cook done — ${green(`${done} ok`)}, ${failedPart}${learnedPart}`));

  if (session.config.cook.autoImprove) await selfImprovePass(session);
}

/**
 * One self-improvement pass: research (watch → proposals) and, if no experiment
 * is already running, propose+apply a config tweak (tune). Chained after a cook
 * batch so Jack improves himself while he works. Best-effort — never throws.
 */
async function selfImprovePass(session: JackSession): Promise<void> {
  console.log(magenta('\n🔁 self-improvement pass…'));
  const brain = resolveBrain(session.registry, session.brainId, {
    model: session.config.brainModel,
  });
  if (!brain) return;

  try {
    const webWorker = session.registry.candidatesFor('web', session.config.routing.preferTier)[0];
    const { proposals } = await runWatch({
      brain,
      webWorker,
      setupSummary: describeSetup(session),
      area: session.config.watch.area,
    });
    if (proposals.length > 0) {
      const store = await ProposalStore.load(session.config.runsDir);
      await store.add(proposals);
      console.log(dim(`  🔭 ${proposals.length} new proposal(s) — see \`jack proposals\`.`));
    }
  } catch {
    // research is optional
  }

  if (session.config.tuning.enabled && !session.tuning.active) {
    try {
      await runTune(session);
    } catch {
      // tuning is optional
    }
  }
}

async function cmdCook(topics: string[] = []): Promise<void> {
  const session = await loadSession();
  await runCook(session, topics);
}

/**
 * Continuous mode: repeat cook batches (each with a self-improvement pass) until
 * the backlog is empty or the cycle cap is hit. Bounded by live.maxCycles and
 * cook.maxItems so it can't run away or drain quota. Ctrl+C stops it; add topics
 * from another terminal with `jack add` and they're picked up next cycle.
 */
async function cmdLive(maxCyclesArg?: string): Promise<void> {
  const session = await loadSession();
  const max = Math.max(1, Number(maxCyclesArg) || session.config.live.maxCycles);
  console.log(
    magenta(`\n🔥 live mode — up to ${max} cycle(s) of ${session.config.cook.maxItems} topic(s).`) +
      dim(' Ctrl+C to stop.'),
  );

  for (let cycle = 1; cycle <= max; cycle += 1) {
    const backlog = await BacklogStore.load(session.config.runsDir);
    if (backlog.pending().length === 0) {
      console.log(dim('\n  backlog empty — nothing left to cook. Add topics with `jack add`.'));
      break;
    }
    console.log(bold(`\n═══ cycle ${cycle}/${max} ═══`));
    await runCook(session, []);
  }
  console.log(magenta('\n🔥 live: done.'));
}

async function cmdAdd(topic: string): Promise<void> {
  if (!topic.trim()) fail('usage: jack add "<topic>"');
  const config = await loadConfig();
  const backlog = await BacklogStore.load(config.runsDir);
  await backlog.add(topic, nowIso());
  console.log(
    green('  added to backlog') +
      dim(` (${backlog.pending().length} pending) — run \`jack cook\` to work through them.`),
  );
}

async function cmdBacklog(): Promise<void> {
  const config = await loadConfig();
  const backlog = await BacklogStore.load(config.runsDir);
  const items = backlog.all();
  if (items.length === 0) {
    console.log(dim('(backlog empty — add topics with `jack add "<topic>"`)'));
    return;
  }
  for (const it of items) {
    const mark = it.status === 'done' ? green('✓') : it.status === 'failed' ? red('✗') : dim('•');
    console.log(`  ${mark} ${it.topic}`);
  }
}

/** Compact description of Jack's setup, so watch proposals are relevant to him. */
function describeSetup(session: JackSession): string {
  const workers = session.registry
    .all()
    .map((w) => `${w.id} (${w.costTier})`)
    .join(', ');
  const r = session.config.routing;
  const lessons = session.learnings
    .all()
    .slice(-3)
    .map((l) => `- ${l.insight}`)
    .join('\n');
  return [
    `Workers: ${workers}`,
    `Brain: ${session.brainId} (model ${session.config.brainModel}).`,
    `Routing: preferTier=${r.preferTier}, qualityBar=${r.qualityBar}.`,
    'Capabilities: code-edit, code-gen, reason, summarize, chat, web.',
    lessons ? `Recent self-learnings:\n${lessons}` : 'No self-learnings yet.',
  ].join('\n');
}

async function cmdWatch(): Promise<void> {
  const session = await loadSession();
  const brain = resolveBrain(session.registry, session.brainId, {
    model: session.config.brainModel,
  });
  if (!brain) fail('watch needs a brain — set one with `jack brain`.');
  const webWorker = session.registry.candidatesFor('web', session.config.routing.preferTier)[0];

  console.log(
    magenta('\n🔭 watching') +
      dim(` — researching via ${webWorker ? webWorker.id : 'brain knowledge (no web worker)'}…`),
  );

  const { proposals } = await runWatch({
    brain,
    webWorker,
    setupSummary: describeSetup(session),
    area: session.config.watch.area,
  });

  if (proposals.length === 0) {
    console.log(dim('  no proposals this cycle.'));
    return;
  }
  const store = await ProposalStore.load(session.config.runsDir);
  await store.add(proposals);
  console.log(bold(`\n🔭 ${proposals.length} proposal(s):`));
  for (const p of proposals) {
    console.log(`  ${magenta('▸')} ${bold(p.title)} ${dim(`[${p.kind}]`)}`);
    console.log(`    ${dim(p.rationale)}`);
    console.log(`    → ${p.action}`);
  }
  console.log(dim('\n  Review with `jack proposals`. Auto-apply (prompt/config) lands next.'));
}

async function cmdProposals(clear = false): Promise<void> {
  const config = await loadConfig();
  const store = await ProposalStore.load(config.runsDir);
  if (clear) {
    await store.clear();
    console.log(dim('  proposals cleared.'));
    return;
  }
  const items = store.all();
  if (items.length === 0) {
    console.log(dim('(no proposals yet — run `jack watch`)'));
    return;
  }
  console.log(bold(`Improvement proposals (${items.length}):`));
  for (const p of items.slice(-20)) {
    const flag = p.applied ? green(' (applied)') : '';
    console.log(`  ${magenta('▸')} ${bold(p.title)} ${dim(`[${p.kind}]`)}${flag}`);
    console.log(`    → ${p.action}`);
  }
}

/** Current values of the tunable knobs, read from the live config. */
function tunableValues(session: JackSession): Record<string, number> {
  const cfg = session.config as unknown as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of Object.keys(TUNABLE)) out[key] = Number(getPath(cfg, key));
  return out;
}

async function runTune(session: JackSession, action?: string): Promise<void> {
  const active = session.tuning.active;
  const base = session.tuning.baseline();

  if (active) {
    if (action === 'rollback' || action === 'abort') {
      await session.tuning.abortActive();
      await setUserConfigPath(active.key, active.from);
      setPath(session.config as unknown as Record<string, unknown>, active.key, active.from);
      console.log(yellow(`  ↩ aborted — restored ${active.key} to ${active.from}.`));
      return;
    }
    console.log(
      `${bold('Active tuning experiment:')} ${active.key} ${active.from}→${active.to}\n${dim(
        `  ${active.trialScores.length}/${active.minSamples} scored runs · baseline ${active.baselineAvg.toFixed(2)} (${active.baselineN}) · ${active.rationale}`,
      )}`,
    );
    console.log(dim('  Jack keeps or rolls this back automatically once enough runs are scored.'));
    return;
  }

  if (action === 'rollback' || action === 'abort') {
    console.log(dim('  no active experiment to roll back.'));
    return;
  }

  const brain = resolveBrain(session.registry, session.brainId, {
    model: session.config.brainModel,
  });
  if (!brain) fail('tune needs a brain — set one with `jack brain`.');

  const stats = `Average quality ${base.avg.toFixed(2)} over ${base.n} scored run(s).`;
  const suggestion = await proposeTuning(brain, tunableValues(session), stats);
  if (!suggestion) {
    console.log(dim('  nothing to tune right now — Jack is happy with his current settings.'));
    return;
  }

  const cfg = session.config as unknown as Record<string, unknown>;
  const from = Number(getPath(cfg, suggestion.key));
  await setUserConfigPath(suggestion.key, suggestion.value);
  setPath(cfg, suggestion.key, suggestion.value); // keep the live session in sync
  await session.tuning.startExperiment({
    id: newRunId(),
    at: new Date().toISOString(),
    key: suggestion.key,
    from,
    to: suggestion.value,
    rationale: suggestion.rationale,
    baselineAvg: base.avg,
    baselineN: base.n,
    trialScores: [],
    minSamples: session.config.tuning.minSamples,
    status: 'active',
  });
  console.log(
    magenta(`\n🔧 trialing ${bold(`${suggestion.key} ${from}→${suggestion.value}`)}`) +
      dim(`\n  ${suggestion.rationale}`),
  );
  console.log(
    dim(
      `  Jack will keep it if quality holds over ${session.config.tuning.minSamples} scored runs, else roll back automatically.`,
    ),
  );
}

async function cmdTune(action?: string): Promise<void> {
  const session = await loadSession();
  await runTune(session, action);
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
  if (session.learnings.length > 0) {
    console.log(`  ${dim(`I'm carrying ${session.learnings.length} lesson(s) from past runs.`)}`);
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
    if (input === 'learnings' || input === 'learnings clear') {
      const clear = input.endsWith('clear');
      await cmdLearnings(clear);
      if (clear) session.learnings = await LearningStore.load(session.config.runsDir);
      continue;
    }
    if (input === 'backlog') {
      await cmdBacklog();
      continue;
    }
    if (input === 'cook' || input.startsWith('cook ')) {
      const topic = input.slice('cook'.length).trim();
      await runCook(session, topic ? [topic] : []);
      console.log(`\n${magenta('🎩')} ${dim('Anything else?')}\n`);
      continue;
    }
    if (input === 'live' || input.startsWith('live ')) {
      const max = Math.max(
        1,
        Number(input.slice('live'.length).trim()) || session.config.live.maxCycles,
      );
      for (let cycle = 1; cycle <= max; cycle += 1) {
        const backlog = await BacklogStore.load(session.config.runsDir);
        if (backlog.pending().length === 0) {
          console.log(dim('  backlog empty — add topics with `add "<topic>"`.'));
          break;
        }
        console.log(bold(`\n═══ cycle ${cycle}/${max} ═══`));
        await runCook(session, []);
      }
      console.log(`\n${magenta('🎩')} ${dim('Anything else?')}\n`);
      continue;
    }
    if (input.startsWith('add ')) {
      await cmdAdd(input.slice('add'.length).trim());
      continue;
    }
    if (input === 'watch') {
      await cmdWatch();
      console.log(`\n${magenta('🎩')} ${dim('Anything else?')}\n`);
      continue;
    }
    if (input === 'proposals' || input === 'proposals clear') {
      await cmdProposals(input.endsWith('clear'));
      continue;
    }
    if (input === 'tune' || input === 'tune rollback' || input === 'tune abort') {
      await runTune(session, input.split(/\s+/)[1]);
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
  if (first === 'learnings') return cmdLearnings(args[1] === 'clear');
  if (first === 'cook') return cmdCook(args.slice(1));
  if (first === 'live') return cmdLive(args[1]);
  if (first === 'add') return cmdAdd(args.slice(1).join(' '));
  if (first === 'backlog') return cmdBacklog();
  if (first === 'watch') return cmdWatch();
  if (first === 'proposals') return cmdProposals(args[1] === 'clear');
  if (first === 'tune') return cmdTune(args[1]);
  if (first === 'brain') return cmdBrain(args[1]);

  // Everything else is treated as the task prompt.
  const prompt = args.join(' ').trim();
  if (!prompt) fail('empty task. Usage: jack "<task>"');
  return cmdRun(prompt);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
