/**
 * The run loop: plan → dispatch (in dependency waves, with fallback chains)
 * → collect → synthesize → persist.
 */
import type { Brain } from '../brain/brain.js';
import { synthesisPrompt } from '../brain/prompts.js';
import type { WorkerRegistry } from '../workers/registry.js';
import type { CostTier, Worker, WorkerResult } from '../workers/worker.js';
import { planTask } from './planner.js';
import { routeSubtask } from './router.js';
import type { RunStore } from './run-store.js';
import type { Plan, RouterDecision, RunRecord, Subtask, SubtaskOutcome, Task } from './types.js';

export interface OrchestratorEvents {
  onPlan?: (plan: Plan) => void;
  onDispatch?: (subtask: Subtask, decision: RouterDecision, attempt: number) => void;
  onSubtaskDone?: (outcome: SubtaskOutcome) => void;
  onChunk?: (subtaskId: string, text: string) => void;
}

export interface OrchestratorOptions {
  registry: WorkerRegistry;
  store: RunStore;
  brain?: Brain;
  preferTier: CostTier;
  maxConcurrency: number;
  maxAttemptsPerSubtask: number;
  events?: OrchestratorEvents;
}

/** Group subtasks into topological waves; subtasks in a wave run in parallel. */
export function topologicalWaves(subtasks: Subtask[]): Subtask[][] {
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  for (const s of subtasks) {
    for (const dep of s.dependsOn ?? []) {
      if (!byId.has(dep)) throw new Error(`subtask ${s.id} depends on unknown subtask ${dep}`);
    }
  }
  const waves: Subtask[][] = [];
  const placed = new Set<string>();
  let remaining = [...subtasks];
  while (remaining.length > 0) {
    const wave = remaining.filter((s) => (s.dependsOn ?? []).every((dep) => placed.has(dep)));
    if (wave.length === 0) {
      throw new Error(`dependency cycle among subtasks: ${remaining.map((s) => s.id).join(', ')}`);
    }
    for (const s of wave) placed.add(s.id);
    remaining = remaining.filter((s) => !placed.has(s.id));
    waves.push(wave);
  }
  return waves;
}

/** Minimal concurrency limiter (avoids a dependency). */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item === undefined) break;
      results[index] = await fn(item);
    }
  });
  await Promise.all(lanes);
  return results;
}

function buildSubtaskPrompt(subtask: Subtask, outputs: Map<string, string>): string {
  const deps = subtask.dependsOn ?? [];
  if (deps.length === 0) return subtask.prompt;
  const context = deps
    .map((dep) => `--- output of subtask ${dep} ---\n${outputs.get(dep) ?? '(missing)'}`)
    .join('\n\n');
  return `${subtask.prompt}\n\nContext from previous subtasks:\n${context}`;
}

async function executeSubtask(
  subtask: Subtask,
  prompt: string,
  cwd: string,
  opts: OrchestratorOptions,
): Promise<SubtaskOutcome> {
  const decision = await routeSubtask(subtask, opts.registry, {
    preferTier: opts.preferTier,
    brain: opts.brain,
  });

  const chain = [decision.workerId, ...decision.fallbacks]
    .map((id) => opts.registry.get(id))
    .filter((w): w is Worker => !!w)
    .slice(0, opts.maxAttemptsPerSubtask);

  let attempts = 0;
  let lastResult: WorkerResult = { ok: false, text: '', error: 'no worker attempted' };
  let lastWorkerId = decision.workerId;

  for (const worker of chain) {
    attempts += 1;
    lastWorkerId = worker.id;
    opts.events?.onDispatch?.(subtask, decision, attempts);
    await opts.store.appendSubtaskLog(
      subtask.id,
      `\n=== attempt ${attempts} | worker ${worker.id} ===\n`,
    );
    lastResult = await worker.invoke({
      prompt,
      cwd,
      onChunk: (text) => {
        opts.events?.onChunk?.(subtask.id, text);
        void opts.store.appendSubtaskLog(subtask.id, text);
      },
    });
    if (lastResult.ok && lastResult.text.length > 0) break;
  }

  const outcome: SubtaskOutcome = {
    subtaskId: subtask.id,
    workerId: lastWorkerId,
    decision,
    result: lastResult,
    attempts,
  };
  await opts.store.saveOutcome(outcome);
  opts.events?.onSubtaskDone?.(outcome);
  return outcome;
}

async function synthesize(task: Task, outcomes: SubtaskOutcome[], brain?: Brain): Promise<string> {
  const successful = outcomes.filter((o) => o.result.ok);
  if (successful.length === 1 && outcomes.length === 1) {
    const only = successful[0];
    if (only) return only.result.text;
  }
  const outputs = successful.map((o) => ({ subtaskId: o.subtaskId, text: o.result.text }));
  if (brain && outputs.length > 1) {
    try {
      return await brain.askText(synthesisPrompt(task.prompt, outputs));
    } catch {
      // fall through to concatenation
    }
  }
  return outputs.map((o) => `## ${o.subtaskId}\n\n${o.text}`).join('\n\n');
}

export async function orchestrate(task: Task, opts: OrchestratorOptions): Promise<RunRecord> {
  const startedAt = new Date().toISOString();
  await opts.store.saveTask(task);

  const plan = await planTask(task, opts.brain);
  await opts.store.savePlan(plan);
  opts.events?.onPlan?.(plan);

  const outputs = new Map<string, string>();
  const outcomes: SubtaskOutcome[] = [];

  for (const wave of topologicalWaves(plan.subtasks)) {
    const waveOutcomes = await mapLimit(wave, opts.maxConcurrency, (subtask) => {
      const prompt = buildSubtaskPrompt(subtask, outputs);
      return executeSubtask(subtask, prompt, task.cwd, opts);
    });
    for (const outcome of waveOutcomes) {
      outcomes.push(outcome);
      if (outcome.result.ok) outputs.set(outcome.subtaskId, outcome.result.text);
    }
  }

  const failed = outcomes.filter((o) => !o.result.ok);
  const report = await synthesize(task, outcomes, opts.brain);
  const record: RunRecord = {
    id: opts.store.runId,
    task,
    plan,
    outcomes,
    report,
    status: failed.length === outcomes.length && outcomes.length > 0 ? 'failed' : 'done',
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  await opts.store.saveRecord(record);
  return record;
}
