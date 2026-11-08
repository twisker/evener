# Working rules for delegated implementation tasks (read first)

You are implementing part of **Evener** in the repository at the current working directory.
Authoritative documents, read them before coding:
- `design/spec-v1.md` — the implementation contract (schemas, CLI, algorithms). Follow it exactly; field names and enums are frozen.
- `CLAUDE.md` — repo conventions.

Rules:
1. TypeScript, ESM (`"type": "module"`), Node ≥ 22.13. Runtime dependency allowed: `yaml` only. Dev dependencies: `typescript`, `@types/node`. Use `node:sqlite`, `node:test`, `node:assert/strict`, `node:util` `parseArgs`, `node:crypto`, `node:child_process`, `node:fs`. No other packages.
2. Strict TypeScript (`"strict": true`, `"noUncheckedIndexedAccess": true`). No `any` except at JSON parse boundaries, immediately narrowed.
3. Tests live in `core/test/*.test.ts`, compiled with the sources to `core/dist/`, run with `node --test core/dist/test/`. Every task must leave `npm test` (from repo root) passing: build + all tests green. Run it yourself before finishing and paste the final summary line in your answer.
4. Never touch files outside the scope listed in the task unless the task says so. Do not reformat existing files. Do not edit `design/`.
5. Do not store secrets. Do not call any external network API from tests; mock or stub process spawning and HTTP.
6. Keep functions small and pure where possible; the store and config modules are consumed by other tasks, so export clear typed interfaces.
7. When the spec is ambiguous, pick the simplest behaviour that satisfies the text, implement it, and list the choice under "Assumptions" in your final answer.
8. Final answer format (plain text): (a) files created/modified, (b) how to run, (c) `npm test` summary line, (d) Assumptions, (e) anything not done.
