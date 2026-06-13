/**
 * Shared subprocess helper for CLI-backed workers.
 *
 * This is the only place that knows how to spawn a CLI, enforce a timeout,
 * stream stdout and tolerantly parse output. Per-CLI knowledge (flags, JSON
 * shapes) lives in each worker adapter.
 */
import { spawn } from 'node:child_process';
import type { WorkerInvocation, WorkerResult } from './worker.js';

export interface RunCliOptions {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Hard timeout in ms. Default: 10 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Raw stdout chunks, as they arrive (use for plain-text CLIs that stream the answer). */
  onChunk?: (text: string) => void;
  /**
   * Complete stdout lines, as they arrive (use for line-delimited JSON streams
   * like `claude --output-format stream-json`). The trailing partial line is
   * flushed when the process ends.
   */
  onLine?: (line: string) => void;
}

export interface RunCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  ms: number;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export async function runCli(opts: RunCliOptions): Promise<RunCliResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    let settled = false;

    const pumpLines = () => {
      if (!opts.onLine) return;
      let nl = lineBuf.indexOf('\n');
      while (nl !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (line.trim()) opts.onLine(line);
        nl = lineBuf.indexOf('\n');
      }
    };

    const child = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (partial: Partial<RunCliResult> & { ok: boolean }) => {
      if (settled) return;
      settled = true;
      // Flush any trailing partial line (the final JSON event often has no \n yet).
      if (opts.onLine && lineBuf.trim()) opts.onLine(lineBuf);
      lineBuf = '';
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout,
        stderr,
        exitCode: null,
        ms: Date.now() - start,
        ...partial,
      });
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    const onAbort = () => {
      child.kill('SIGTERM');
      finish({ ok: false, error: 'aborted' });
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8');
      stdout += text;
      opts.onChunk?.(text);
      if (opts.onLine) {
        lineBuf += text;
        pumpLines();
      }
    });
    child.stderr.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf8');
    });

    child.on('error', (err) => {
      finish({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      finish({
        ok: code === 0,
        exitCode: code,
        error: code === 0 ? undefined : stderr.trim() || `exit code ${code}`,
      });
    });
  });
}

/**
 * Tolerant JSON parsing: prefer a full-document parse, then fall back to the
 * last JSON object found in the text (CLIs often print banners/logs first),
 * then give up and return undefined.
 */
export function tolerantJsonParse(text: string): unknown | undefined {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall back: scan for the last balanced top-level {...} block.
    const lastOpen = trimmed.lastIndexOf('\n{');
    if (lastOpen !== -1) {
      try {
        return JSON.parse(trimmed.slice(lastOpen + 1));
      } catch {
        // ignore
      }
    }
    return undefined;
  }
}

/** Convert a RunCliResult into a generic WorkerResult (text = stdout). */
export function toWorkerResult(run: RunCliResult, text?: string, raw?: unknown): WorkerResult {
  return {
    ok: run.ok,
    text: (text ?? run.stdout).trim(),
    raw,
    usage: { ms: run.ms },
    error: run.error,
  };
}

/** Re-export invocation type for adapter convenience. */
export type { WorkerInvocation };
