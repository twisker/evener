# F3 — Report: attribute rounds to the target that actually ran

Prerequisites: T6 merged. Read `core/src/report.ts`, `core/src/store.ts`, spec §9.

## Bug
A task routed to `codex` by `route.decided`, then changed with `evener override --to dsh` and dispatched to `dsh`, is counted under `codex` in the "目标画像 / Targets" section (observed: dsh row empty, codex mean cost averaged over both tasks). Any per-target statistic must use the target recorded on that round's `dispatch.started` / `dispatch.finished` events (fall back to the last `route.decided` / `user.override` of the round only when no dispatch event exists for the round, e.g. a task abandoned before dispatch).

## Scope
- `core/src/report.ts` (and a small helper if needed), `core/test/report.test.ts`.

## Requirements
1. Introduce `roundTarget(events, round): string | null` with the precedence above and use it everywhere the report groups by target: first-pass / final-pass per target, mean cost / wall per target, failure rate, reject-reason distribution, style suspicion, suggestions rule 1 and 2.
2. Per-target cost for a round = that round's `dispatch.finished.cost_usd` (+ the round's acceptance `reviewer_cost_usd`); do not divide a task's total across targets.
3. Test: a task decided `codex`, overridden to `dsh`, dispatched (`dispatch.started`/`finished` with target `dsh`), accepted → appears under `dsh` only, with its cost; `codex` row has n = 0. A second test: a task with two rounds (dsh rejected, escalated to codex accepted) contributes one round to each target, first-pass counted for dsh as 0 and for codex not at all (first pass is a round-1 concept), final acceptance attributed to codex.
4. `npm test` green.
