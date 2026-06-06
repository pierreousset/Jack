/**
 * Config loading and registry assembly.
 *
 * Precedence: built-in defaults < ~/.jack/config.json < ./jack.config.json.
 * After merging, the registry is built from the config plus environment
 * auto-detection: CLI workers are only registered when found on PATH, and
 * detected local servers are added automatically when no local worker is
 * configured explicitly.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeWorker } from '../workers/claude-code.js';
import { CodexWorker } from '../workers/codex.js';
import { GeminiWorker } from '../workers/gemini.js';
import { LocalOpenAiWorker } from '../workers/local-openai.js';
import { WorkerRegistry } from '../workers/registry.js';
import { type Detection, detectEnvironment } from './detect.js';
import { type JackConfig, jackConfigSchema } from './schema.js';

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`invalid JSON in config file ${path}: ${err.message}`);
    }
    return undefined; // file missing — fine
  }
}

function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prev = out[key];
    if (
      value &&
      prev &&
      typeof value === 'object' &&
      typeof prev === 'object' &&
      !Array.isArray(value) &&
      !Array.isArray(prev)
    ) {
      out[key] = deepMerge(prev as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

export async function loadConfig(cwd: string = process.cwd()): Promise<JackConfig> {
  const userConfig = await readJsonIfExists(join(homedir(), '.jack', 'config.json'));
  const projectConfig = await readJsonIfExists(join(cwd, 'jack.config.json'));
  let merged: Record<string, unknown> = {};
  if (userConfig) merged = deepMerge(merged, userConfig);
  if (projectConfig) merged = deepMerge(merged, projectConfig);
  return jackConfigSchema.parse(merged);
}

export interface BuiltRegistry {
  registry: WorkerRegistry;
  detection: Detection;
}

export async function buildRegistry(config: JackConfig): Promise<BuiltRegistry> {
  const detection = await detectEnvironment();
  const registry = new WorkerRegistry();

  const found = new Map(detection.clis.map((c) => [c.id, c.found]));

  if (config.workers['claude-code'].enabled && found.get('claude-code')) {
    registry.register(new ClaudeCodeWorker(config.workers['claude-code']));
  }
  if (config.workers.codex.enabled && found.get('codex')) {
    registry.register(new CodexWorker(config.workers.codex));
  }
  if (config.workers.gemini.enabled && found.get('gemini')) {
    registry.register(new GeminiWorker(config.workers.gemini));
  }

  if (config.workers.local.length > 0) {
    for (const local of config.workers.local) {
      if (local.enabled) registry.register(new LocalOpenAiWorker(local));
    }
  } else {
    // Zero-config: register the first model of each detected local server.
    for (const server of detection.localServers) {
      const model = server.models[0];
      if (server.up && model) {
        registry.register(
          new LocalOpenAiWorker({
            baseUrl: server.baseUrl,
            model,
            id: `${server.label}:${model}`,
            name: `${server.label} (${model})`,
          }),
        );
      }
    }
  }

  return { registry, detection };
}
