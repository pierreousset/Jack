import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BacklogStore } from '../src/core/backlog.js';

describe('BacklogStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jack-backlog-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('adds topics and lists them as pending', async () => {
    const b = await BacklogStore.load(dir);
    await b.add('research X', 'now');
    await b.add('build Y', 'now');
    expect(b.pending().map((i) => i.topic)).toEqual(['research X', 'build Y']);
  });

  it('skips duplicate pending topics', async () => {
    const b = await BacklogStore.load(dir);
    await b.add('same', 'now');
    await b.add('same', 'now');
    expect(b.pending()).toHaveLength(1);
  });

  it('marks items done/failed and drops them from pending; survives reload', async () => {
    const b = await BacklogStore.load(dir);
    const a = await b.add('a', 'now');
    await b.add('b', 'now');
    await b.mark(a.id, 'done', 'later', 'run-1');

    const reloaded = await BacklogStore.load(dir);
    expect(reloaded.pending().map((i) => i.topic)).toEqual(['b']);
    expect(reloaded.all().find((i) => i.id === a.id)?.status).toBe('done');
    expect(reloaded.all().find((i) => i.id === a.id)?.runId).toBe('run-1');
  });

  it('keeps assigning unique ids after reload', async () => {
    const b = await BacklogStore.load(dir);
    await b.add('a', 'now');
    const reloaded = await BacklogStore.load(dir);
    const second = await reloaded.add('b', 'now');
    expect(second.id).toBe('2');
  });

  it('clears everything', async () => {
    const b = await BacklogStore.load(dir);
    await b.add('a', 'now');
    await b.clear();
    expect(b.all()).toHaveLength(0);
  });
});
