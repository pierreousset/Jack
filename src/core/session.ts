/**
 * Conversation history: persisted per project under <runsDir>/history.json so
 * Jack remembers what you were talking about across tasks and sessions, and
 * can hand that context to the brain and to delegated workers.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface HistoryEntry {
  at: string;
  task: string;
  answer: string;
  runId?: string;
  /** Whether the run succeeded; failed exchanges still stay in the thread. */
  ok?: boolean;
}

const MAX_ENTRIES = 50;

export class SessionHistory {
  private constructor(
    private readonly path: string,
    private entries: HistoryEntry[],
  ) {}

  static async load(runsDir: string): Promise<SessionHistory> {
    const path = join(runsDir, 'history.json');
    try {
      const entries = JSON.parse(await readFile(path, 'utf8'));
      if (Array.isArray(entries)) return new SessionHistory(path, entries as HistoryEntry[]);
    } catch {
      // Missing or corrupt — start fresh.
    }
    return new SessionHistory(path, []);
  }

  all(): HistoryEntry[] {
    return [...this.entries];
  }

  get length(): number {
    return this.entries.length;
  }

  async record(entry: HistoryEntry): Promise<void> {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
    await this.persist();
  }

  async clear(): Promise<void> {
    this.entries = [];
    await this.persist();
  }

  /**
   * Compact context block for prompts: the last `maxEntries` exchanges with
   * answers truncated, so delegated prompts stay small.
   */
  contextBlock(maxEntries = 4, maxAnswerChars = 600): string | undefined {
    if (this.entries.length === 0) return undefined;
    const recent = this.entries.slice(-maxEntries);
    return recent
      .map((e) => {
        if (e.ok === false) {
          // Keep the question in the thread, but don't feed the error wall back in.
          return `User asked: ${e.task}\nJack answered: (the previous attempt failed and produced no usable answer)`;
        }
        const answer =
          e.answer.length > maxAnswerChars ? `${e.answer.slice(0, maxAnswerChars)} […]` : e.answer;
        return `User asked: ${e.task}\nJack answered: ${answer}`;
      })
      .join('\n\n');
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.entries, null, 2));
  }
}
