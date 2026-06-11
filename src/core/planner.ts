/**
 * Planner: decompose a task into subtasks. Uses the brain when available,
 * with a deterministic single-subtask fallback so Jack still works without
 * any brain (e.g. local-only setups with a model that can't do strict JSON).
 */
import { z } from 'zod';
import type { Brain } from '../brain/brain.js';
import { planningPrompt } from '../brain/prompts.js';
import type { Capability } from '../workers/worker.js';
import type { Plan, Task } from './types.js';

const planResponseSchema = z.object({
  subtasks: z
    .array(
      z.object({
        id: z.string(),
        prompt: z.string(),
        capability: z.enum(['code-edit', 'code-gen', 'reason', 'summarize', 'chat', 'web']),
        dependsOn: z.array(z.string()).optional(),
      }),
    )
    .min(1),
  rationale: z.string().optional(),
});

/** Keyword heuristic used when no brain is available (or as a cheap signal). */
export function classifyCapability(prompt: string): Capability {
  const p = prompt.toLowerCase();
  if (
    /(fix|refactor|edit|modify|update|bug|implement|in (this|the) (repo|codebase|project|file))/.test(
      p,
    )
  ) {
    return 'code-edit';
  }
  if (
    /(write|generate|create).*(function|class|script|code|test|component)/.test(p) ||
    /\bcode\b/.test(p)
  ) {
    return 'code-gen';
  }
  if (/(summari[sz]e|résume|translate|traduis|reword|reformulate|tl;dr)/.test(p)) {
    return 'summarize';
  }
  if (/(architecture|plan|design|compare|analy[sz]e|decide|trade-?off|strategy)/.test(p)) {
    return 'reason';
  }
  if (/(latest|news|today|current|search the web|browse)/.test(p)) {
    return 'web';
  }
  return 'chat';
}

export function singleSubtaskPlan(task: Task, rationale?: string): Plan {
  return {
    taskId: task.id,
    subtasks: [
      {
        id: 's1',
        prompt: task.prompt,
        capability: classifyCapability(task.prompt),
      },
    ],
    rationale: rationale ?? 'fallback: single subtask (no brain decomposition)',
  };
}

/** Signals that a task genuinely needs multi-step decomposition by the brain. */
const MULTISTEP = /(\bthen\b|after that|puis\b|ensuite|étape|step\s*\d|d'abord|firstly|;|\n)/i;

/**
 * Cheap heuristic: is this input obviously a single, simple request that does
 * NOT need a brain round-trip to decompose? Skipping planning for greetings
 * and one-liners removes a whole CLI cold-start from the common path.
 */
export function looksSimple(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) return true;
  if (trimmed.includes('\n')) return false; // multi-line → likely structured/multi-step
  if (MULTISTEP.test(trimmed)) return false;
  if (/^\s*[-*]|\d+[.)]/.test(trimmed)) return false; // list markers
  return trimmed.split(/\s+/).length <= 30;
}

export async function planTask(task: Task, brain?: Brain): Promise<Plan> {
  if (!brain) return singleSubtaskPlan(task);
  // Fast path: skip the brain (a full CLI call) for clearly-simple input.
  if (looksSimple(task.prompt)) {
    return singleSubtaskPlan(task, 'fast path: simple request, no decomposition needed');
  }
  try {
    const response = planResponseSchema.parse(
      await brain.askJson<unknown>(planningPrompt(task.prompt, task.context)),
    );
    return {
      taskId: task.id,
      subtasks: response.subtasks.map((s) => ({
        id: s.id,
        prompt: s.prompt,
        capability: s.capability,
        dependsOn: s.dependsOn?.length ? s.dependsOn : undefined,
      })),
      rationale: response.rationale,
    };
  } catch {
    // Brain unreachable or returned junk — degrade gracefully.
    return singleSubtaskPlan(task);
  }
}
