/**
 * Worker adapter for the Claude Code CLI (`claude`), driven through its
 * officially supported headless mode: `claude -p "<prompt>"`.
 *
 * We use `--output-format stream-json --include-partial-messages` so the CLI
 * emits newline-delimited JSON events *as tokens arrive*, instead of buffering
 * the whole answer behind `--output-format json`. We forward each text delta to
 * `onChunk` for live streaming and take the final answer from the `result`
 * event. That event-shape knowledge lives here and nowhere else.
 */
import { runCli, toWorkerResult } from './subprocess.js';
import type { Capability, Worker, WorkerInvocation, WorkerResult } from './worker.js';

/** Parse one stream-json line; non-JSON banner lines are ignored. */
function parseEvent(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Pull a `content_block_delta` text fragment out of a stream_event, if present. */
function textDelta(event: Record<string, unknown>): string | undefined {
  if (event.type !== 'stream_event') return undefined;
  const inner = event.event as
    | { type?: string; delta?: { type?: string; text?: unknown } }
    | undefined;
  if (inner?.type !== 'content_block_delta' || inner.delta?.type !== 'text_delta') return undefined;
  return typeof inner.delta.text === 'string' ? inner.delta.text : undefined;
}

export interface ClaudeCodeWorkerConfig {
  command?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  /** Override the model (e.g. 'haiku' for brain duties). Omit = CLI default. */
  model?: string;
  /** Pass --strict-mcp-config so no MCP servers spawn (faster cold start). */
  strictMcpConfig?: boolean;
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
  private readonly model?: string;
  private readonly strictMcpConfig: boolean;

  constructor(config: ClaudeCodeWorkerConfig = {}) {
    this.command = config.command ?? 'claude';
    this.extraArgs = config.extraArgs ?? [];
    this.timeoutMs = config.timeoutMs;
    this.model = config.model;
    this.strictMcpConfig = config.strictMcpConfig ?? false;
  }

  /**
   * A lean clone for brain duties (plan/route/synthesize): a fast model and no
   * MCP servers. Keeps the same command/timeout. Execution stays on the full
   * worker, so only planning goes cheap — never the real task.
   */
  brainProfile(model?: string): ClaudeCodeWorker {
    return new ClaudeCodeWorker({
      command: this.command,
      extraArgs: this.extraArgs,
      timeoutMs: this.timeoutMs,
      model: model ?? this.model,
      strictMcpConfig: true,
    });
  }

  async healthCheck(): Promise<boolean> {
    const run = await runCli({ cmd: this.command, args: ['--version'], timeoutMs: 15_000 });
    return run.ok;
  }

  async invoke(inv: WorkerInvocation): Promise<WorkerResult> {
    const args = [
      '-p',
      inv.prompt,
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      ...(this.model ? ['--model', this.model] : []),
      ...(this.strictMcpConfig ? ['--strict-mcp-config'] : []),
      ...this.extraArgs,
    ];

    // `result` is the authoritative final answer; `assembled` is a fallback we
    // build from the streamed deltas in case the result event never lands.
    let result: string | undefined;
    let assembled = '';

    const run = await runCli({
      cmd: this.command,
      args,
      cwd: inv.cwd,
      timeoutMs: this.timeoutMs,
      signal: inv.signal,
      onLine: (line) => {
        const event = parseEvent(line);
        if (!event) return;
        const delta = textDelta(event);
        if (delta !== undefined) {
          assembled += delta;
          inv.onChunk?.(delta);
        } else if (event.type === 'result' && typeof event.result === 'string') {
          result = event.result;
        }
      },
    });

    const text = result ?? (assembled.trim() ? assembled : undefined);
    return toWorkerResult(run, text);
  }
}
