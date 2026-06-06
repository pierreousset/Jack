/**
 * Public API of jack-orchestrator — for embedding Jack in your own tools
 * or writing custom workers.
 */
export { Brain, resolveBrain } from './brain/brain.js';
export { buildRegistry, loadConfig } from './config/load.js';
export { detectEnvironment } from './config/detect.js';
export type { Detection } from './config/detect.js';
export { jackConfigSchema } from './config/schema.js';
export type { JackConfig } from './config/schema.js';
export { orchestrate, topologicalWaves } from './core/orchestrator.js';
export type { OrchestratorEvents, OrchestratorOptions } from './core/orchestrator.js';
export { classifyCapability, planTask, singleSubtaskPlan } from './core/planner.js';
export { routeSubtask } from './core/router.js';
export { RunStore, newRunId } from './core/run-store.js';
export type {
  Plan,
  RouterDecision,
  RunRecord,
  Subtask,
  SubtaskOutcome,
  Task,
} from './core/types.js';
export { ClaudeCodeWorker } from './workers/claude-code.js';
export { CodexWorker } from './workers/codex.js';
export { GeminiWorker } from './workers/gemini.js';
export { LocalOpenAiWorker } from './workers/local-openai.js';
export { MockWorker } from './workers/mock.js';
export { WorkerRegistry } from './workers/registry.js';
export { runCli, tolerantJsonParse } from './workers/subprocess.js';
export type {
  Capability,
  CostTier,
  Worker,
  WorkerInvocation,
  WorkerResult,
} from './workers/worker.js';
