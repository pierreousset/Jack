/**
 * Self-improvement memory: lessons Jack draws from runs that went badly, so he
 * does better next time. Persisted per project under <runsDir>/learnings.json
 * and injected into planning + worker prompts as "guidance".
 *
 * This is the substrate of Jack's auto-critique loop: the quality gate flags a
 * weak or failed run, the brain distills one actionable lesson, it lands here,
 * and every later run reads it back.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Capability } from '../workers/worker.js';

export interface Learning {
  at: string;
  /** The task (truncated) that triggered the lesson. */
  task: string;
  capability?: Capability;
  /** One actionable, reusable instruction for future runs. */
  insight: string;
  /** Quality score (0–1) of the run that prompted this, when known. */
  score?: number;
}

const MAX_ENTRIES = 100;

export class LearningStore {
  private constructor(
    private readonly path: string,
    private entries: Learning[],
  ) {}

  static async load(runsDir: string): Promise<LearningStore> {
    const path = join(runsDir, 'learnings.json');
    try {
      const entries = JSON.parse(await readFile(path, 'utf8'));
      if (Array.isArray(entries)) return new LearningStore(path, entries as Learning[]);
    } catch {
      // Missing or corrupt — start fresh.
    }
    return new LearningStore(path, []);
  }

  all(): Learning[] {
    return [...this.entries];
  }

  get length(): number {
    return this.entries.length;
  }

  async add(learning: Learning): Promise<void> {
    this.entries.push(learning);
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
    await this.persist();
  }

  async clear(): Promise<void> {
    this.entries = [];
    await this.persist();
  }

  /**
   * Guidance block for prompts: the most recent lessons (capability-relevant
   * ones first), as terse bullets. Returns undefined when there is nothing yet.
   */
  guidanceBlock(capability?: Capability, max = 5): string | undefined {
    if (this.entries.length === 0) return undefined;
    const relevant = capability
      ? this.entries.filter((e) => !e.capability || e.capability === capability)
      : this.entries;
    const chosen = (relevant.length > 0 ? relevant : this.entries).slice(-max);
    if (chosen.length === 0) return undefined;
    return chosen.map((e) => `- ${e.insight}`).join('\n');
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.entries, null, 2));
  }
}
