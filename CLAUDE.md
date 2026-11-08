# CLAUDE.md — Evener

Context for Claude Code when working in this repo. Read `design/prd-draft.md` before touching anything substantive.

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

## Open decisions (ask the user, or pick and state the assumption)

- Implementation language for `core/` (TypeScript vs Python). Claude Code plugins are language-agnostic; dsh plugins are Node/Cordis.
- Whether to rename schema fields `router_model` / `router:` to `classifier_model` / `classifier:` for consistency with "policy == classifier".

## Known external facts (verified 2026-11-09)

- Codex: `codex exec --json` emits JSONL; usage is on `turn.completed.usage` (input / cached_input / output / reasoning_output). **Unverified**: whether usage is per-turn or cumulative for the thread. `-o <path>` writes the final message; `--output-schema` forces structured output.
- dsh (`@deepseek-ai/dsh` 0.2.2-rc.1): `dsh --profile headless "task"` runs once and prints the last assistant message to stdout; **no usage in stdout**. Usage must come from `--profile sdk` (JSON-RPC over stdio) or from persisted session files under `$DSH_HOME`. Pre-release; expect breaking changes.
- Nearby project to be aware of: npm `harness-reins` (dispatch to any agent and route result back).

## Pending spikes (do these before building adapters)

1. Run `codex exec --json` locally; determine usage semantics (per-turn vs cumulative).
2. Run `dsh --profile sdk`; capture JSON-RPC events and locate usage, or find the session file format.

## Conventions

- Design docs live in `design/`. Update `design/prd-draft.md` when a decision changes; record the date.
- Commit messages: imperative, short subject. Include the Claude co-author trailer when Claude writes the commit.
- Default to privacy: never store task descriptions or diffs by default; hashes and excerpts behind a config flag.
- The user writes in Chinese; code, identifiers and docs are in English with Chinese allowed in design notes.
