/**
 * Self-tuning: Jack adjusts his OWN config knobs (never code), measures the
 * quality score before vs. after, and rolls back automatically if it regresses.
 * This closes the self-improvement loop — watch proposes, tune applies, the
 * quality gate measures, and a bad change is undone on its own.
 *
 * Safety rails: only whitelisted numeric knobs, clamped to bounds; a rollback
 * needs a real baseline; and the trial needs enough scored runs before any
 * verdict. The store is pure — the CLI performs the config writes it returns.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Brain } from '../brain/brain.js';
import { applyConfigPrompt, tuningPrompt } from '../brain/prompts.js';
import type { RunRecord } from './types.js';

export interface TunableSpec {
  kind: 'number' | 'int';
  min: number;
  max: number;
}

/** The only knobs self-tuning may touch. Anything else is rejected. */
export const TUNABLE: Record<string, TunableSpec> = {
  'routing.qualityBar': { kind: 'number', min: 0, max: 1 },
  'routing.maxAttemptsPerSubtask': { kind: 'int', min: 1, max: 6 },
  'selfImprove.maxGuidance': { kind: 'int', min: 0, max: 15 },
};

export interface Experiment {
  id: string;
  at: string;
  key: string;
  from: number;
  to: number;
  rationale: string;
  baselineAvg: number;
  baselineN: number;
  trialScores: number[];
  minSamples: number;
  status: 'active' | 'kept' | 'rolledback';
  decidedAt?: string;
  verdict?: string;
}

interface TuningState {
  recentScores: number[];
  active: Experiment | null;
  history: Experiment[];
}

const WINDOW = 20;

/** A run's representative quality score: the mean of its scored subtasks, or undefined. */
export function runScore(record: RunRecord): number | undefined {
  const scores = record.outcomes.map((o) => o.score).filter((s): s is number => s !== undefined);
  if (scores.length === 0) return undefined;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/** Validate + clamp a proposed value for a tunable key. Returns null if invalid. */
export function normalizeValue(key: string, value: number): number | null {
  const spec = TUNABLE[key];
  if (!spec || typeof value !== 'number' || !Number.isFinite(value)) return null;
  let v = Math.max(spec.min, Math.min(spec.max, value));
  if (spec.kind === 'int') v = Math.round(v);
  return v;
}

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const tuneSchema = z.object({
  key: z.string(),
  value: z.coerce.number(),
  rationale: z.string().optional(),
});

export interface TuneSuggestion {
  key: string;
  value: number;
  rationale: string;
}

/** Bullet list of tunable knobs with bounds and current values, for prompts. */
function currentValuesBlock(current: Record<string, number>): string {
  return Object.keys(TUNABLE)
    .map((k) => {
      const spec = TUNABLE[k] as TunableSpec;
      return `- ${k} (${spec.min}–${spec.max}, now ${current[k]})`;
    })
    .join('\n');
}

/** Validate a brain-suggested {key,value} against the whitelist + bounds. */
function validateSuggestion(
  parsed: { key: string; value: number; rationale?: string },
  current: Record<string, number>,
  fallbackRationale: string,
): TuneSuggestion | undefined {
  if (!parsed.key) return undefined;
  const value = normalizeValue(parsed.key, parsed.value);
  if (value === null || value === current[parsed.key]) return undefined;
  return { key: parsed.key, value, rationale: parsed.rationale ?? fallbackRationale };
}

/**
 * Ask the brain for ONE config change from the whitelist, given current values
 * and recent stats. Returns undefined if the brain declines, the key isn't
 * tunable, or the value is out of bounds / unchanged. Never throws.
 */
export async function proposeTuning(
  brain: Brain,
  current: Record<string, number>,
  stats: string,
): Promise<TuneSuggestion | undefined> {
  try {
    const parsed = tuneSchema.parse(
      await brain.askJson<unknown>(tuningPrompt(currentValuesBlock(current), stats)),
    );
    return validateSuggestion(parsed, current, '');
  } catch {
    return undefined;
  }
}

/**
 * Map a free-text proposal action (from `jack watch`) to a concrete whitelisted
 * config change. Returns undefined when it maps to no tunable knob. Never throws.
 */
export async function interpretConfigAction(
  brain: Brain,
  action: string,
  current: Record<string, number>,
): Promise<TuneSuggestion | undefined> {
  try {
    const parsed = tuneSchema.parse(
      await brain.askJson<unknown>(applyConfigPrompt(action, currentValuesBlock(current))),
    );
    return validateSuggestion(parsed, current, action);
  } catch {
    return undefined;
  }
}

export class TuningStore {
  private constructor(
    private readonly path: string,
    private state: TuningState,
  ) {}

  static async load(runsDir: string): Promise<TuningStore> {
    const path = join(runsDir, 'tuning.json');
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return new TuningStore(path, {
          recentScores: Array.isArray(parsed.recentScores) ? parsed.recentScores : [],
          active: parsed.active ?? null,
          history: Array.isArray(parsed.history) ? parsed.history : [],
        });
      }
    } catch {
      // fresh
    }
    return new TuningStore(path, { recentScores: [], active: null, history: [] });
  }

  get active(): Experiment | null {
    return this.state.active;
  }

  history(): Experiment[] {
    return [...this.state.history];
  }

  /** Baseline = mean of the recent rolling window of run scores. */
  baseline(): { avg: number; n: number } {
    return { avg: avg(this.state.recentScores), n: this.state.recentScores.length };
  }

  async startExperiment(exp: Experiment): Promise<void> {
    this.state.active = exp;
    await this.persist();
  }

  /**
   * Feed one run's score in. Returns a resolution when an active experiment has
   * gathered enough samples to judge — the CLI then applies the rollback (or
   * keeps the change) and tells the user.
   */
  async recordRunScore(
    score: number | undefined,
    margin: number,
  ): Promise<{ experiment: Experiment; rollback: boolean } | undefined> {
    if (score === undefined) return undefined;
    this.state.recentScores.push(score);
    if (this.state.recentScores.length > WINDOW) this.state.recentScores.shift();

    const exp = this.state.active;
    if (!exp) {
      await this.persist();
      return undefined;
    }
    exp.trialScores.push(score);
    if (exp.trialScores.length < exp.minSamples) {
      await this.persist();
      return undefined;
    }

    // Decide. Roll back only with a real baseline and a clear regression.
    const trialAvg = avg(exp.trialScores);
    const rollback = exp.baselineN >= 2 && trialAvg < exp.baselineAvg - margin;
    exp.status = rollback ? 'rolledback' : 'kept';
    exp.verdict = `trial avg ${trialAvg.toFixed(2)} vs baseline ${exp.baselineAvg.toFixed(2)} over ${exp.trialScores.length} run(s)`;
    this.state.history.push(exp);
    this.state.active = null;
    await this.persist();
    return { experiment: exp, rollback };
  }

  /** Manually abort the active experiment (caller restores config to `from`). */
  async abortActive(): Promise<Experiment | undefined> {
    const exp = this.state.active;
    if (!exp) return undefined;
    exp.status = 'rolledback';
    exp.verdict = 'manually aborted';
    this.state.history.push(exp);
    this.state.active = null;
    await this.persist();
    return exp;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.state, null, 2));
  }
}
