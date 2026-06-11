/**
 * Worker adapter for Qwen Code (Alibaba's fork of the Gemini CLI), driven
 * through its officially supported non-interactive mode: `qwen -p "<prompt>"`.
 */
import { runCli, toWorkerResult } from './subprocess.js';
import type { Capability, Worker, WorkerInvocation, WorkerResult } from './worker.js';

export interface QwenWorkerConfig {
  command?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

export class QwenWorker implements Worker {
  readonly id = 'qwen';
  readonly name = 'Qwen Code (subscription CLI)';
  readonly capabilities: Capability[] = ['code-gen', 'reason', 'summarize', 'chat'];
  readonly costTier = 'subscription' as const;

  private readonly command: string;
  private readonly extraArgs: string[];
  private readonly timeoutMs?: number;

  constructor(config: QwenWorkerConfig = {}) {
    this.command = config.command ?? 'qwen';
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
