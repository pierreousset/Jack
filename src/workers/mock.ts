/**
 * In-memory worker used in unit tests and as a reference implementation for
 * custom workers (see examples/custom-worker.ts).
 */
import type { Capability, CostTier, Worker, WorkerInvocation, WorkerResult } from './worker.js';

export interface MockWorkerConfig {
  id?: string;
  name?: string;
  capabilities?: Capability[];
  costTier?: CostTier;
  role?: 'brain' | 'worker';
  healthy?: boolean;
  /** Respond to a prompt. Defaults to echoing the prompt. */
  respond?: (inv: WorkerInvocation) => Promise<WorkerResult> | WorkerResult;
}

export class MockWorker implements Worker {
  readonly id: string;
  readonly name: string;
  readonly capabilities: Capability[];
  readonly costTier: CostTier;
  readonly role?: 'brain' | 'worker';
  /** All invocations received, for assertions. */
  readonly invocations: WorkerInvocation[] = [];

  private readonly healthy: boolean;
  private readonly respond: NonNullable<MockWorkerConfig['respond']>;

  constructor(config: MockWorkerConfig = {}) {
    this.id = config.id ?? 'mock';
    this.name = config.name ?? 'Mock worker';
    this.capabilities = config.capabilities ?? ['code-gen', 'reason', 'summarize', 'chat'];
    this.costTier = config.costTier ?? 'free-local';
    this.role = config.role;
    this.healthy = config.healthy ?? true;
    this.respond = config.respond ?? ((inv) => ({ ok: true, text: `echo: ${inv.prompt}` }));
  }

  async healthCheck(): Promise<boolean> {
    return this.healthy;
  }

  async invoke(inv: WorkerInvocation): Promise<WorkerResult> {
    this.invocations.push(inv);
    return this.respond(inv);
  }
}
