import { describe, expect, it } from 'vitest';
import { runCli, tolerantJsonParse } from '../src/workers/subprocess.js';

describe('tolerantJsonParse', () => {
  it('parses clean JSON', () => {
    expect(tolerantJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses the last JSON object after log noise', () => {
    const noisy = 'starting up...\nsome log line\n{"type":"result","result":"hi"}';
    expect(tolerantJsonParse(noisy)).toEqual({ type: 'result', result: 'hi' });
  });

  it('returns undefined for non-JSON', () => {
    expect(tolerantJsonParse('just text')).toBeUndefined();
  });
});

describe('runCli', () => {
  it('captures stdout and exit code', async () => {
    const run = await runCli({ cmd: 'node', args: ['-e', 'console.log("out")'] });
    expect(run.ok).toBe(true);
    expect(run.stdout.trim()).toBe('out');
    expect(run.exitCode).toBe(0);
  });

  it('reports failure with stderr', async () => {
    const run = await runCli({
      cmd: 'node',
      args: ['-e', 'console.error("bad"); process.exit(2)'],
    });
    expect(run.ok).toBe(false);
    expect(run.exitCode).toBe(2);
    expect(run.error).toContain('bad');
  });

  it('enforces the timeout', async () => {
    const run = await runCli({
      cmd: 'node',
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      timeoutMs: 200,
    });
    expect(run.ok).toBe(false);
    expect(run.error).toMatch(/timed out/);
  });

  it('fails cleanly when the command does not exist', async () => {
    const run = await runCli({ cmd: 'definitely-not-a-real-cmd-xyz', args: [] });
    expect(run.ok).toBe(false);
    expect(run.error).toBeTruthy();
  });

  it('streams chunks', async () => {
    const chunks: string[] = [];
    await runCli({
      cmd: 'node',
      args: ['-e', 'process.stdout.write("a"); process.stdout.write("b")'],
      onChunk: (text) => chunks.push(text),
    });
    expect(chunks.join('')).toBe('ab');
  });
});
