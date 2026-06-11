/**
 * Router: pick a worker for a subtask.
 *
 * Rule fast-path first (free and deterministic); the brain is only consulted
 * for genuinely ambiguous cases — several candidates across different cost
 * tiers on judgment-heavy capabilities. A brain failure always degrades to
 * the rule decision, never blocks the run.
 */
import { z } from 'zod';
import type { Brain } from '../brain/brain.js';
import { routingPrompt } from '../brain/prompts.js';
import type { WorkerRegistry } from '../workers/registry.js';
import type { CostTier } from '../workers/worker.js';
import type { RouterDecision, Subtask } from './types.js';

const routeResponseSchema = z.object({
  workerId: z.string(),
  reason: z.string().optional(),
});

/** Capabilities where worker choice is a judgment call worth a brain query. */
const AMBIGUOUS_CAPABILITIES = new Set(['reason', 'code-gen']);

export interface RouterOptions {
  preferTier: CostTier;
  brain?: Brain;
  /**
   * Workers known to have failed earlier in this run (e.g. bad subscription /
   * quota). They stay eligible as last-resort fallbacks but are ordered last,
   * so Jack stops wasting the first attempt on a worker that just failed.
   */
  degraded?: Set<string>;
}

export async function routeSubtask(
  subtask: Subtask,
  registry: WorkerRegistry,
  options: RouterOptions,
): Promise<RouterDecision> {
  const preferred = subtask.preferredTier ?? options.preferTier;
  const ranked = registry.candidatesFor(subtask.capability, preferred);
  // Push known-bad workers to the back without dropping them entirely.
  const degraded = options.degraded ?? new Set<string>();
  const candidates = degraded.size
    ? [...ranked].sort((a, b) => Number(degraded.has(a.id)) - Number(degraded.has(b.id)))
    : ranked;
  if (candidates.length === 0) {
    throw new Error(
      `no worker available for capability "${subtask.capability}" (subtask ${subtask.id}). Run \`jack doctor\`.`,
    );
  }

  const first = candidates[0];
  if (!first) throw new Error('unreachable: empty candidates');
  const ruleDecision: RouterDecision = {
    workerId: first.id,
    reason: `cheapest healthy candidate for "${subtask.capability}" (tier ${first.costTier})`,
    source: 'rule',
    fallbacks: candidates.slice(1).map((w) => w.id),
  };

  const tiers = new Set(candidates.map((w) => w.costTier));
  const ambiguous =
    candidates.length > 1 && tiers.size > 1 && AMBIGUOUS_CAPABILITIES.has(subtask.capability);
  if (!ambiguous || !options.brain) return ruleDecision;

  try {
    const response = routeResponseSchema.parse(
      await options.brain.askJson<unknown>(
        routingPrompt(
          subtask.prompt,
          subtask.capability,
          candidates.map((w) => ({ id: w.id, name: w.name, costTier: w.costTier })),
        ),
      ),
    );
    const chosen = candidates.find((w) => w.id === response.workerId);
    if (!chosen) return ruleDecision; // brain hallucinated an id
    return {
      workerId: chosen.id,
      reason: response.reason ?? 'brain choice',
      source: 'brain',
      fallbacks: candidates.filter((w) => w.id !== chosen.id).map((w) => w.id),
    };
  } catch {
    return ruleDecision;
  }
}
