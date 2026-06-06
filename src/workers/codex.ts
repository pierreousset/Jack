/**
 * Worker adapter for the OpenAI Codex CLI, driven through its officially
 * supported non-interactive mode: `codex exec "<prompt>"`.
 *
 * `codex exec` interleaves progress logs on stdout, so we ask it to write the
 * final message to a temp file (`--output-last-message`) and read that back,
 * falling back to stdout if the file is missing.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, toWorkerResult } from './subprocess.js';
import type { Capability, Worker, WorkerInvocation, WorkerResult } from './worker.js';

export interface CodexWorkerConfig {
  command?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

export class CodexWorker implements Worker {
  readonly id = 'codex';
  readonly name = 'OpenAI Codex (subscription CLI)';
  readonly capabilities: Capability[] = ['code-edit', 'code-gen', 'reason', 'chat'];
  readonly costTier = 'subscription' as const;

  private readonly command: string;
  private readonly extraArgs: string[];
  private readonly timeoutMs?: number;

  constructor(config: CodexWorkerConfig = {}) {
    this.command = config.command ?? 'codex';
    this.extraArgs = config.extraArgs ?? [];
    this.timeoutMs = config.timeoutMs;
  }

  async healthCheck(): Promise<boolean> {
    const run = await runCli({ cmd: this.command, args: ['--version'], timeoutMs: 15_000 });
    return run.ok;
  }

  async invoke(inv: WorkerInvocation): Promise<WorkerResult> {
    const dir = await mkdtemp(join(tmpdir(), 'jack-codex-'));
    const lastMessagePath = join(dir, 'last-message.txt');
    try {
      const args = [
        'exec',
        '--skip-git-repo-check',
        '--output-last-message',
        lastMessagePath,
        ...this.extraArgs,
        inv.prompt,
      ];
      const run = await runCli({
        cmd: this.command,
        args,
        cwd: inv.cwd,
        timeoutMs: this.timeoutMs,
        signal: inv.signal,
        onChunk: inv.onChunk,
      });

      let lastMessage: string | undefined;
      try {
        lastMessage = (await readFile(lastMessagePath, 'utf8')).trim() || undefined;
      } catch {
        // File not written (old CLI version or failure) — fall back to stdout.
      }
      return toWorkerResult(run, lastMessage);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
