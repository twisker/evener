# F2 — Host-round completion, `help`, SessionStart session-id hook, skill updates

Prerequisites: T1–T5, T7 merged. Read spec §8, §10, §11, `core/src/commands/{dispatch,lifecycle,types}.ts`, `core/src/dispatch/index.ts`, `core/src/store.ts`, and the whole `adapters/claude-code/` tree.

## Problem
When `decide` returns `host`, the host does the work itself, but nothing records a dispatch for that round, so the task stays in state `routed` and `evener accept` (which requires `awaiting_acceptance`) fails. The skill also has no way to learn the Claude Code session id, so `--host-session` is never set and the Stop/SubagentStop sweep cannot find orphans.

## Scope
- `core/src/commands/dispatch.ts`, `core/src/dispatch/index.ts` (new exported `recordHostRound`), `core/src/cli.ts` (help), `core/test/dispatch.test.ts`, `core/test/cli.test.ts`
- `adapters/claude-code/hooks/hooks.json`, `adapters/claude-code/scripts/session-start.sh`, `adapters/claude-code/skills/evener/SKILL.md`, `adapters/claude-code/commands/evener-feedback.md`, `adapters/claude-code/scripts/selftest.sh`, `adapters/claude-code/README.md`
- Update `design/spec-v1.md` §7 and §11 **only** by appending the new command row and one paragraph (this is the one task allowed to edit design/).

## Requirements
1. New command `evener done --task T [--wall-ms N] [--cost-usd C] [--model M] [--status success|error]` — records a host-executed round: appends `dispatch.started` (`target: host`, `target_version: null`, `model: M|null`, `context_bytes: 0`, `command: "host"`) and `dispatch.finished` (`status` default `success`, `wall_ms` default 0, usage all zeros, `usage_raw: {}`, `cost_usd` = C or 0 with `cost_unknown: true` when C is absent, `price_table_version`, `diff_stats` from git in `--cwd` like a normal dispatch, `tool_calls: null`, `exit_code: null`, `target_session_id: null`, `output_path: null`). Task must be in state `routed` with `current_target === "host"`; otherwise error `invalid_state` / `not_host_round`. Output `{task_id, round, target: "host", status, wall_ms, cost_usd}`. Host rounds never touch the circuit breaker.
2. `evener help` and `evener --help` / `-h` print `{commands: [{name, usage}]}` from the registry (each registered command supplies a one-line `usage` string; extend `CommandRegistry` so `register` accepts `{handler, usage}` or keep a parallel `usages` map — pick the smaller change). Exit 0. Update `bin/evener` to stop handling `--help` itself and pass it through.
3. SessionStart hook: add to `hooks.json` a `SessionStart` entry (no matcher) running `scripts/session-start.sh`, which reads the hook JSON from stdin, extracts `session_id`, and prints exactly `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Evener: this Claude Code session id is <id>. Pass it as --host-session <id> to `evener task create` and `evener tasks`."}}` on stdout, exit 0. Malformed input → print nothing, exit 0. No jq; use `node -e` like `sweep.sh`.
4. `SKILL.md`: (a) in step 2 require `--host-session <id>` using the id from the SessionStart context, falling back to omitting it only if unknown; (b) in the `host` branch, after doing the work, run `evener done --task "$TASK" --wall-ms <elapsed ms if known> [--cost-usd …]` **before** `evener accept`; explain in one sentence why; (c) add `evener done` to the command/return-key list; (d) for `redispatch` rounds whose `next_target` is `host`, the same `done` → `accept` flow applies. Keep the file ≤ 170 lines.
5. `commands/evener-feedback.md`: use the SessionStart-provided id instead of an undefined `$SESSION_ID`.
6. `selftest.sh`: add a check that `echo '{"session_id":"abc"}' | scripts/session-start.sh` prints JSON containing `abc`, and that `bin/evener help` prints `"commands"`.
7. Tests: `done` on a host-routed task moves it to `awaiting_acceptance` with zero usage and `cost_unknown` true when no cost given; `done` on a codex-routed task errors `not_host_round`; `help` lists at least `decide`, `dispatch`, `done`, `report`.
8. README: mention `evener done` and the SessionStart hook.
9. `npm test` green (core + adapter self-test).
