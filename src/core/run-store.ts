/**
 * Run persistence: every run gets a directory under `runsDir`
 * (default ./jack-runs/<id>/) with task.json, plan.json, per-subtask logs
 * and the final report.md — so runs are inspectable and debuggable.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan, RunRecord, SubtaskOutcome, Task } from './types.js';

export class RunStore {
  private constructor(
    readonly runId: string,
    readonly dir: string,
  ) {}

  static async create(runsDir: string, runId: string): Promise<RunStore> {
    const dir = join(runsDir, runId);
    await mkdir(join(dir, 'subtasks'), { recursive: true });
    return new RunStore(runId, dir);
  }

  async saveTask(task: Task): Promise<void> {
    await writeFile(join(this.dir, 'task.json'), JSON.stringify(task, null, 2));
  }

  async savePlan(plan: Plan): Promise<void> {
    await writeFile(join(this.dir, 'plan.json'), JSON.stringify(plan, null, 2));
  }

  async appendSubtaskLog(subtaskId: string, text: string): Promise<void> {
    await appendFile(join(this.dir, 'subtasks', `${subtaskId}.log`), text);
  }

  async saveOutcome(outcome: SubtaskOutcome): Promise<void> {
    await writeFile(
      join(this.dir, 'subtasks', `${outcome.subtaskId}.json`),
      JSON.stringify(outcome, null, 2),
    );
  }

  async saveRecord(record: RunRecord): Promise<void> {
    await writeFile(join(this.dir, 'run.json'), JSON.stringify(record, null, 2));
    await writeFile(join(this.dir, 'report.md'), record.report);
  }
}

export function newRunId(): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}
