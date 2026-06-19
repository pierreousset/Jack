/**
 * Backlog of topics for autonomous mode (`jack cook`): Jack works through them
 * one by one on his own. Persisted per project under <runsDir>/backlog.json so
 * a cook session is resumable — anything not marked done is picked up next time.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type BacklogStatus = 'pending' | 'done' | 'failed';

export interface BacklogItem {
  id: string;
  topic: string;
  status: BacklogStatus;
  at: string;
  runId?: string;
  finishedAt?: string;
}

export class BacklogStore {
  private constructor(
    private readonly path: string,
    private items: BacklogItem[],
    private seq: number,
  ) {}

  static async load(runsDir: string): Promise<BacklogStore> {
    const path = join(runsDir, 'backlog.json');
    try {
      const items = JSON.parse(await readFile(path, 'utf8'));
      if (Array.isArray(items)) {
        const list = items as BacklogItem[];
        const maxId = list.reduce((m, it) => Math.max(m, Number(it.id) || 0), 0);
        return new BacklogStore(path, list, maxId);
      }
    } catch {
      // Missing or corrupt — start fresh.
    }
    return new BacklogStore(path, [], 0);
  }

  all(): BacklogItem[] {
    return [...this.items];
  }

  /** Items still to do (never run, or left unfinished by an interrupted cook). */
  pending(): BacklogItem[] {
    return this.items.filter((it) => it.status === 'pending');
  }

  /** Append a topic. Skips exact-duplicate pending topics. Returns the item (or existing). */
  async add(topic: string, at: string): Promise<BacklogItem> {
    const trimmed = topic.trim();
    const existing = this.items.find((it) => it.status === 'pending' && it.topic === trimmed);
    if (existing) return existing;
    this.seq += 1;
    const item: BacklogItem = { id: String(this.seq), topic: trimmed, status: 'pending', at };
    this.items.push(item);
    await this.persist();
    return item;
  }

  async mark(id: string, status: BacklogStatus, finishedAt: string, runId?: string): Promise<void> {
    const item = this.items.find((it) => it.id === id);
    if (!item) return;
    item.status = status;
    item.finishedAt = finishedAt;
    if (runId) item.runId = runId;
    await this.persist();
  }

  async clear(): Promise<void> {
    this.items = [];
    this.seq = 0;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.items, null, 2));
  }
}
