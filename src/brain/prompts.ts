/**
 * Prompt templates for Jack's brain (planning / routing decisions).
 * Every prompt must be self-contained and demand strict JSON output.
 */
import type { Capability } from '../workers/worker.js';

export const CAPABILITIES: Capability[] = [
  'code-edit',
  'code-gen',
  'reason',
  'summarize',
  'chat',
  'web',
];

export function planningPrompt(taskPrompt: string, context?: string): string {
  const contextSection = context
    ? `
Recent conversation between the user and Jack (the task below may refer to it — resolve any references like "it"/"the previous one" so subtask prompts are explicit):
"""
${context}
"""
`
    : '';
  return `You are Jack, an AI task orchestrator. Decompose the user's task into the SMALLEST useful number of subtasks (1 is fine for simple tasks, rarely more than 4).

Each subtask gets a capability tag among: ${CAPABILITIES.join(', ')}.
- "code-edit": must read/modify files in the working directory
- "code-gen": writes standalone code (no repo context needed)
- "reason": analysis, planning, architecture, complex decisions
- "summarize": condensing/reformulating/translating text
- "chat": simple conversational answer
- "web": needs up-to-date information from the web

Subtasks may depend on earlier subtasks via "dependsOn" (use the subtask ids).
Each subtask prompt must be SELF-CONTAINED: a worker sees only that prompt (plus the outputs of its dependencies, appended automatically).
${contextSection}
User task:
"""
${taskPrompt}
"""

Respond with ONLY a JSON object, no markdown fences, shaped exactly like:
{"subtasks":[{"id":"s1","prompt":"...","capability":"reason","dependsOn":[]}],"rationale":"one short sentence"}`;
}

export function routingPrompt(
  subtaskPrompt: string,
  capability: Capability,
  candidates: Array<{ id: string; name: string; costTier: string }>,
): string {
  return `You are Jack, an AI task router. Pick the best worker for this subtask, biased toward cheaper tiers when quality allows (free-local < subscription < paid-api).

Subtask (capability: ${capability}):
"""
${subtaskPrompt}
"""

Workers available:
${candidates.map((c) => `- id: ${c.id} | ${c.name} | tier: ${c.costTier}`).join('\n')}

Respond with ONLY a JSON object, no markdown fences:
{"workerId":"<one of the ids above>","reason":"one short sentence"}`;
}

export function judgePrompt(taskPrompt: string, output: string, capability: Capability): string {
  return `You are Jack's quality gate. Judge how well the WORKER OUTPUT satisfies the TASK. Be strict and concise.

Task (capability: ${capability}):
"""
${taskPrompt}
"""

Worker output:
"""
${output}
"""

Score from 0.0 to 1.0:
- 1.0 = fully correct, complete, directly usable
- 0.7 = good, only minor gaps
- 0.5 = partially useful but incomplete or uncertain
- 0.0 = wrong, empty, evasive, or off-topic
If the output refuses, stalls, hallucinates, or stays vague where specifics were required, score below 0.5.

Respond with ONLY a JSON object, no markdown fences:
{"score":0.0,"reason":"one short sentence"}`;
}

export function synthesisPrompt(
  taskPrompt: string,
  outputs: Array<{ subtaskId: string; text: string }>,
  context?: string,
): string {
  const contextSection = context
    ? `
Recent conversation with the user (for reference):
"""
${context}
"""
`
    : '';
  return `You are Jack, an AI orchestrator. Several workers completed subtasks of the user's task. Write the final consolidated answer for the user. Be direct, keep it as short as the task allows, do not mention the orchestration machinery.
${contextSection}
Original task:
"""
${taskPrompt}
"""

Subtask outputs:
${outputs.map((o) => `--- ${o.subtaskId} ---\n${o.text}`).join('\n\n')}

Final answer:`;
}
