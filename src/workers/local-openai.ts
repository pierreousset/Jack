/**
 * Worker adapter for any OpenAI-compatible local server:
 * Ollama (http://localhost:11434/v1) or LM Studio (http://localhost:1234/v1).
 * Free and unlimited — the router prefers this tier whenever quality allows.
 */
import type { Capability, Worker, WorkerInvocation, WorkerResult } from './worker.js';

export interface LocalOpenAiWorkerConfig {
  /** e.g. 'http://localhost:11434/v1' (Ollama) or 'http://localhost:1234/v1' (LM Studio). */
  baseUrl: string;
  /** Model name as known by the server, e.g. 'qwen2.5-coder:14b'. */
  model: string;
  id?: string;
  name?: string;
  apiKey?: string;
  timeoutMs?: number;
  capabilities?: Capability[];
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class LocalOpenAiWorker implements Worker {
  readonly id: string;
  readonly name: string;
  readonly capabilities: Capability[];
  readonly costTier = 'free-local' as const;

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(config: LocalOpenAiWorkerConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.model = config.model;
    this.id = config.id ?? `local:${config.model}`;
    this.name = config.name ?? `Local model (${config.model})`;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.capabilities = config.capabilities ?? ['code-gen', 'reason', 'summarize', 'chat'];
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async invoke(inv: WorkerInvocation): Promise<WorkerResult> {
    const start = Date.now();
    const signals = [AbortSignal.timeout(this.timeoutMs)];
    if (inv.signal) signals.push(inv.signal);

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        signal: AbortSignal.any(signals),
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: inv.prompt }],
          ...(inv.jsonOutput ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          ok: false,
          text: '',
          usage: { ms: Date.now() - start },
          error: `HTTP ${res.status}: ${body.slice(0, 500)}`,
        };
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content ?? '';
      inv.onChunk?.(text);
      return { ok: true, text: text.trim(), raw: data, usage: { ms: Date.now() - start } };
    } catch (err) {
      return {
        ok: false,
        text: '',
        usage: { ms: Date.now() - start },
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
