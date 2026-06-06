import { describe, expect, it } from 'vitest';
import { Brain } from '../src/brain/brain.js';
import { routeSubtask } from '../src/core/router.js';
import type { Subtask } from '../src/core/types.js';
import { MockWorker } from '../src/workers/mock.js';
import { WorkerRegistry } from '../src/workers/registry.js';

const subtask = (overrides: Partial<Subtask> = {}): Subtask => ({
  id: 's1',
  prompt: 'do something',
  capability: 'summarize',
  ...overrides,
});

describe('routeSubtask', () => {
  it('throws when no worker matches the capability', async () => {
    const registry = new WorkerRegistry();
    registry.register(new MockWorker({ id: 'coder', capabilities: ['code-edit'] }));
    await expect(
      routeSubtask(subtask({ capability: 'web' }), registry, { preferTier: 'free-local' }),
    ).rejects.toThrow(/no worker available/);
  });

  it('picks the cheapest candidate via rules and lists fallbacks', async () => {
    const registry = new WorkerRegistry();
    registry.register(new MockWorker({ id: 'sub', costTier: 'subscription' }));
    registry.register(new MockWorker({ id: 'local', costTier: 'free-local' }));

    const decision = await routeSubtask(subtask(), registry, { preferTier: 'free-local' });
    expect(decision.source).toBe('rule');
    expect(decision.workerId).toBe('local');
    expect(decision.fallbacks).toEqual(['sub']);
  });

  it('asks the brain on ambiguous capabilities and respects its choice', async () => {
    const registry = new WorkerRegistry();
    registry.register(new MockWorker({ id: 'local', costTier: 'free-local' }));
    registry.register(new MockWorker({ id: 'sub', costTier: 'subscription' }));
    const brain = new Brain(
      new MockWorker({
        id: 'brain',
        respond: () => ({ ok: true, text: '{"workerId":"sub","reason":"hard task"}' }),
      }),
    );

    const decision = await routeSubtask(subtask({ capability: 'reason' }), registry, {
      preferTier: 'free-local',
      brain,
    });
    expect(decision.source).toBe('brain');
    expect(decision.workerId).toBe('sub');
    expect(decision.fallbacks).toEqual(['local']);
  });

  it('falls back to the rule decision when the brain hallucinates an id', async () => {
    const registry = new WorkerRegistry();
    registry.register(new MockWorker({ id: 'local', costTier: 'free-local' }));
    registry.register(new MockWorker({ id: 'sub', costTier: 'subscription' }));
    const brain = new Brain(
      new MockWorker({
        id: 'brain',
        respond: () => ({ ok: true, text: '{"workerId":"nope"}' }),
      }),
    );

    const decision = await routeSubtask(subtask({ capability: 'reason' }), registry, {
      preferTier: 'free-local',
      brain,
    });
    expect(decision.source).toBe('rule');
    expect(decision.workerId).toBe('local');
  });

  it('falls back to rules when the brain errors', async () => {
    const registry = new WorkerRegistry();
    registry.register(new MockWorker({ id: 'local', costTier: 'free-local' }));
    registry.register(new MockWorker({ id: 'sub', costTier: 'subscription' }));
    const brain = new Brain(
      new MockWorker({ id: 'brain', respond: () => ({ ok: false, text: '', error: 'down' }) }),
    );

    const decision = await routeSubtask(subtask({ capability: 'reason' }), registry, {
      preferTier: 'free-local',
      brain,
    });
    expect(decision.source).toBe('rule');
  });
});
