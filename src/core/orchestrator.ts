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
  /**
   * Shared across runs in a session: workers that failed with an auth/quota
   * style error get added here and deprioritized on later subtasks/runs.
   */
  degraded?: Set<string>;
}

/** Heuristic: does this error look like a broken subscription, not a real failure? */
export function isAuthOrQuotaError(error?: string): boolean {
  if (!error) return false;
  return /\b(401|403|429|auth|authenticat|unauthor|login|sign ?in|credential|api key|token|quota|rate.?limit|billing|subscription|payment|forbidden|expired|not logged)/i.test(
    error,
  );
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

function buildSubtaskPrompt(
  subtask: Subtask,
  outputs: Map<string, string>,
  conversationContext?: string,
): string {
  const parts: string[] = [];
  if (conversationContext) {
    parts.push(
      `Background — recent conversation between the user and the orchestrator (reference only; the task below is what matters):\n${conversationContext}\n---`,
    );
  }
  parts.push(subtask.prompt);
  const deps = subtask.dependsOn ?? [];
  if (deps.length > 0) {
    const depContext = deps
      .map((dep) => `--- output of subtask ${dep} ---\n${outputs.get(dep) ?? '(missing)'}`)
      .join('\n\n');
    parts.push(`Context from previous subtasks:\n${depContext}`);
  }
  return parts.join('\n\n');
}

async function executeSubtask(
  subtask: Subtask,
  prompt: string,
  cwd: string,
  opts: OrchestratorOptions,
): Promise<SubtaskOutcome> {
  const degraded = opts.degraded ?? new Set<string>();

  // Routing must never crash the run. If no worker has the capability, we fall
  // through to generalists below instead of throwing and stopping everything.
  let decision: RouterDecision | undefined;
  try {
    decision = await routeSubtask(subtask, opts.registry, {
      preferTier: opts.preferTier,
      brain: opts.brain,
      degraded,
    });
  } catch {
    decision = undefined;
  }

  // Try EVERY capable worker before giving up — a broken subscription on the
  // first choice must not stop Jack from reaching a worker that still works.
  const ordered = decision
    ? [decision.workerId, ...decision.fallbacks]
        .map((id) => opts.registry.get(id))
        .filter((w): w is Worker => !!w)
    : [];

  // Last-resort generalists: if a niche capability (e.g. 'web') has no worker
  // or its only worker is broken, a chat/reason-capable worker can still answer
  // rather than failing the whole run. Appended after the real candidates,
  // de-duplicated, with degraded workers ordered last.
  const inChain = new Set(ordered.map((w) => w.id));
  const generalists = opts.registry
    .all()
    .filter((w) => !inChain.has(w.id) && w.capabilities.some((c) => c === 'chat' || c === 'reason'))
    .sort((a, b) => Number(degraded.has(a.id)) - Number(degraded.has(b.id)));
  const chain = [...ordered, ...generalists];

  const effectiveDecision: RouterDecision = decision ?? {
    workerId: chain[0]?.id ?? '(none)',
    reason: `no "${subtask.capability}" worker — using a generalist`,
    source: 'rule',
    fallbacks: chain.slice(1).map((w) => w.id),
  };

  // Truly nothing to try: report cleanly instead of looping over an empty chain.
  if (chain.length === 0) {
    const outcome: SubtaskOutcome = {
      subtaskId: subtask.id,
      workerId: '(none)',
      decision: effectiveDecision,
      result: {
        ok: false,
        text: '',
        error: `no worker available for capability "${subtask.capability}". Run \`jack doctor\`.`,
      },
      attempts: 0,
    };
    await opts.store.saveOutcome(outcome);
    opts.events?.onSubtaskDone?.(outcome);
    return outcome;
  }

  let attempts = 0;
  let lastResult: WorkerResult = { ok: false, text: '', error: 'no worker attempted' };
  let lastWorkerId = effectiveDecision.workerId;

  for (const worker of chain) {
    attempts += 1;
    lastWorkerId = worker.id;
    opts.events?.onDispatch?.(subtask, effectiveDecision, attempts);
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
    // Remember bad-subscription / quota failures so later subtasks skip ahead.
    if (isAuthOrQuotaError(lastResult.error)) {
      degraded.add(worker.id);
      await opts.store.appendSubtaskLog(
        subtask.id,
        `\n[jack] ${worker.id} looks unauthorized/over quota — falling back.\n`,
      );
    }
  }

  const outcome: SubtaskOutcome = {
    subtaskId: subtask.id,
    workerId: lastWorkerId,
    decision: effectiveDecision,
    result: lastResult,
    attempts,
  };
  await opts.store.saveOutcome(outcome);
  opts.events?.onSubtaskDone?.(outcome);
  return outcome;
}

/** A clear, actionable message when every worker failed (vs. a raw stack). */
function failureReport(outcomes: SubtaskOutcome[]): string {
  const errors = outcomes.map((o) => o.result.error ?? 'unknown error');
  const authBlocked = [
    ...new Set(
      outcomes
        .filter((o) => isAuthOrQuotaError(o.result.error) && o.workerId !== '(none)')
        .map((o) => o.workerId),
    ),
  ];
  const lines = ['⚠️ Jack could not complete this task — every worker failed.', ''];
  if (authBlocked.length > 0) {
    lines.push(
      `It looks like a login/quota problem with: ${authBlocked.join(', ')}.`,
      'Re-authenticate that CLI (e.g. `claude`, `codex`, `gemini login`) or switch Jack’s',
      'brain/worker with the `brain` command, then try again.',
      '',
    );
  }
  lines.push('Details:', ...errors.map((e, i) => `  • ${outcomes[i]?.subtaskId ?? '?'}: ${e}`));
  return lines.join('\n');
}

async function synthesize(task: Task, outcomes: SubtaskOutcome[], brain?: Brain): Promise<string> {
  const successful = outcomes.filter((o) => o.result.ok);
  if (outcomes.length > 0 && successful.length === 0) {
    return failureReport(outcomes);
  }
  if (successful.length === 1 && outcomes.length === 1) {
    const only = successful[0];
    if (only) return only.result.text;
  }
  const outputs = successful.map((o) => ({ subtaskId: o.subtaskId, text: o.result.text }));
  if (brain && outputs.length > 1) {
    try {
      return await brain.askText(synthesisPrompt(task.prompt, outputs, task.context));
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
      const prompt = buildSubtaskPrompt(subtask, outputs, task.context);
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
