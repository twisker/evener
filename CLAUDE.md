# CLAUDE.md — Evener

Context for Claude Code when working in this repo. Read `design/spec-v1.md` (the frozen implementation contract) before touching anything substantive; `design/prd-draft.md` has the motivation.

## What this is

Evener is an open-source plugin that routes delegated coding tasks from a host harness (Claude Code first) to the most cost-effective target harness (Codex CLI, DeepSeek Harness `dsh`, or the host itself), records cost/time/quality for every task, and compares routing policies against each other. The name is the whiffletree bar that balances load across harnessed horses. 中文「匀杆」。

## Decisions already made — do not reopen without the user

- **Goal is API spend**, not subscription quota. "透明地掺沙子": mix cheaper models in, transparently, with the user's own keys.
- **Scope**: Evener only routes (including re-dispatch / escalation decisions). Task decomposition, context assembly, dispatch execution and acceptance review are the host's job. Evener consumes acceptance verdicts as events.
- **Policy == classifier.** The routing policy is a structured YAML file rendered into a prompt for a cheap classifier model. The classifier model is a pluggable executor and is *not* evaluated (only its id is logged). The policy is the thing that gets A/B-compared and tuned.
- **Separate fixed analysis labeler** assigns each task a label from a stable taxonomy, used only for stratifying reports. It never influences routing.
- **Evaluation**: interleaved random assignment between policies (later Thompson-sampling bandit). Never "two weeks A then two weeks B". Report → user applies; no silent auto-adjust in v1.
- **Cost is accounted per task across all rounds**, including acceptance overhead. Core metric: CPAT (cost per accepted task); 性价比 = quality score / CPAT.
- **Rejection reasons are a fixed enum** so that "insufficient context" is not blamed on the target harness.
- **Storage**: SQLite with WAL, local only. JSONL / OpenTelemetry are export formats only.
- **Code layering**: host-independent core (CLI + library) in `core/`; thin per-host adapters in `adapters/` that only do marketplace packaging and event wiring.
- **Host interface**: mechanism is fixed per host (Claude Code: a skill calls `evener decide` / `evener report`; Stop and SubagentStop hooks as safety net). Behavior (which tasks are routed, confirmation) is configurable.
- **Success metric**: ability to *distinguish* two policies' cost-efficiency at a given threshold, not absolute savings.
- **Non-goals**: decomposition, context assembly, acceptance, token proxy, quota rotation, GUI (v1).

## Decisions taken 2026-11-09 (see design/spec-v1.md §2 and design/decisions-for-user.md)

- `core/` is TypeScript (ESM) on Node ≥ 22.13; only runtime dependency is `yaml`; `node:sqlite`, `node:test`, `parseArgs` from built-ins.
- Schema uses `classifier` / `classifier_model` (renamed from `router`).
- Defaults the user still needs to confirm (prices, model ids, classifier key, …) are listed in `design/decisions-for-user.md`; all are config, not code.

## Known external facts (verified 2026-11-09)

- Codex: `codex exec --json` emits JSONL; `turn.completed.usage` is **cumulative for the thread** (input / cached_input / cache_write_input / output / reasoning_output). A fresh `codex exec` per round equals per-round usage. `-o <path>` writes the final message; prompt `-` reads stdin.
- dsh (`@deepseek-ai/dsh` 0.2.2-rc.1): `dsh --profile headless --json` emits JSONL; `status.step_end.usage` carries per-step `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens`; `final.reason.kind` + exit code give success. Pre-release; expect breaking changes. Headless runs use model `deepseek-flash` (seen in the session log; not in the JSON output).
- DeepSeek API (2026-11-09): models are `deepseek-flash` (V4.1-Flash) and `deepseek-v4-pro`; `deepseek-chat` is an alias served by flash. Thinking is on by default; send `{"thinking":{"type":"disabled"}}` for classifier-style calls. Peak/off-peak billing, peak = 01–04 and 06–10 UTC weekdays.
- Nearby project to be aware of: npm `harness-reins` (dispatch to any agent and route result back).

## How work is done in this repo

- Claude plans, writes briefs in `design/tasks/`, dispatches implementation to DeepSeek Harness (`cat design/tasks/_preamble.md design/tasks/Tn-*.md | npx @deepseek-ai/dsh --profile headless --json`), then reviews, runs `npm test`, and merges. Parallel tasks run in separate git worktrees under `../evener-wt/`.

## Conventions

- Design docs live in `design/`. Update `design/prd-draft.md` when a decision changes; record the date.
- Commit messages: imperative, short subject. Include the Claude co-author trailer when Claude writes the commit.
- Default to privacy: never store task descriptions or diffs by default; hashes and excerpts behind a config flag.
- The user writes in Chinese; code, identifiers and docs are in English with Chinese allowed in design notes.
