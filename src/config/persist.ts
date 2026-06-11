/**
 * Persistence helpers for the user-level config file (~/.jack/config.json).
 * Used to remember choices made interactively — e.g. which worker Jack uses
 * as his brain — without clobbering the rest of the file.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USER_CONFIG_DIR = join(homedir(), '.jack');
const USER_CONFIG_PATH = join(USER_CONFIG_DIR, 'config.json');

export async function readUserConfig(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(USER_CONFIG_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function patchUserConfig(patch: Record<string, unknown>): Promise<void> {
  const current = await readUserConfig();
  await mkdir(USER_CONFIG_DIR, { recursive: true });
  await writeFile(USER_CONFIG_PATH, JSON.stringify({ ...current, ...patch }, null, 2));
}

/** The brain the user explicitly chose, if any (undefined = never asked). */
export async function savedBrainChoice(): Promise<string | undefined> {
  const config = await readUserConfig();
  return typeof config.brain === 'string' ? config.brain : undefined;
}

export async function saveBrainChoice(workerId: string): Promise<void> {
  await patchUserConfig({ brain: workerId });
}
