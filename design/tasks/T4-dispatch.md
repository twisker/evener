# T4 — Pricing, dispatch adapters (codex, dsh), `dispatch`

Prerequisites: T1, T2 merged. Read `core/src/{types,config,store}.ts`, `core/src/commands/{types,task}.ts`, and **spec §1 (S1–S6) and §7** carefully.

## Scope (files you own)
- `core/src/pricing.ts`, `core/src/dispatch/index.ts`, `core/src/dispatch/codex.ts`, `core/src/dispatch/dsh.ts`, `core/src/dispatch/process.ts`
- `core/src/commands/dispatch.ts` (replace stub body)
- `core/test/pricing.test.ts`, `core/test/dispatch.test.ts`, `core/test/fixtures/codex-run.jsonl`, `core/test/fixtures/dsh-run.jsonl`

## Requirements
1. `pricing.ts` — `priceUsage(usage: NormalisedUsage, model: string|null, pricing: Pricing): {cost_usd: number, cost_unknown: boolean}` per spec §7 formula; `pricingVersion` comes from config.
2. `dispatch/process.ts` — `runJsonlProcess(opts: {argv: string[], cwd, stdinText, timeoutMs, env, onLine: (obj: unknown, raw: string) => void, spawnImpl?: typeof spawn}): Promise<{exitCode: number|null, timedOut: boolean, stderr: string, wallMs: number}>`. Pipe `stdinText` then end stdin. Split stdout on `\n`, parse each non-empty line as JSON; non-JSON lines are passed to `onLine(null, raw)`. Timeout: SIGTERM, then SIGKILL after 5 s. Cap captured stderr at 1 MiB.
3. Adapter interface in `dispatch/index.ts`:
   ```ts
   interface TargetAdapter {
     name: string;
     buildArgv(command: string[], ctx: {outputFile: string}): string[];   // substitutes {output_file}
     createParser(): { onLine(obj: unknown, raw: string): void; result(): ParsedRun };
   }
   interface ParsedRun { usage: NormalisedUsage; usage_raw: unknown; final_text: string|null; target_session_id: string|null; tool_calls: number|null; completed: boolean; model: string|null }
   ```
   - `codex.ts`: `thread.started.thread_id` → session id; `item.completed` with `item.type === "agent_message"` → final_text (last wins); other `item.completed` → tool_calls++; `turn.completed.usage` → usage (last wins; cumulative semantics, S1). Normalise per §7. `completed` = saw `turn.completed`.
   - `dsh.ts`: `session.sessionId`; `status.phase === "step_end"` → sum usage; `tool_call` → tool_calls++; `final.text` → final_text, `completed = final.reason.kind === "completed"`; `error` event → completed false.
   - `runDispatch(opts: {store, policy, pricing, pricingVersion, task, target, promptPath, cwd, timeoutS?, env, now, spawnImpl?})` implements §7 fully: api-key presence pre-check, budget pre-check, `dispatch.started` (with `command` string and `context_bytes` = prompt byte length), spawn, parse, git diff stats before/after (`git diff --numstat` summed; null when not a repo; use `execFile` with timeout, swallow errors), write final text to `$HOME_RUNS/<task>/<round>.out.md` and stderr to `.stderr`, status mapping, cost, `dispatch.finished`, circuit-breaker bookkeeping (count consecutive `error|timeout` `dispatch.finished` events for the target since the last `target.circuit` closed/open; on reaching `limits.circuit_breaker.failures` append `target.circuit{open, until}`), and returns the `dispatch` CLI output object. `wall_ms` measured around the spawn only.
4. `commands/dispatch.ts` — `dispatch --task T --prompt-file F [--cwd DIR] [--target X] [--timeout-s N]`; task must be in state `routed` (error `invalid_state` otherwise); `--target` defaults to `current_target`; `host` as target is an error (`host_not_dispatchable`).
5. Fixtures: `codex-run.jsonl` = the four lines from spec S3 with usage `{input_tokens:13239,cached_input_tokens:0,cache_write_input_tokens:13236,output_tokens:5,reasoning_output_tokens:0}` plus one `item.completed` with `type: "command_execution"`; `dsh-run.jsonl` = the S5 sequence with two `step_end` events (usage 399/2/5248/0 and 1000/50/0/0) and one `tool_call`.
6. Tests: parsers produce expected normalised usage (codex: input 13239, cached 0, output 5; dsh: input 1399, cached 5248, output 52), tool_calls, session ids, completed flags; `priceUsage` with the default pricing for both; a fake `spawnImpl` (an `EventEmitter` with `stdout/stderr/stdin` PassThrough streams that replays a fixture then exits) drives `runDispatch` end-to-end and the store shows `dispatch.started`+`dispatch.finished` with status `success`, the task state `awaiting_acceptance`, and `total_cost_usd > 0`; exit code 1 → `error`; a spawn that never exits → `timeout` (use 50 ms timeout); missing api key env → `error` without spawning; three consecutive errors open a circuit event; budget exceeded → `budget_exceeded` without spawning.
7. `npm test` green.
