import type { Capability, CostTier, WorkerResult } from '../workers/worker.js';

export interface Task {
  id: string;
  prompt: string;
  cwd: string;
  /** Recent conversation context, threaded into planning and worker prompts. */
  context?: string;
}

export interface Subtask {
  id: string;
  prompt: string;
  capability: Capability;
  /** Ids of subtasks whose output this one needs. */
  dependsOn?: string[];
  preferredTier?: CostTier;
}

export interface Plan {
  taskId: string;
  subtasks: Subtask[];
  /** Why the planner decomposed (or didn't) the task this way. */
  rationale?: string;
}

export interface RouterDecision {
  workerId: string;
  reason: string;
  source: 'rule' | 'brain';
  /** Ordered fallback worker ids, tried after `workerId` fails. */
  fallbacks: string[];
}

export interface SubtaskOutcome {
  subtaskId: string;
  workerId: string;
  decision: RouterDecision;
  result: WorkerResult;
  attempts: number;
  /** Quality-gate score (0–1) of the accepted output, when the gate ran. */
  score?: number;
}

export type RunStatus = 'running' | 'done' | 'failed';

export interface RunRecord {
  id: string;
  task: Task;
  plan: Plan;
  outcomes: SubtaskOutcome[];
  report: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
}
