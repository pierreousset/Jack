import { describe, expect, it } from 'vitest';
import { Brain, stripMarkdownFences } from '../src/brain/brain.js';
import { classifyCapability, planTask } from '../src/core/planner.js';
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

describe('planTask', () => {
  it('returns a single-subtask plan without a brain', async () => {
    const plan = await planTask(task);
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0]?.capability).toBe('summarize');
  });

  it('uses the brain decomposition when valid', async () => {
    const brain = new Brain(
      new MockWorker({
        id: 'brain',
        respond: () => ({
          ok: true,
          text: '```json\n{"subtasks":[{"id":"s1","prompt":"p1","capability":"reason"},{"id":"s2","prompt":"p2","capability":"summarize","dependsOn":["s1"]}],"rationale":"split"}\n```',
        }),
      }),
    );
    const plan = await planTask(task, brain);
    expect(plan.subtasks).toHaveLength(2);
    expect(plan.subtasks[1]?.dependsOn).toEqual(['s1']);
    expect(plan.rationale).toBe('split');
  });

  it('degrades to single subtask when the brain returns junk', async () => {
    const brain = new Brain(
      new MockWorker({ id: 'brain', respond: () => ({ ok: true, text: 'not json at all' }) }),
    );
    const plan = await planTask(task, brain);
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.rationale).toMatch(/fallback/);
  });
});
