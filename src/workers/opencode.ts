/**
 * Worker adapter for OpenCode, driven through its officially supported
 * non-interactive mode: `opencode run "<prompt>"` (response text on stdout).
 */
import { runCli, toWorkerResult } from './subprocess.js';
import type { Capability, Worker, WorkerInvocation, WorkerResult } from './worker.js';

export interface OpenCodeWorkerConfig {
  command?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

export class OpenCodeWorker implements Worker {
  readonly id = 'opencode';
  readonly name = 'OpenCode (subscription CLI)';
  readonly capabilities: Capability[] = ['code-edit', 'code-gen', 'reason', 'chat'];
  readonly costTier = 'subscription' as const;

  private readonly command: string;
  private readonly extraArgs: string[];
  private readonly timeoutMs?: number;

  constructor(config: OpenCodeWorkerConfig = {}) {
    this.command = config.command ?? 'opencode';
    this.extraArgs = config.extraArgs ?? [];
    this.timeoutMs = config.timeoutMs;
  }

  async healthCheck(): Promise<boolean> {
    const run = await runCli({ cmd: this.command, args: ['--version'], timeoutMs: 15_000 });
    return run.ok;
  }

  async invoke(inv: WorkerInvocation): Promise<WorkerResult> {
    const args = ['run', ...this.extraArgs, inv.prompt];
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
