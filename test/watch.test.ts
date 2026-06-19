import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Brain } from '../src/brain/brain.js';
import { interpretConfigAction } from '../src/core/tuning.js';
import { ProposalStore, runWatch } from '../src/core/watch.js';
import { MockWorker } from '../src/workers/mock.js';

describe('ProposalStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jack-prop-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists and reloads proposals', async () => {
    const store = await ProposalStore.load(dir);
    await store.add([
      { at: 'now', kind: 'config', title: 'lower bar', rationale: 'r', action: 'a' },
    ]);
    const reloaded = await ProposalStore.load(dir);
    expect(reloaded.length).toBe(1);
    expect(reloaded.all()[0]?.title).toBe('lower bar');
  });

  it('marks a proposal applied and persists it', async () => {
    const store = await ProposalStore.load(dir);
    await store.add([
      { at: 'now', kind: 'config', title: 'a', rationale: '', action: '' },
      { at: 'now', kind: 'config', title: 'b', rationale: '', action: '' },
    ]);
    await store.setApplied(1);
    const reloaded = await ProposalStore.load(dir);
    expect(reloaded.all()[0]?.applied).toBeUndefined();
    expect(reloaded.all()[1]?.applied).toBe(true);
  });
});

describe('interpretConfigAction', () => {
  const current = { 'routing.qualityBar': 0.7, 'routing.maxAttemptsPerSubtask': 3 };

  it('maps a free-text action to a whitelisted, clamped change', async () => {
    const brain = new Brain(
      new MockWorker({
        id: 'b',
        respond: () => ({ ok: true, text: '{"key":"routing.qualityBar","value":0.6}' }),
      }),
    );
    const s = await interpretConfigAction(brain, 'lower the quality bar a bit', current);
    expect(s).toEqual({
      key: 'routing.qualityBar',
      value: 0.6,
      rationale: 'lower the quality bar a bit',
    });
  });

  it('returns undefined when the action maps to no tunable knob', async () => {
    const brain = new Brain(
      new MockWorker({ id: 'b', respond: () => ({ ok: true, text: '{"key":"","value":0}' }) }),
    );
    expect(await interpretConfigAction(brain, 'add a new worker', current)).toBeUndefined();
  });

  it('rejects a non-whitelisted key', async () => {
    const brain = new Brain(
      new MockWorker({
        id: 'b',
        respond: () => ({ ok: true, text: '{"key":"routing.preferTier","value":1}' }),
      }),
    );
    expect(await interpretConfigAction(brain, 'change tier', current)).toBeUndefined();
  });
});

describe('runWatch', () => {
  const proposalsJson = JSON.stringify({
    proposals: [
      {
        kind: 'config',
        title: 'Try qualityBar 0.6',
        rationale: 'fewer escalations',
        action: 'set qualityBar=0.6',
      },
    ],
  });

  it('researches via the web worker, then distills proposals', async () => {
    const web = new MockWorker({
      id: 'web',
      capabilities: ['web'],
      respond: () => ({ ok: true, text: 'New small model Foo-3B beats prior 7Bs.' }),
    });
    const brain = new Brain(
      new MockWorker({ id: 'brain', respond: () => ({ ok: true, text: proposalsJson }) }),
    );

    const { proposals, findings } = await runWatch({
      brain,
      webWorker: web,
      setupSummary: 'Workers: claude-code',
      area: 'local models',
    });

    expect(findings).toContain('Foo-3B');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.kind).toBe('config');
    expect(proposals[0]?.at).toBeTruthy();
    expect(web.invocations).toHaveLength(1);
  });

  it('still proposes from brain knowledge when no web worker is available', async () => {
    const brain = new Brain(
      new MockWorker({ id: 'brain', respond: () => ({ ok: true, text: proposalsJson }) }),
    );
    const { proposals, findings } = await runWatch({
      brain,
      setupSummary: 'Workers: claude-code',
      area: 'local models',
    });
    expect(findings).toMatch(/no web worker/i);
    expect(proposals).toHaveLength(1);
  });

  it('returns no proposals when the brain output is unparseable', async () => {
    const brain = new Brain(
      new MockWorker({ id: 'brain', respond: () => ({ ok: true, text: 'not json at all' }) }),
    );
    const { proposals } = await runWatch({
      brain,
      setupSummary: 's',
      area: 'a',
    });
    expect(proposals).toHaveLength(0);
  });
});
