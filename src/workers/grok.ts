/**
 * Worker adapter for the Grok CLI (xAI), driven through its non-interactive
 * mode: `grok -p "<prompt>"` (plain text on stdout).
 */
import { runCli, toWorkerResult } from './subprocess.js';
import type { Capability, Worker, WorkerInvocation, WorkerResult } from './worker.js';

export interface GrokWorkerConfig {
  command?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

export class GrokWorker implements Worker {
  readonly id = 'grok';
  readonly name = 'Grok CLI (subscription CLI)';
  readonly capabilities: Capability[] = ['code-gen', 'reason', 'chat', 'web'];
  readonly costTier = 'subscription' as const;

  private readonly command: string;
  private readonly extraArgs: string[];
  private readonly timeoutMs?: number;

  constructor(config: GrokWorkerConfig = {}) {
    this.command = config.command ?? 'grok';
    this.extraArgs = config.extraArgs ?? [];
    this.timeoutMs = config.timeoutMs;
  }

  async healthCheck(): Promise<boolean> {
    const run = await runCli({ cmd: this.command, args: ['--version'], timeoutMs: 15_000 });
    return run.ok;
  }

  async invoke(inv: WorkerInvocation): Promise<WorkerResult> {
    const args = ['-p', inv.prompt, ...this.extraArgs];
    const run = await runCli({
      cmd: this.command,
      args,
      cwd: inv.cwd,
      timeoutMs: this.timeoutMs,
      signal: inv.signal,
      onChunk: inv.onChunk,
    });
    return toWorkerResult(run);
  }
}
