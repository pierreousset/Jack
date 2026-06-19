/**
 * Auto-critique: after a run that failed or had to escalate, Jack asks his
 * brain what he should do differently next time and turns the answer into one
 * stored Learning. This is the feedback half of the self-improvement loop;
 * LearningStore.guidanceBlock feeds it back into later runs.
 */
import { z } from 'zod';
import type { Brain } from '../brain/brain.js';
import { reflectionPrompt } from '../brain/prompts.js';
import type { Learning } from './learnings.js';
import type { RunRecord } from './types.js';

const reflectionSchema = z.object({ insight: z.string() });

/** Did this run go badly enough to be worth learning from? */
export function shouldReflect(record: RunRecord): boolean {
  if (record.status === 'failed') return true;
  return record.outcomes.some((o) => o.escalated);
}

/** Short, human-readable summary of what went wrong, for the reflection prompt. */
function whatHappened(record: RunRecord): string {
  return record.outcomes
    .map((o) => {
      if (!o.result.ok)
        return `${o.subtaskId}: every worker failed (last error: ${o.result.error ?? 'unknown'}).`;
      if (o.escalated)
        return `${o.subtaskId}: the cheaper worker's answer was below the quality bar, so Jack escalated to ${o.workerId}.`;
      return `${o.subtaskId}: handled by ${o.workerId}.`;
    })
    .join('\n');
}

/**
 * Reflect on a run and return a Learning, or undefined if nothing useful came
 * back (no brain, run was fine, or the brain found no lesson). Never throws —
 * a failed reflection must not break the run that already completed.
 */
export async function reflectOnRun(
  record: RunRecord,
  brain?: Brain,
): Promise<Learning | undefined> {
  if (!brain || !shouldReflect(record)) return undefined;
  try {
    const parsed = reflectionSchema.parse(
      await brain.askJson<unknown>(
        reflectionPrompt(record.task.prompt, whatHappened(record), record.task.context),
      ),
    );
    const insight = parsed.insight.trim();
    if (!insight) return undefined;
    return {
      at: record.finishedAt ?? record.startedAt,
      task: record.task.prompt.slice(0, 200),
      capability: record.plan.subtasks[0]?.capability,
      insight,
      score: record.outcomes.find((o) => o.score !== undefined)?.score,
    };
  } catch {
    return undefined;
  }
}
