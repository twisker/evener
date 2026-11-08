# v1 verification log (2026-11-09)

All runs on the maintainer's machine (macOS, Node 26, codex-cli 0.166.0, @deepseek-ai/dsh 0.2.2-rc.1).

| Check | Result |
|---|---|
| `npm test` (core + adapter self-test) | 123 tests pass, `claude plugin validate` passes |
| dsh dispatch, real CLI | task "create hello.txt" → `success`, 8.7 s, $0.00075, usage parsed from `step_end` |
| codex dispatch, real CLI | task "create bye.txt" → `success`, 15.4 s, $0.0191 (placeholder prices), thread id captured |
| rejection → `next` | `style` → retry same target; round advanced to 2; `sweep` closed it as abandoned |
| host round | `question` rule → host; `done` → `accept` → `next` = close; totals recorded |
| report | Markdown renders all six sections; `insufficient` shown for n < 8; style-suspicion alert fired; `export --format jsonl` emits every event |
| skill in a real Claude Code session | `claude -p --plugin-dir adapters/claude-code` with the `/evener:evener` skill: SessionStart hook supplied the session id (`host_session_id` matched), label `mechanical` → `dsh`, dispatch succeeded, acceptance recorded with `scope=pass` and tests/lint/build `skipped`, task closed `accepted`. Nested session cost $0.76 of host tokens for a $0.0008 delegated task (22 turns). |

## Observations for the maintainer

- **Host overhead dominates small tasks.** The orchestration conversation (reading the skill, 8 CLI calls, acceptance) cost ~900× the delegated work. Evener's CPAT only counts what the host reports via `--reviewer-cost-usd`; the host's own token cost is invisible unless the skill estimates it. Routing pays off only for tasks large enough that the delegated cost dominates, or if the skill is slimmed down (fewer round trips). See decisions D17/D18.
- Codex `cached_input` is large even on a fresh thread (prompt caching of the system prompt); pricing must keep the cached rate separate (it does).
- dsh writes a persisted session per dispatch under `~/.dsh/sessions/<cwd>/`; nothing in Evener cleans these up.
