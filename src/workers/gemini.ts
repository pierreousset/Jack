/**
 * Worker adapter for the Gemini CLI, driven through its officially supported
 * non-interactive mode: `gemini -p "<prompt>"` (plain text on stdout).
 */
import { runCli, toWorkerResult } from './subprocess.js';
import type { Capability, Worker, WorkerInvocation, WorkerResult } from './worker.js';

export interface GeminiWorkerConfig {
  command?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

export class GeminiWorker implements Worker {
  readonly id = 'gemini';
  readonly name = 'Gemini CLI (subscription CLI)';
  readonly capabilities: Capability[] = ['code-gen', 'reason', 'summarize', 'chat', 'web'];
  readonly costTier = 'subscription' as const;

  private readonly command: string;
  private readonly extraArgs: string[];
  private readonly timeoutMs?: number;

  constructor(config: GeminiWorkerConfig = {}) {
    this.command = config.command ?? 'gemini';
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
