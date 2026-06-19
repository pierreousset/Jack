/**
 * Public API of jack-orchestrator — for embedding Jack in your own tools
 * or writing custom workers.
 */
export { Brain, resolveBrain } from './brain/brain.js';
export { buildRegistry, loadConfig } from './config/load.js';
export { patchUserConfig, readUserConfig, setUserConfigPath } from './config/persist.js';
export { detectEnvironment } from './config/detect.js';
export type { Detection } from './config/detect.js';
export { jackConfigSchema } from './config/schema.js';
export type { JackConfig } from './config/schema.js';
export { orchestrate, topologicalWaves } from './core/orchestrator.js';
export type { OrchestratorEvents, OrchestratorOptions } from './core/orchestrator.js';
export { classifyCapability, planTask, singleSubtaskPlan } from './core/planner.js';
export { BacklogStore } from './core/backlog.js';
export type { BacklogItem, BacklogStatus } from './core/backlog.js';
export { LearningStore } from './core/learnings.js';
export type { Learning } from './core/learnings.js';
export { reflectOnRun, shouldReflect } from './core/reflect.js';
export { routeSubtask } from './core/router.js';
export { RunStore, newRunId } from './core/run-store.js';
export { SessionHistory } from './core/session.js';
export {
  TUNABLE,
  TuningStore,
  interpretConfigAction,
  normalizeValue,
  proposeTuning,
  runScore,
} from './core/tuning.js';
export type { Experiment, TunableSpec, TuneSuggestion } from './core/tuning.js';
export { ProposalStore, runWatch } from './core/watch.js';
export type { Proposal, ProposalKind, WatchParams } from './core/watch.js';
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
export { GrokWorker } from './workers/grok.js';
export { LocalOpenAiWorker } from './workers/local-openai.js';
export { MockWorker } from './workers/mock.js';
export { OpenCodeWorker } from './workers/opencode.js';
export { QwenWorker } from './workers/qwen.js';
export { WorkerRegistry } from './workers/registry.js';
export { runCli, tolerantJsonParse } from './workers/subprocess.js';
export type {
  Capability,
  CostTier,
  Worker,
  WorkerInvocation,
  WorkerResult,
} from './workers/worker.js';
