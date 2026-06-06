import { describe, expect, it } from 'vitest';
import { MockWorker } from '../src/workers/mock.js';
import { WorkerRegistry } from '../src/workers/registry.js';

describe('WorkerRegistry', () => {
  it('orders candidates cheapest-first', () => {
    const registry = new WorkerRegistry();
    registry.register(new MockWorker({ id: 'sub', costTier: 'subscription' }));
    registry.register(new MockWorker({ id: 'local', costTier: 'free-local' }));
    registry.register(new MockWorker({ id: 'api', costTier: 'paid-api' }));

    const ids = registry.candidatesFor('reason').map((w) => w.id);
    expect(ids).toEqual(['local', 'sub', 'api']);
  });

  it('puts the preferred tier first', () => {
    const registry = new WorkerRegistry();
    registry.register(new MockWorker({ id: 'local', costTier: 'free-local' }));
    registry.register(new MockWorker({ id: 'sub', costTier: 'subscription' }));

    const ids = registry.candidatesFor('reason', 'subscription').map((w) => w.id);
    expect(ids).toEqual(['sub', 'local']);
  });

  it('filters by capability', () => {
    const registry = new WorkerRegistry();
    registry.register(new MockWorker({ id: 'coder', capabilities: ['code-edit'] }));
    registry.register(new MockWorker({ id: 'talker', capabilities: ['chat'] }));

    expect(registry.candidatesFor('code-edit').map((w) => w.id)).toEqual(['coder']);
    expect(registry.candidatesFor('web')).toEqual([]);
  });

  it('rejects duplicate ids and finds the brain', () => {
    const registry = new WorkerRegistry();
    registry.register(new MockWorker({ id: 'a', role: 'brain' }));
    expect(() => registry.register(new MockWorker({ id: 'a' }))).toThrow(/already registered/);
    expect(registry.brain()?.id).toBe('a');
  });
});
