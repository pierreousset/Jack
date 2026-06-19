import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Brain } from '../src/brain/brain.js';
import { LearningStore } from '../src/core/learnings.js';
import { reflectOnRun, shouldReflect } from '../src/core/reflect.js';
import type { RunRecord, SubtaskOutcome } from '../src/core/types.js';
import { MockWorker } from '../src/workers/mock.js';

const outcome = (over: Partial<SubtaskOutcome> = {}): SubtaskOutcome => ({
  subtaskId: 's1',
  workerId: 'w',
  decision: { workerId: 'w', reason: '', source: 'rule', fallbacks: [] },
  result: { ok: true, text: 'ok' },
  attempts: 1,
  ...over,
});

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r1',
  task: { id: 'r1', prompt: 'do a thing', cwd: '/tmp' },
  plan: { taskId: 'r1', subtasks: [{ id: 's1', prompt: 'do a thing', capability: 'reason' }] },
  outcomes: [outcome()],
  report: 'ok',
  status: 'done',
  startedAt: '2026-01-01T00:00:00Z',
  finishedAt: '2026-01-01T00:00:10Z',
  ...over,
});

describe('LearningStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jack-learn-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists and reloads learnings', async () => {
    const store = await LearningStore.load(dir);
    await store.add({ at: 'now', task: 't', insight: 'prefer the stronger worker for analysis' });
    const reloaded = await LearningStore.load(dir);
    expect(reloaded.length).toBe(1);
    expect(reloaded.all()[0]?.insight).toMatch(/stronger worker/);
  });

  it('builds a guidance block, capability-relevant first', async () => {
    const store = await LearningStore.load(dir);
    await store.add({ at: '1', task: 't', insight: 'A', capability: 'code-gen' });
    await store.add({ at: '2', task: 't', insight: 'B', capability: 'reason' });
    const block = store.guidanceBlock('reason');
    expect(block).toContain('B');
    expect(block).not.toContain('A'); // code-gen lesson filtered out for a reason task
  });

  it('returns undefined guidance when empty', async () => {
    const store = await LearningStore.load(dir);
    expect(store.guidanceBlock()).toBeUndefined();
  });
});

describe('shouldReflect', () => {
  it('reflects on a failed run', () => {
    expect(shouldReflect(record({ status: 'failed' }))).toBe(true);
  });
  it('reflects when a subtask was escalated', () => {
    expect(shouldReflect(record({ outcomes: [outcome({ escalated: true })] }))).toBe(true);
  });
  it('does not reflect on a clean run', () => {
    expect(shouldReflect(record())).toBe(false);
  });
});

describe('reflectOnRun', () => {
  const brain = new Brain(
    new MockWorker({
      id: 'brain',
      respond: () => ({ ok: true, text: JSON.stringify({ insight: 'route analysis to Opus' }) }),
    }),
  );

  it('returns a learning for a bad run', async () => {
    const learning = await reflectOnRun(record({ status: 'failed' }), brain);
    expect(learning?.insight).toBe('route analysis to Opus');
    expect(learning?.capability).toBe('reason');
  });

  it('returns nothing for a clean run', async () => {
    expect(await reflectOnRun(record(), brain)).toBeUndefined();
  });

  it('returns nothing without a brain', async () => {
    expect(await reflectOnRun(record({ status: 'failed' }), undefined)).toBeUndefined();
  });

  it('returns nothing when the brain finds no lesson (empty insight)', async () => {
    const emptyBrain = new Brain(
      new MockWorker({ id: 'b', respond: () => ({ ok: true, text: '{"insight":""}' }) }),
    );
    expect(await reflectOnRun(record({ status: 'failed' }), emptyBrain)).toBeUndefined();
  });
});
