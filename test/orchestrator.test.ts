import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Brain } from '../src/brain/brain.js';
import { orchestrate, topologicalWaves } from '../src/core/orchestrator.js';
import { RunStore } from '../src/core/run-store.js';
import type { Subtask, Task } from '../src/core/types.js';
import { MockWorker } from '../src/workers/mock.js';
import { WorkerRegistry } from '../src/workers/registry.js';

describe('topologicalWaves', () => {
  const st = (id: string, dependsOn?: string[]): Subtask => ({
    id,
    prompt: id,
    capability: 'chat',
    dependsOn,
  });

  it('groups independent subtasks into one wave', () => {
    const waves = topologicalWaves([st('a'), st('b')]);
    expect(waves.map((w) => w.map((s) => s.id))).toEqual([['a', 'b']]);
  });

  it('orders dependent subtasks into later waves', () => {
    const waves = topologicalWaves([st('c', ['a', 'b']), st('a'), st('b', ['a'])]);
    expect(waves.map((w) => w.map((s) => s.id))).toEqual([['a'], ['b'], ['c']]);
  });

  it('detects cycles', () => {
    expect(() => topologicalWaves([st('a', ['b']), st('b', ['a'])])).toThrow(/cycle/);
  });

  it('rejects unknown dependencies', () => {
    expect(() => topologicalWaves([st('a', ['ghost'])])).toThrow(/unknown subtask/);
  });
});

