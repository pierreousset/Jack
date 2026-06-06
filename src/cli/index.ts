#!/usr/bin/env node
/**
 * Jack CLI — v0.1 commands:
 *   jack "<task>"      run a task through the orchestrator
 *   jack doctor        show detected workers and their health
 *   jack workers       list registered workers
 *   jack --help / --version
 */
import { resolveBrain } from '../brain/brain.js';
import { buildRegistry, loadConfig } from '../config/load.js';
import { orchestrate } from '../core/orchestrator.js';
import { RunStore, newRunId } from '../core/run-store.js';

const VERSION = '0.1.0';

const HELP = `jack — route AI tasks to the subscriptions you already pay for

Usage:
  jack "<task>"        Run a task (plan → route → execute → report)
  jack doctor          Detect installed CLIs and local model servers
  jack workers         List registered workers
  jack --version       Print version
  jack --help          Show this help

Config: ~/.jack/config.json, overridden by ./jack.config.json
Runs are persisted under ./jack-runs/<id>/ (task, plan, logs, report).
`;

function fail(message: string): never {
  console.error(`jack: ${message}`);
  process.exit(1);
}

async function cmdDoctor(): Promise<void> {
  const config = await loadConfig();
  const { registry, detection } = await buildRegistry(config);

  console.log('Subscription CLIs:');
  for (const cli of detection.clis) {
    const status = cli.found ? `OK  (${cli.version ?? 'version unknown'})` : 'not found';
    console.log(`  ${cli.command.padEnd(8)} ${status}`);
  }

  console.log('\nLocal model servers:');
  for (const server of detection.localServers) {
    const status = server.up
      ? `UP  (${server.models.length} model${server.models.length === 1 ? '' : 's'}${server.models[0] ? `, e.g. ${server.models[0]}` : ''})`
      : 'down';
    console.log(`  ${server.label.padEnd(10)} ${server.baseUrl.padEnd(28)} ${status}`);
  }

  console.log('\nRegistered workers (health):');
  const health = await registry.healthReport();
  for (const worker of registry.all()) {
    const ok = health.get(worker.id) ? 'healthy' : 'UNHEALTHY';
    console.log(`  ${worker.id.padEnd(24)} tier=${worker.costTier.padEnd(12)} ${ok}`);
  }
  if (registry.all().length === 0) {
    console.log('  (none — install claude/codex/gemini or start Ollama/LM Studio)');
  }

  const brain = resolveBrain(registry, config.brain);
  console.log(`\nBrain: ${brain ? brain.workerId : 'none (single-subtask fallback mode)'}`);
}

async function cmdWorkers(): Promise<void> {
  const config = await loadConfig();
  const { registry } = await buildRegistry(config);
  for (const worker of registry.all()) {
    console.log(
      `${worker.id.padEnd(24)} tier=${worker.costTier.padEnd(12)} caps=${worker.capabilities.join(',')}`,
    );
  }
  if (registry.all().length === 0) console.log('(no workers — run `jack doctor`)');
}

async function cmdRun(prompt: string): Promise<void> {
  const config = await loadConfig();
  const { registry } = await buildRegistry(config);
  if (registry.all().length === 0) {
    fail('no workers available. Run `jack doctor` to see what is missing.');
  }
  const brain = resolveBrain(registry, config.brain);
  const store = await RunStore.create(config.runsDir, newRunId());
  const task = { id: store.runId, prompt, cwd: process.cwd() };

  console.error(`run ${store.runId} — logs in ${store.dir}`);
  const record = await orchestrate(task, {
    registry,
    store,
    brain,
    preferTier: config.routing.preferTier,
    maxConcurrency: config.routing.maxConcurrency,
    maxAttemptsPerSubtask: config.routing.maxAttemptsPerSubtask,
    events: {
      onPlan: (plan) => {
        console.error(
          `plan: ${plan.subtasks.length} subtask(s) — ${plan.subtasks
            .map((s) => `${s.id}[${s.capability}]`)
            .join(', ')}`,
        );
      },
      onDispatch: (subtask, decision, attempt) => {
        const suffix = attempt > 1 ? ` (attempt ${attempt}, falling back)` : '';
        console.error(`  ${subtask.id} → ${decision.workerId} [${decision.source}]${suffix}`);
      },
      onSubtaskDone: (outcome) => {
        const status = outcome.result.ok ? 'ok' : `FAILED: ${outcome.result.error ?? '?'}`;
        console.error(`  ${outcome.subtaskId} ← ${outcome.workerId} ${status}`);
      },
    },
  });

  console.log(`\n${record.report}`);
  if (record.status === 'failed') {
    fail(`run failed — see ${store.dir}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const first = args[0];

  if (!first || first === '--help' || first === '-h') {
    console.log(HELP);
    return;
  }
  if (first === '--version' || first === '-v') {
    console.log(VERSION);
    return;
  }
  if (first === 'doctor') return cmdDoctor();
  if (first === 'workers') return cmdWorkers();

  // Everything else is treated as the task prompt.
  const prompt = args.join(' ').trim();
  if (!prompt) fail('empty task. Usage: jack "<task>"');
  return cmdRun(prompt);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
