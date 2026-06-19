import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Experiment, TuningStore, normalizeValue, runScore } from '../src/core/tuning.js';
import type { RunRecord, SubtaskOutcome } from '../src/core/types.js';

describe('normalizeValue', () => {
  it('clamps to bounds and rounds ints', () => {
    expect(normalizeValue('routing.qualityBar', 1.5)).toBe(1);
    expect(normalizeValue('routing.qualityBar', -1)).toBe(0);
    expect(normalizeValue('routing.maxAttemptsPerSubtask', 3.7)).toBe(4);
  });
  it('rejects unknown keys and non-numbers', () => {
    expect(normalizeValue('routing.preferTier', 1)).toBeNull();
    expect(normalizeValue('routing.qualityBar', Number.NaN)).toBeNull();
  });
});

describe('runScore', () => {
  const out = (score?: number): SubtaskOutcome => ({
    subtaskId: 's',
    workerId: 'w',
    decision: { workerId: 'w', reason: '', source: 'rule', fallbacks: [] },
    result: { ok: true, text: 'x' },
    attempts: 1,
    score,
  });
  const rec = (outcomes: SubtaskOutcome[]): RunRecord => ({
    id: 'r',
    task: { id: 'r', prompt: 'p', cwd: '/tmp' },
    plan: { taskId: 'r', subtasks: [] },
    outcomes,
    report: '',
    status: 'done',
    startedAt: 'x',
  });

  it('averages scored subtasks, undefined when none', () => {
    expect(runScore(rec([out(0.8), out(0.6)]))).toBeCloseTo(0.7);
    expect(runScore(rec([out(undefined)]))).toBeUndefined();
  });
});

describe('TuningStore experiment lifecycle', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jack-tune-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const exp = (over: Partial<Experiment> = {}): Experiment => ({
    id: 'e1',
    at: 'now',
    key: 'routing.qualityBar',
    from: 0.7,
    to: 0.6,
    rationale: 'cheaper',
    baselineAvg: 0.8,
    baselineN: 5,
    trialScores: [],
    minSamples: 3,
    status: 'active',
    ...over,
  });

  it('waits for minSamples before deciding', async () => {
    const store = await TuningStore.load(dir);
    await store.startExperiment(exp());
    expect(await store.recordRunScore(0.5, 0.05)).toBeUndefined();
    expect(await store.recordRunScore(0.5, 0.05)).toBeUndefined();
    expect(store.active).not.toBeNull();
  });

  it('rolls back when the trial regresses past the margin', async () => {
    const store = await TuningStore.load(dir);
    await store.startExperiment(exp({ baselineAvg: 0.85, baselineN: 5, minSamples: 3 }));
    await store.recordRunScore(0.5, 0.05);
    await store.recordRunScore(0.5, 0.05);
    const res = await store.recordRunScore(0.5, 0.05);
    expect(res?.rollback).toBe(true);
    expect(res?.experiment.status).toBe('rolledback');
    expect(store.active).toBeNull();
  });

  it('keeps the change when quality holds', async () => {
    const store = await TuningStore.load(dir);
    await store.startExperiment(exp({ baselineAvg: 0.8, baselineN: 5, minSamples: 3 }));
    await store.recordRunScore(0.82, 0.05);
    await store.recordRunScore(0.85, 0.05);
    const res = await store.recordRunScore(0.83, 0.05);
    expect(res?.rollback).toBe(false);
    expect(res?.experiment.status).toBe('kept');
  });

  it('never rolls back without a real baseline', async () => {
    const store = await TuningStore.load(dir);
    await store.startExperiment(exp({ baselineAvg: 0, baselineN: 0, minSamples: 2 }));
    await store.recordRunScore(0.1, 0.05);
    const res = await store.recordRunScore(0.1, 0.05);
    expect(res?.rollback).toBe(false); // no baseline → keep, don't undo blindly
  });

  it('feeds the rolling baseline window from run scores', async () => {
    const store = await TuningStore.load(dir);
    await store.recordRunScore(0.6, 0.05);
    await store.recordRunScore(0.8, 0.05);
    expect(store.baseline()).toEqual({ avg: 0.7, n: 2 });
  });
});
