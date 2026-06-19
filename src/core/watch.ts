/**
 * AI watch ("veille"): Jack periodically researches recent AI developments and
 * turns them into concrete proposals to improve his OWN system — new models or
 * workers to add, prompt/config tweaks, techniques to adopt. Proposals are
 * persisted under <runsDir>/proposals.json; the auto-modification step (later)
 * acts on the safe prompt/config ones.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Brain } from '../brain/brain.js';
import { watchProposalPrompt, watchResearchPrompt } from '../brain/prompts.js';
import type { Worker } from '../workers/worker.js';

export type ProposalKind = 'model' | 'worker' | 'prompt' | 'config' | 'technique';

export interface Proposal {
  at: string;
  kind: ProposalKind;
  title: string;
  rationale: string;
  action: string;
  /** Set once the auto-modification step has acted on it. */
  applied?: boolean;
}

const proposalsSchema = z.object({
  proposals: z
    .array(
      z.object({
        kind: z.enum(['model', 'worker', 'prompt', 'config', 'technique']),
        title: z.string(),
        rationale: z.string().default(''),
        action: z.string().default(''),
      }),
    )
    .default([]),
});

export class ProposalStore {
  private constructor(
    private readonly path: string,
    private items: Proposal[],
  ) {}

  static async load(runsDir: string): Promise<ProposalStore> {
    const path = join(runsDir, 'proposals.json');
    try {
      const items = JSON.parse(await readFile(path, 'utf8'));
      if (Array.isArray(items)) return new ProposalStore(path, items as Proposal[]);
    } catch {
      // Missing or corrupt — start fresh.
    }
    return new ProposalStore(path, []);
  }

  all(): Proposal[] {
    return [...this.items];
  }

  get length(): number {
    return this.items.length;
  }

  async add(proposals: Proposal[]): Promise<void> {
    this.items.push(...proposals);
    await this.persist();
  }

  /** Mark the nth (0-based) proposal as applied. No-op if out of range. */
  async setApplied(index: number): Promise<void> {
    const item = this.items[index];
    if (!item) return;
    item.applied = true;
    await this.persist();
  }

  async clear(): Promise<void> {
    this.items = [];
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.items, null, 2));
  }
}

export interface WatchParams {
  brain: Brain;
  /** A web-capable worker for fresh research; omit to propose from brain knowledge. */
  webWorker?: Worker;
  /** Short description of Jack's current workers/config, so proposals fit. */
  setupSummary: string;
  area: string;
}

/**
 * Run one watch cycle: research recent developments, then distill them into
 * proposals. Never throws — a failed watch returns []. The `findings` are also
 * returned so the CLI can show what Jack read.
 */
export async function runWatch(
  params: WatchParams,
): Promise<{ proposals: Proposal[]; findings: string }> {
  const at = new Date().toISOString();

  let findings = '(no web worker available — proposing from general knowledge)';
  if (params.webWorker) {
    try {
      const res = await params.webWorker.invoke({ prompt: watchResearchPrompt(params.area) });
      if (res.ok && res.text.trim()) findings = res.text.trim();
    } catch {
      // keep the fallback findings text
    }
  }

  try {
    const parsed = proposalsSchema.parse(
      await params.brain.askJson<unknown>(
        watchProposalPrompt(params.area, findings, params.setupSummary),
      ),
    );
    const proposals: Proposal[] = parsed.proposals.map((p) => ({ at, ...p }));
    return { proposals, findings };
  } catch {
    return { proposals: [], findings };
  }
}
