/**
 * Auto-detection of available workers on this machine: subscription CLIs on
 * PATH, and OpenAI-compatible local servers (Ollama :11434, LM Studio :1234).
 * This is what makes `jack doctor` and zero-config startup work.
 */
import { runCli } from '../workers/subprocess.js';

export interface DetectedCli {
  id: 'claude-code' | 'codex' | 'gemini';
  command: string;
  found: boolean;
  version?: string;
}

export interface DetectedLocalServer {
  baseUrl: string;
  label: 'ollama' | 'lm-studio';
  up: boolean;
  models: string[];
}

export interface Detection {
  clis: DetectedCli[];
  localServers: DetectedLocalServer[];
}

const CLI_PROBES: Array<{ id: DetectedCli['id']; command: string }> = [
  { id: 'claude-code', command: 'claude' },
  { id: 'codex', command: 'codex' },
  { id: 'gemini', command: 'gemini' },
];

const LOCAL_PROBES: Array<{ baseUrl: string; label: DetectedLocalServer['label'] }> = [
  { baseUrl: 'http://localhost:11434/v1', label: 'ollama' },
  { baseUrl: 'http://localhost:1234/v1', label: 'lm-studio' },
];

async function probeCli(probe: { id: DetectedCli['id']; command: string }): Promise<DetectedCli> {
  const run = await runCli({ cmd: probe.command, args: ['--version'], timeoutMs: 15_000 });
  return {
    id: probe.id,
    command: probe.command,
    found: run.ok,
    version: run.ok ? run.stdout.trim().split('\n')[0] : undefined,
  };
}

async function probeLocal(probe: {
  baseUrl: string;
  label: DetectedLocalServer['label'];
}): Promise<DetectedLocalServer> {
  try {
    const res = await fetch(`${probe.baseUrl}/models`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return { ...probe, up: false, models: [] };
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (data.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
    return { ...probe, up: true, models };
  } catch {
    return { ...probe, up: false, models: [] };
  }
}

export async function detectEnvironment(): Promise<Detection> {
  const [clis, localServers] = await Promise.all([
    Promise.all(CLI_PROBES.map(probeCli)),
    Promise.all(LOCAL_PROBES.map(probeLocal)),
  ]);
  return { clis, localServers };
}