describe('orchestrate', () => {
  let dir: string;
  let store: RunStore;
  const task: Task = { id: 't1', prompt: 'say hello', cwd: '/tmp' };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jack-test-'));
    store = await RunStore.create(dir, 'run-1');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const baseOpts = (registry: WorkerRegistry, brain?: Brain) => ({
    registry,
    store,
    brain,
    preferTier: 'free-local' as const,
    maxConcurrency: 2,
    maxAttemptsPerSubtask: 3,
  });

  it('runs a single-subtask plan without a brain and persists the run', async () => {
    const registry = new WorkerRegistry();
    const worker = new MockWorker({ id: 'local', respond: () => ({ ok: true, text: 'hello!' }) });
    registry.register(worker);

    const record = await orchestrate(task, baseOpts(registry));

    expect(record.status).toBe('done');
    expect(record.report).toBe('hello!');
    expect(record.outcomes).toHaveLength(1);
    expect(worker.invocations[0]?.cwd).toBe('/tmp');

    const persisted = JSON.parse(await readFile(join(store.dir, 'run.json'), 'utf8'));
    expect(persisted.id).toBe('run-1');
    expect(await readFile(join(store.dir, 'report.md'), 'utf8')).toBe('hello!');
  });

  it('falls back to the next worker when the first fails', async () => {
    const registry = new WorkerRegistry();
    registry.register(
      new MockWorker({
        id: 'flaky-local',
        costTier: 'free-local',
        respond: () => ({ ok: false, text: '', error: 'boom' }),
      }),
    );
    registry.register(
      new MockWorker({
        id: 'solid-sub',
        costTier: 'subscription',
        respond: () => ({ ok: true, text: 'rescued' }),
      }),
    );

    const record = await orchestrate(task, baseOpts(registry));

    expect(record.status).toBe('done');
    expect(record.report).toBe('rescued');
    const outcome = record.outcomes[0];
    expect(outcome?.workerId).toBe('solid-sub');
    expect(outcome?.attempts).toBe(2);
  });

  // A multi-step prompt so planTask consults the brain instead of the fast path.
  const complexTask: Task = {
    id: 't1',
    prompt: 'find a fact, then use that fact to produce a result',
    cwd: '/tmp',
  };

  it('threads dependency outputs into downstream prompts (brain-planned)', async () => {
    const registry = new WorkerRegistry();
    const worker = new MockWorker({
      id: 'local',
      respond: (inv) => ({
        ok: true,
        text: inv.prompt.includes('FACT-42') ? 'used-dep' : 'FACT-42',
      }),
    });
    registry.register(worker);
    const brain = new Brain(
      new MockWorker({
        id: 'brain',
        respond: (inv) => {
          if (inv.prompt.includes('Decompose')) {
            return {
              ok: true,
              text: JSON.stringify({
                subtasks: [
                  { id: 's1', prompt: 'find the fact', capability: 'reason' },
                  { id: 's2', prompt: 'use the fact', capability: 'reason', dependsOn: ['s1'] },
                ],
              }),
            };
          }
          return { ok: true, text: 'final synthesis' };
        },
      }),
    );

    const record = await orchestrate(complexTask, baseOpts(registry, brain));

    expect(record.plan.subtasks).toHaveLength(2);
    const s2Invocation = worker.invocations.find((inv) => inv.prompt.includes('use the fact'));
    expect(s2Invocation?.prompt).toContain('FACT-42');
    expect(record.report).toBe('final synthesis');
  });

  it('marks the run failed when every subtask fails', async () => {
    const registry = new WorkerRegistry();
    registry.register(
      new MockWorker({ id: 'dead', respond: () => ({ ok: false, text: '', error: 'down' }) }),
    );

    const record = await orchestrate(task, baseOpts(registry));
    expect(record.status).toBe('failed');
  });

  it('tries every capable worker even past maxAttemptsPerSubtask', async () => {
    const registry = new WorkerRegistry();
    // Three broken workers then a good one; maxAttempts=2 must NOT drop the good one.
    for (const id of ['bad1', 'bad2', 'bad3']) {
      registry.register(
        new MockWorker({ id, respond: () => ({ ok: false, text: '', error: 'nope' }) }),
      );
    }
    registry.register(
      new MockWorker({ id: 'good', respond: () => ({ ok: true, text: 'finally' }) }),
    );

    const record = await orchestrate(task, { ...baseOpts(registry), maxAttemptsPerSubtask: 2 });
    expect(record.status).toBe('done');
    expect(record.report).toBe('finally');
    expect(record.outcomes[0]?.workerId).toBe('good');
  });

  it('deprioritizes a worker that failed with an auth error and reports it clearly', async () => {
    const registry = new WorkerRegistry();
    registry.register(
      new MockWorker({
        id: 'no-sub',
        costTier: 'subscription',
        respond: () => ({ ok: false, text: '', error: 'Error: 401 Unauthorized — please login' }),
      }),
    );

    const degraded = new Set<string>();
    const record = await orchestrate(task, { ...baseOpts(registry), degraded });

    expect(record.status).toBe('failed');
    expect(degraded.has('no-sub')).toBe(true);
    expect(record.report).toMatch(/login|quota/i);
  });

  it('rescues a subtask whose capability has no dedicated worker via a generalist', async () => {
    const registry = new WorkerRegistry();
    // No 'web' worker exists; a chat worker should still answer rather than fail.
    registry.register(
      new MockWorker({
        id: 'chat-only',
        capabilities: ['chat'],
        respond: () => ({ ok: true, text: 'here are some news APIs' }),
      }),
    );
    const brain = new Brain(
      new MockWorker({
        id: 'brain',
        respond: () => ({
          ok: true,
          text: JSON.stringify({
            subtasks: [{ id: 's1', prompt: 'latest news', capability: 'web' }],
          }),
        }),
      }),
    );

    const record = await orchestrate(complexTask, baseOpts(registry, brain));
    expect(record.status).toBe('done');
    expect(record.outcomes[0]?.workerId).toBe('chat-only');
    expect(record.report).toBe('here are some news APIs');
  });

  it('fails cleanly when there is no worker at all for a subtask', async () => {
    const registry = new WorkerRegistry();
    // A single web-only worker that fails: no generalist exists to rescue it.
    registry.register(
      new MockWorker({
        id: 'web-only',
        capabilities: ['web'],
        respond: () => ({ ok: false, text: '', error: 'down' }),
      }),
    );
    const brain = new Brain(
      new MockWorker({
        id: 'brain',
        respond: () => ({
          ok: true,
          text: JSON.stringify({
            subtasks: [{ id: 's1', prompt: 'latest news', capability: 'web' }],
          }),
        }),
      }),
    );

    const record = await orchestrate(complexTask, baseOpts(registry, brain));
    expect(record.status).toBe('failed');
  });
});
