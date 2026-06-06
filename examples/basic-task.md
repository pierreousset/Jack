# Example: a basic Jack run

```bash
$ jack doctor
Subscription CLIs:
  claude   OK  (2.1.167 (Claude Code))
  codex    OK  (codex-cli 0.134.0)
  gemini   OK  (0.43.0)

Local model servers:
  ollama     http://localhost:11434/v1    UP  (3 models, e.g. qwen2.5-coder:14b)
  lm-studio  http://localhost:1234/v1     down

Registered workers (health):
  claude-code              tier=subscription healthy
  codex                    tier=subscription healthy
  gemini                   tier=subscription healthy
  ollama:qwen2.5-coder     tier=free-local   healthy

Brain: claude-code
```

```bash
$ jack "compare REST and GraphQL for a small startup API, then summarize the verdict in 3 bullets"
run 2026-06-06T09-00-00-x7k2qd — logs in jack-runs/2026-06-06T09-00-00-x7k2qd
plan: 2 subtask(s) — s1[reason], s2[summarize]
  s1 → claude-code [brain]
  s1 ← claude-code ok
  s2 → ollama:qwen2.5-coder [rule]
  s2 ← ollama:qwen2.5-coder ok

- REST wins for a small startup: simpler caching, tooling, and onboarding
- GraphQL pays off only with many client shapes or aggregation-heavy UIs
- Start REST, isolate handlers so a later GraphQL gateway stays cheap
```

Note how the expensive subscription CLI handled the reasoning while the free local model did the summarizing — that's the cost-tier routing at work. Everything is persisted:

```
jack-runs/2026-06-06T09-00-00-x7k2qd/
├── task.json
├── plan.json
├── run.json
├── report.md
└── subtasks/
    ├── s1.log
    ├── s1.json
    ├── s2.log
    └── s2.json
```
