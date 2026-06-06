# Jack 🎩

**Route AI tasks to the subscriptions you already pay for.**

You probably already pay for Claude Pro/Max, ChatGPT Plus, or have a Google account — and each one ships an official agentic CLI (`claude`, `codex`, `gemini`). Jack is an open-source orchestrator that puts a chief on top of them: it takes your task, breaks it down, routes each piece to the cheapest suitable worker (free local models first), supervises execution, and hands you back one consolidated answer.

No API keys. No per-token billing. Just the tools you already have.

```
                    ┌──────────────────────────────┐
 jack "build X" ──► │           JACK CORE          │
                    │  Planner ─► Router ─► Synth  │
                    └──────┬───────┬───────┬───────┘
                           ▼       ▼       ▼
                      Claude    Codex    Gemini    Ollama / LM Studio
                      Code CLI  CLI      CLI       (free, local)
```

## Quickstart

```bash
npm install -g jack-orchestrator

# See what Jack found on your machine
jack doctor

# Run a task
jack "summarize the README in this directory and list 3 improvement ideas"
```

That's it — zero config. Jack auto-detects installed CLIs (`claude`, `codex`, `gemini`) and running local servers (Ollama on `:11434`, LM Studio on `:1234`).

## How it works

1. **Plan** — Jack's *brain* (by default Claude Code in headless JSON mode, configurable — point it at a local model for zero cost) decomposes your task into the smallest useful set of subtasks, each tagged with a capability: `code-edit`, `code-gen`, `reason`, `summarize`, `chat`, `web`.
2. **Route** — a free rule-based fast path picks the cheapest capable worker (`free-local` → `subscription` → `paid-api`). Genuinely ambiguous cases are arbitrated by the brain.
3. **Execute** — subtasks run in dependency waves (independent ones in parallel), each via the worker's officially supported headless mode (`claude -p`, `codex exec`, `gemini -p`) or HTTP for local models. If a worker fails, Jack falls back down the chain automatically.
4. **Synthesize** — outputs are merged into a single final answer.
5. **Persist** — every run is written to `./jack-runs/<id>/` (task, plan, per-subtask logs, final report) so nothing is ever lost.

## Configuration

Optional. `~/.jack/config.json` (global) overridden by `./jack.config.json` (per project). See [`jack.config.example.json`](./jack.config.example.json):

```json
{
  "brain": "claude-code",
  "workers": {
    "claude-code": { "enabled": true },
    "codex": { "enabled": true },
    "gemini": { "enabled": true },
    "local": [
      { "baseUrl": "http://localhost:11434/v1", "model": "qwen2.5-coder:14b" }
    ]
  },
  "routing": {
    "preferTier": "free-local",
    "maxConcurrency": 3,
    "maxAttemptsPerSubtask": 3
  }
}
```

## Commands

| Command | What it does |
|---|---|
| `jack "<task>"` | Plan → route → execute → report |
| `jack doctor` | Detect installed CLIs and local servers, show worker health |
| `jack workers` | List registered workers with tiers and capabilities |

## Use Jack as a library

```ts
import { buildRegistry, loadConfig, orchestrate, RunStore, newRunId, resolveBrain } from 'jack-orchestrator';

const config = await loadConfig();
const { registry } = await buildRegistry(config);
const store = await RunStore.create(config.runsDir, newRunId());
const record = await orchestrate(
  { id: store.runId, prompt: 'your task', cwd: process.cwd() },
  { registry, store, brain: resolveBrain(registry, config.brain), preferTier: 'free-local', maxConcurrency: 3, maxAttemptsPerSubtask: 3 },
);
console.log(record.report);
```

Custom workers implement the `Worker` interface — see [`examples/custom-worker.ts`](./examples/custom-worker.ts).

## Roadmap

- **v0.2** — REPL chat mode, LLM quality control with re-dispatch, Hugging Face worker, streaming output, `jack status <id>`
- **v1.0** — MCP server (`jack_run_task`, `jack_status`, `jack_list_workers`) so Claude Code/Cursor can delegate to Jack, plugin API for third-party workers, per-run budget caps

## A note on subscriptions and terms of service

Jack drives each CLI through its **officially supported, documented non-interactive mode** (`claude -p`, `codex exec`, `gemini -p`) — exactly as the vendors intend them to be scripted. Jack never scrapes interactive UIs, never touches or proxies your credentials, and issues one CLI invocation per subtask. You remain responsible for complying with each provider's terms and usage limits.

## Contributing

PRs welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md). Good first contributions: new worker adapters, better routing heuristics, REPL mode.

## License

[MIT](./LICENSE)
