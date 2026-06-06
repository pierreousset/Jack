import { z } from 'zod';

const cliWorkerSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.string().optional(),
  extraArgs: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().optional(),
});

const localWorkerSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string().url(),
  model: z.string(),
  id: z.string().optional(),
  apiKey: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const jackConfigSchema = z.object({
  /** Worker id used for planning/routing decisions. */
  brain: z.string().default('claude-code'),
  workers: z
    .object({
      'claude-code': cliWorkerSchema.default({}),
      codex: cliWorkerSchema.default({}),
      gemini: cliWorkerSchema.default({}),
      /** Any number of OpenAI-compatible local servers (Ollama, LM Studio). */
      local: z.array(localWorkerSchema).default([]),
    })
    .default({}),
  routing: z
    .object({
      /** Tier the router should try first when several workers qualify. */
      preferTier: z.enum(['free-local', 'subscription', 'paid-api']).default('free-local'),
      maxConcurrency: z.number().int().positive().default(3),
      maxAttemptsPerSubtask: z.number().int().positive().default(3),
    })
    .default({}),
  runsDir: z.string().default('./jack-runs'),
});

export type JackConfig = z.infer<typeof jackConfigSchema>;
export type CliWorkerConfig = z.infer<typeof cliWorkerSchema>;
export type LocalWorkerConfig = z.infer<typeof localWorkerSchema>;
