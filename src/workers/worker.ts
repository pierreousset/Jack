/**
 * The central abstraction of Jack: everything that can execute a prompt
 * (a subscription CLI, a local model server, a remote inference API, a mock)
 * implements `Worker`.
 */

/** How much it costs to invoke this worker. Routing prefers cheaper tiers. */
export type CostTier = 'free-local' | 'subscription' | 'paid-api';

/** What kind of work a worker is good at. */
export type Capability = 'code-edit' | 'code-gen' | 'reason' | 'summarize' | 'chat' | 'web';

export interface WorkerInvocation {
  prompt: string;
  /** Working directory for CLI workers that read/edit files. */
  cwd?: string;
  /** Ask the worker for structured JSON output when supported. */
  jsonOutput?: boolean;
  /** Cancellation / timeout. */
  signal?: AbortSignal;
  /** Streaming callback — raw text chunks as they arrive. */
  onChunk?: (text: string) => void;
}

export interface WorkerResult {
  ok: boolean;
  /** The final answer as plain text. */
  text: string;
  /** Parsed JSON payload when the worker returned structured output. */
  raw?: unknown;
  usage?: { ms: number };
  error?: string;
}

export interface Worker {
  /** Stable identifier, e.g. 'claude-code', 'ollama:qwen2.5-coder'. */
  id: string;
  /** Human-readable name shown in `jack workers` / `jack doctor`. */
  name: string;
  capabilities: Capability[];
  costTier: CostTier;
  /** 'brain' workers may be used for planning/routing/QC decisions. */
  role?: 'brain' | 'worker';
  /** Cheap check that the worker is reachable (CLI on PATH, server up...). */
  healthCheck(): Promise<boolean>;
  invoke(inv: WorkerInvocation): Promise<WorkerResult>;
}

/** Ordering used by the router: cheaper first. */
export const COST_TIER_ORDER: Record<CostTier, number> = {
  'free-local': 0,
  subscription: 1,
  'paid-api': 2,
};
