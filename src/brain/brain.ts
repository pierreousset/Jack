import { ClaudeCodeWorker } from '../workers/claude-code.js';
import type { WorkerRegistry } from '../workers/registry.js';
/**
 * Jack's brain: a thin wrapper around whichever Worker is designated to make
 * planning/routing decisions. The brain is "just a worker", so users can point
 * it at a local model for zero-cost operation.
 */
import { tolerantJsonParse } from '../workers/subprocess.js';
import type { Worker } from '../workers/worker.js';

export class Brain {
  constructor(private readonly worker: Worker) {}

  get workerId(): string {
    return this.worker.id;
  }

  /** Ask the brain a question and parse its JSON answer (tolerant of fences/logs). */
  async askJson<T>(prompt: string): Promise<T> {
    const result = await this.worker.invoke({ prompt, jsonOutput: true });
    if (!result.ok) {
      throw new Error(`brain (${this.worker.id}) failed: ${result.error ?? 'unknown error'}`);
    }
    const cleaned = stripMarkdownFences(result.text);
    const parsed = tolerantJsonParse(cleaned);
    if (parsed === undefined) {
      throw new Error(
        `brain (${this.worker.id}) returned unparseable JSON: ${result.text.slice(0, 300)}`,
      );
    }
    return parsed as T;
  }

  /** Ask the brain for free-form text (e.g. final synthesis). */
  async askText(prompt: string): Promise<string> {
    const result = await this.worker.invoke({ prompt });
    if (!result.ok) {
      throw new Error(`brain (${this.worker.id}) failed: ${result.error ?? 'unknown error'}`);
    }
    return result.text;
  }
}

/** Models love wrapping JSON in ```json fences despite instructions. */
export function stripMarkdownFences(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return match?.[1]?.trim() ?? text.trim();
}

/**
 * Resolve the brain worker: explicit config id first, then any worker tagged
 * role 'brain', then nothing (caller decides how to degrade).
 *
 * For a Claude-CLI brain we swap in a lean profile (fast model, no MCP) so
 * planning/routing/synthesis don't pay the execution model's latency and cost.
 */
export function resolveBrain(
  registry: WorkerRegistry,
  configuredId: string,
  options: { model?: string } = {},
): Brain | undefined {
  const worker = registry.get(configuredId) ?? registry.brain();
  if (!worker) return undefined;
  if (worker instanceof ClaudeCodeWorker) return new Brain(worker.brainProfile(options.model));
  return new Brain(worker);
}
