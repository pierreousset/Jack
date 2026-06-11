import { describe, expect, it } from 'vitest';
import { Brain, stripMarkdownFences } from '../src/brain/brain.js';
import { classifyCapability, looksSimple, planTask } from '../src/core/planner.js';
import type { Task } from '../src/core/types.js';
import { MockWorker } from '../src/workers/mock.js';

const task: Task = { id: 't1', prompt: 'summarize this article', cwd: '/tmp' };

describe('classifyCapability', () => {
  it('detects code-edit', () => {
    expect(classifyCapability('fix the bug in this repo')).toBe('code-edit');
  });
  it('detects summarize', () => {
    expect(classifyCapability('summarize this article')).toBe('summarize');
  });
  it('detects reason', () => {
    expect(classifyCapability('compare these two architectures')).toBe('reason');
  });
  it('defaults to chat', () => {
    expect(classifyCapability('hello there')).toBe('chat');
  });
});

describe('stripMarkdownFences', () => {
  it('unwraps ```json fences', () => {
    expect(stripMarkdownFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('leaves plain text untouched', () => {
    expect(stripMarkdownFences('{"a":1}')).toBe('{"a":1}');
  });
});

describe('looksSimple', () => {
  it('is true for greetings and one-liners', () => {
    expect(looksSimple('Salut')).toBe(true);
    expect(looksSimple('where can I find a news API?')).toBe(true);
  });
  it('is false for multi-step or structured input', () => {
    expect(looksSimple('do X, then do Y and finally Z')).toBe(false);
    expect(looksSimple('line one\nline two')).toBe(false);
    expect(looksSimple(`a ${'word '.repeat(40)}`)).toBe(false);
  });
});

describe('planTask', () => {
  it('returns a single-subtask plan without a brain', async () => {
    const plan = await planTask(task);
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0]?.capability).toBe('summarize');
  });

  it('uses the brain decomposition for a complex multi-step task', async () => {
    const complex: Task = {
      id: 't2',
      prompt: 'research the top web frameworks, then summarize the trade-offs and recommend one',
      cwd: '/tmp',
    };
    const brain = new Brain(
      new MockWorker({
        id: 'brain',
        respond: () => ({
          ok: true,
          text: '```json\n{"subtasks":[{"id":"s1","prompt":"p1","capability":"reason"},{"id":"s2","prompt":"p2","capability":"summarize","dependsOn":["s1"]}],"rationale":"split"}\n```',
        }),
      }),
    );
    const plan = await planTask(complex, brain);
    expect(plan.subtasks).toHaveLength(2);
    expect(plan.subtasks[1]?.dependsOn).toEqual(['s1']);
    expect(plan.rationale).toBe('split');
  });

  it('takes the fast path (no brain call) for simple input', async () => {
    const brain = new Brain(
      new MockWorker({
        id: 'brain',
        respond: () => {
          throw new Error('brain should not be called on the fast path');
        },
      }),
    );
    const plan = await planTask({ id: 't3', prompt: 'Salut', cwd: '/tmp' }, brain);
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.rationale).toMatch(/fast path/);
  });

  it('degrades to single subtask when the brain returns junk', async () => {
    const complex: Task = {
      id: 't4',
      prompt: 'research X, then compare the options and recommend the best one',
      cwd: '/tmp',
    };
    const brain = new Brain(
      new MockWorker({ id: 'brain', respond: () => ({ ok: true, text: 'not json at all' }) }),
    );
    const plan = await planTask(complex, brain);
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.rationale).toMatch(/fallback/);
  });
});
