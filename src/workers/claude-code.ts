/**
 * Worker adapter for the Claude Code CLI (`claude`), driven through its
 * officially supported headless mode: `claude -p "<prompt>"`.
 *
 * With `--output-format json` the CLI prints a single JSON document shaped
 * like `{ type: "result", result: "<answer>", ... }` — that shape knowledge
 * lives here and nowhere else.
 */
import { runCli, toWorkerResult, tolerantJsonParse } from './subprocess.js';
import type { Capability, Worker, WorkerInvocation, WorkerResult } from './worker.js';

export interface ClaudeCodeWorkerConfig {
  command?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

export class ClaudeCodeWorker implements Worker {
  readonly id = 'claude-code';
  readonly name = 'Claude Code (subscription CLI)';
  readonly capabilities: Capability[] = ['code-edit', 'code-gen', 'reason', 'summarize', 'chat'];
  readonly costTier = 'subscription' as const;
  readonly role = 'brain' as const;

  private readonly command: string;
  private readonly extraArgs: string[];
  private readonly timeoutMs?: number;

  constructor(config: ClaudeCodeWorkerConfig = {}) {
    this.command = config.command ?? 'claude';
    this.extraArgs = config.extraArgs ?? [];
    this.timeoutMs = config.timeoutMs;
  }

  async healthCheck(): Promise<boolean> {
    const run = await runCli({ cmd: this.command, args: ['--version'], timeoutMs: 15_000 });
    return run.ok;
  }

  async invoke(inv: WorkerInvocation): Promise<WorkerResult> {
    const args = ['-p', inv.prompt, '--output-format', 'json', ...this.extraArgs];
    const run = await runCli({
      cmd: this.command,
      args,
      cwd: inv.cwd,
      timeoutMs: this.timeoutMs,
      signal: inv.signal,
      onChunk: inv.onChunk,
    });

    const raw = tolerantJsonParse(run.stdout);
    const result =
      raw && typeof raw === 'object' && 'result' in raw && typeof raw.result === 'string'
        ? raw.result
        : undefined;
    return toWorkerResult(run, result, raw);
  }
}
