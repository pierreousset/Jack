# Contributing to Jack

Thanks for your interest! Jack is young and contributions of every size are welcome.

## Setup

```bash
git clone <repo-url> && cd jack
npm install
npm test          # vitest, fully offline (mock workers)
npm run typecheck
npm run lint      # biome
npm run build     # tsup
```

Node >= 18.17 required.

## Project layout

- `src/workers/` — the `Worker` interface and one adapter per backend. All CLI-format knowledge lives in its adapter, nowhere else.
- `src/core/` — planner, router, orchestrator run loop, run persistence.
- `src/brain/` — prompt templates and the brain wrapper.
- `src/config/` — config schema (zod), loading, environment auto-detection.
- `src/cli/` — the `jack` command.

## Adding a worker

1. Create `src/workers/<name>.ts` implementing `Worker` (use `mock.ts` or `gemini.ts` as a template).
2. Wire it in `src/config/schema.ts` + `src/config/load.ts` (and `detect.ts` if auto-detectable).
3. Export it from `src/index.ts`.
4. Add unit tests with mocks. Real-backend tests go in `test/integration/` gated behind `JACK_E2E=1`.

## Rules of the road

- Unit tests must run offline — no network, no real CLI invocations.
- `npm run lint && npm run typecheck && npm test` must pass before review.
- Keep PRs focused; one feature or fix per PR.
- New prompts (planning/routing/synthesis) must demand strict JSON and tolerate fenced output.

## Reporting bugs

Open an issue with: your `jack doctor` output, the failing command, and the relevant `./jack-runs/<id>/` contents (scrub anything private).
