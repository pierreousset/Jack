/**
 * Worker registry: holds the available workers, answers "who can do X,
 * cheapest first?" and builds ordered fallback chains.
 */
import { COST_TIER_ORDER, type Capability, type CostTier, type Worker } from './worker.js';

export class WorkerRegistry {
  private readonly workers = new Map<string, Worker>();

  register(worker: Worker): void {
    if (this.workers.has(worker.id)) {
      throw new Error(`worker id already registered: ${worker.id}`);
    }
    this.workers.set(worker.id, worker);
  }

  get(id: string): Worker | undefined {
    return this.workers.get(id);
  }

  all(): Worker[] {
    return [...this.workers.values()];
  }

  /** The worker used for planning/routing/QC decisions. */
  brain(): Worker | undefined {
    return this.all().find((w) => w.role === 'brain');
  }

  /**
   * Workers able to handle `capability`, ordered cheapest-first.
   * When `preferredTier` is given, workers of that tier come first, then the
   * regular cheap-first order.
   */
  candidatesFor(capability: Capability, preferredTier?: CostTier): Worker[] {
    return this.all()
      .filter((w) => w.capabilities.includes(capability))
      .sort((a, b) => {
        if (preferredTier) {
          const prefA = a.costTier === preferredTier ? 0 : 1;
          const prefB = b.costTier === preferredTier ? 0 : 1;
          if (prefA !== prefB) return prefA - prefB;
        }
        return COST_TIER_ORDER[a.costTier] - COST_TIER_ORDER[b.costTier];
      });
  }

  /** Health-check every worker. Returns a map of workerId -> healthy. */
  async healthReport(): Promise<Map<string, boolean>> {
    const entries = await Promise.all(
      this.all().map(async (w) => [w.id, await w.healthCheck().catch(() => false)] as const),
    );
    return new Map(entries);
  }
}
