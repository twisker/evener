# v1 verification log (2026-11-09)

All runs on the maintainer's machine (macOS, Node 26, codex-cli 0.166.0, @deepseek-ai/dsh 0.2.2-rc.1).

| Check | Result |
|---|---|
| `npm test` (core + adapter self-test) | 159 tests pass, `claude plugin validate` passes |
| dsh dispatch, real CLI | task "create hello.txt" → `success`, 8.7 s, $0.00075, usage parsed from `step_end` |
| codex dispatch, real CLI | task "create bye.txt" → `success`, 15.4 s, $0.0191 (placeholder prices), thread id captured |
| rejection → `next` | `style` → retry same target; round advanced to 2; `sweep` closed it as abandoned |
| host round | `question` rule → host; `done` → `accept` → `next` = close; totals recorded |
| report | Markdown renders all six sections; `insufficient` shown for n < 8; style-suspicion alert fired; `export --format jsonl` emits every event |
| stratification features (F4/F5) | `--files src/a.ts,src/b.ts` + description naming them → `files_mentioned 2`, `language ts`, `cross_file true`; "No reproduction yet, stack trace unavailable" → `has_repro false`; `time_bucket 15m_1h`; old v1 DB upgraded to schema 2 in place; `report --by time_bucket` renders |
| skill in a real Claude Code session | `claude -p --plugin-dir adapters/claude-code` with the `/evener:evener` skill: SessionStart hook supplied the session id (`host_session_id` matched), label `mechanical` → `dsh`, dispatch succeeded, acceptance recorded with `scope=pass` and tests/lint/build `skipped`, task closed `accepted`. Nested session cost $0.76 of host tokens for a $0.0008 delegated task (22 turns). |
| model labeler (F6) | Real `deepseek-flash` calls with thinking disabled: "Fix crash in src/a.ts and src/b.ts … No reproduction yet" → `bugfix`, `1h_4h`, `has_repro false`, $0.000095, ~1 s; "Add a unit test … stack trace attached" → `test`, `15m_1h`, `has_repro true`; `labeler_cost_usd` lands in `tasks.total_cost_usd`. Without `DEEPSEEK_API_KEY`: heuristic label, `warnings[0]` = `labeler: no_key…`, stderr warning, silent under `--quiet`. DeepSeek model list and price tier verified the same day (see CLAUDE.md, D3/D5/D21). |
| peak/off-peak pricing (F12) | Real dsh dispatch at Monday 18:47 Asia/Shanghai → `pricing_period: off`, cost $0.000193 at list price; template validates; 176 tests. `model_ms`/`tool_ms` were `null` because neither real stream carries timestamps (F12b measures by arrival time instead). |
| web panel page (U2) | Built by Codex CLI ($0.33, 447k input of which 400k cached). Headless Chrome screenshots of all four views in `?mock=1`, light and dark, 390 px: no horizontal page overflow (tables scroll inside their cards); unknown task id renders an inline error with retry. |
| dsh silent completion | One U1 run ended `final.reason.kind = completed` with empty text after 23 read-only tool calls and no file changes. A delegated task can therefore "succeed" at the process level while producing nothing; Evener should detect an empty final message and classify the round `incomplete` automatically (research note item 11). Re-dispatched. |
| web panel end-to-end (U1+U2) | `evener ui --port 0 --no-open` on the test home: every §13 route answered with real data (overview, tasks, task rounds incl. `model_ms 10360 / tool_ms 72 / pricing_period off`, output tail, report, sessions split, SSE `: connected`), traversal id → 404, POST → 405. Headless Chrome screenshots of the four views against the live server render correctly. 192 tests. Note: the shell's proxy variables route 127.0.0.1 through the proxy; use `curl --noproxy '*'` when testing. |

## Observations for the maintainer

- **Host overhead dominates small tasks.** The orchestration conversation (reading the skill, 8 CLI calls, acceptance) cost ~900× the delegated work. Evener's CPAT only counts what the host reports via `--reviewer-cost-usd`; the host's own token cost is invisible unless the skill estimates it. Routing pays off only for tasks large enough that the delegated cost dominates, or if the skill is slimmed down (fewer round trips). See decisions D17/D18.
- Codex `cached_input` is large even on a fresh thread (prompt caching of the system prompt); pricing must keep the cached rate separate (it does).
- dsh writes a persisted session per dispatch under `~/.dsh/sessions/<cwd>/`; nothing in Evener cleans these up.
