# T5 — Lifecycle commands: `accept`, `next`, `close`, `feedback`, `override`, `sweep`

Prerequisites: T1, T2 merged. Read `core/src/{types,config,store}.ts`, `core/src/commands/{types,task}.ts`, and spec §8.

## Scope (files you own)
- `core/src/lifecycle.ts`, `core/src/commands/lifecycle.ts` (replace stub body)
- `core/test/lifecycle.test.ts`

## Requirements
1. `lifecycle.ts` pure logic, each taking `(store, policy, task, now)` plus arguments and returning the event(s) to append and the CLI output; the command layer appends them:
   - `accept(...)` → `acceptance.finished` (validate: `--reason` required when rejected; `checks` parsed from repeated `--check name=result`; `review` default `skipped`; costs default 0). State must be `awaiting_acceptance`.
   - `decideNext(...)` implementing spec §8 exactly: returns `{action: "close", outcome: "accepted"}`, `{action: "hand_to_human", why}`, or `{action: "redispatch", kind, next_target, round, why}`. Inputs come from the task's events: last `acceptance.finished`, count of rounds, per-target retry history (a `task.redispatch` with `kind: retry` for that target), repeated-same-reason counter, chain position of `current_target`, open circuits (reuse `openCircuits` from `core/src/router.ts` if present, else implement locally and note it), `limits`. `host` as current target → hand_to_human. Export the helper `nextInChain(chain, current, enabled: Set<string>)`.
   - `applyRedispatch(...)` → appends `task.redispatch` (envelope round = **new** round) and a `route.decided` (`decided_by: rule`, `rule_id: "escalation"`, `escalated_from`, candidates `[{target, score: 1}]`, same new round).
   - `close(...)` → `task.closed` with totals computed from events (`total_rounds` = max round seen, `total_cost_usd` = Σ dispatch cost + Σ reviewer cost + Σ classifier cost, `total_wall_ms` = Σ dispatch wall + Σ reviewer wall). Idempotent: closing a closed task errors with `already_closed`.
   - `feedback(...)`, `override(...)` (refuse when a locked rule decided the current round and `to !== "host"`: error `locked`), `sweep(hostSessionId)` → closes every open task of the session as `abandoned`, returns ids.
2. Commands per spec §11 output keys. `next` **does** append the redispatch events when action is `redispatch`; `--dry-run` only prints.
3. Tests (temp store, no network): accepted → next = close; rejected `style` → retry same target; rejected `misunderstood` → escalate to next in chain; retry already used → escalate; same reason twice → forced escalate; `max_rounds` reached → hand_to_human; budget exceeded → hand_to_human; current target `host` → hand_to_human; chain exhausted → hand_to_human; redispatch increments `current_round` and sets `current_target`; `close` totals equal the sum of fixture costs; `override` on locked round refused; `sweep` closes only the session's open tasks.
4. `npm test` green.
