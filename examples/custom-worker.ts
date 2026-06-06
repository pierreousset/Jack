/**
 * Example: a custom Worker.
 *
 * Anything that can turn a prompt into text can be a Jack worker — here, a
 * fictional HTTP service. Register it on the registry and the router will
 * pick it up like any built-in worker.
 *
 * Run conceptually with: npx tsx examples/custom-worker.ts
 */
import {
  RunStore,
  WorkerRegistry,
  newRunId,
  orchestrate,
  type Worker,
  type WorkerInvocation,
  type WorkerResult,
} from 'jack-orchestrator';

class MyHttpWorker implements Worker {
  readonly id = 'my-service';
  readonly name = 'My custom HTTP service';
  readonly capabilities = ['summarize', 'chat'] as const satisfies Worker['capabilities'];
  readonly costTier = 'paid-api' as const;

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch('https://my-service.example.com/health');
      return res.ok;
    } catch {
      return false;
    }
  }

  async invoke(inv: WorkerInvocation): Promise<WorkerResult> {
    const start = Date.now();
    const res = await fetch('https://my-service.example.com/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: inv.prompt }),
      signal: inv.signal,
    });
    if (!res.ok) {
      return { ok: false, text: '', error: `HTTP ${res.status}`, usage: { ms: Date.now() - start } };
    }
    const { text } = (await res.json()) as { text: string };
    return { ok: true, text, usage: { ms: Date.now() - start } };
  }
}

const registry = new WorkerRegistry();
registry.register(new MyHttpWorker());

const store = await RunStore.create('./jack-runs', newRunId());
const record = await orchestrate(
  { id: store.runId, prompt: 'summarize: Jack routes tasks to cheap workers', cwd: process.cwd() },
  { registry, store, preferTier: 'free-local', maxConcurrency: 3, maxAttemptsPerSubtask: 3 },
);
console.log(record.report);
