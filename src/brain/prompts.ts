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

export function planningPrompt(taskPrompt: string, context?: string, guidance?: string): string {
  const contextSection = context
    ? `
Recent conversation between the user and Jack (the task below may refer to it — resolve any references like "it"/"the previous one" so subtask prompts are explicit):
"""
${context}
"""
`
    : '';
  const guidanceSection = guidance
    ? `
Lessons from past runs — apply them when decomposing:
${guidance}
`
    : '';
  return `You are Jack, an AI task orchestrator. Decompose the user's task into the SMALLEST useful number of subtasks (1 is fine for simple tasks, rarely more than 4).
${guidanceSection}

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

export function reflectionPrompt(
  taskPrompt: string,
  whatHappened: string,
  context?: string,
): string {
  const contextSection = context
    ? `
Recent conversation (for reference):
"""
${context}
"""
`
    : '';
  return `You are Jack reviewing one of your own runs that did NOT go smoothly (it failed, or a weak first answer had to be escalated). Extract ONE concrete, reusable lesson that would make the NEXT run on a similar task go better — about decomposition, which worker to trust, or how to phrase the work. Make it a directive Jack can act on, not a vague platitude. If there is genuinely nothing useful to learn, say so with an empty insight.
${contextSection}
Task:
"""
${taskPrompt}
"""

What happened:
"""
${whatHappened}
"""

Respond with ONLY a JSON object, no markdown fences:
{"insight":"one actionable sentence, or empty string if nothing useful"}`;
}

export function tuningPrompt(currentValues: string, stats: string): string {
  return `You are Jack tuning your OWN config to improve answer quality without raising cost much. Propose ONE small change to a single knob from the list below, or none if things look fine.

Tunable knobs (bounds, current value, effect):
${currentValues}
- routing.qualityBar: higher = stricter gate, more escalations → better quality but more cost; lower = cheaper, more first-answers accepted.
- routing.maxAttemptsPerSubtask: how many workers to try before giving up.
- selfImprove.maxGuidance: how many past lessons to inject into each run.

Recent performance:
"""
${stats}
"""

Make a SMALL, sensible move (e.g. ±0.05 on qualityBar). Respond with ONLY a JSON object, no markdown fences:
{"key":"routing.qualityBar","value":0.65,"rationale":"one short sentence"}
or, if nothing should change: {"key":"","value":0,"rationale":"why it's fine"}`;
}

export function applyConfigPrompt(action: string, currentValues: string): string {
  return `A self-improvement proposal suggests this change to Jack's config: "${action}"
Map it to EXACTLY ONE tunable knob with a concrete new value, or none if it does not correspond to any tunable knob below.

Tunable knobs (bounds, current value):
${currentValues}

Respond with ONLY a JSON object, no markdown fences:
{"key":"routing.qualityBar","value":0.6}
or, if it maps to no tunable knob: {"key":"","value":0}`;
}

export function watchResearchPrompt(area: string): string {
  return `Search for NOTABLE, RECENT, CONCRETE developments (last few months) in: ${area}.
Focus on things a multi-worker AI orchestrator could actually adopt: new or improved models (esp. small/local ones), agent techniques, routing/evaluation methods, prompting tricks, useful tools or CLIs.
List the specific findings with a one-line "why it matters" each. Skip vague hype and anything you can't name concretely.`;
}

export function watchProposalPrompt(area: string, findings: string, setup: string): string {
  return `You are Jack improving himself. Given recent AI developments and Jack's CURRENT setup, propose concrete, safe improvements Jack could make to his OWN system. Prefer cheap, low-risk changes (prompt/config tweaks) over big ones. Only propose things grounded in the findings or clearly useful for the setup. It is fine to return few or zero proposals.

Focus area: ${area}

Recent findings:
"""
${findings}
"""

Jack's current setup:
"""
${setup}
"""

Each proposal has:
- "kind": one of model | worker | prompt | config | technique
- "title": short
- "rationale": why it helps Jack specifically (one sentence)
- "action": the concrete change to make (one sentence)

Respond with ONLY a JSON object, no markdown fences:
{"proposals":[{"kind":"config","title":"...","rationale":"...","action":"..."}]}`;
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
