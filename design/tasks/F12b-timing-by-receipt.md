# F12b — Measure tool/model time by event arrival; wire peak pricing into classifier and labeler calls

Read first: `design/spec-v1.md` §4 (`dispatch.finished.model_ms/tool_ms/pricing_period`), §5 (`peak_schedules`, inline `price.peak`). Then `core/src/dispatch/{process,index,codex,dsh,timing}.ts`, `core/src/pricing.ts` (`pricingPeriod`, `peakSchedule`), `core/src/classifier.ts`, `core/src/labeler.ts`, `core/src/router.ts`, `core/src/commands/{task,router}.ts`, `core/src/config.ts` (how pricing is loaded), and their tests.

Files you may modify: `core/src/dispatch/**`, `core/src/router.ts`, `core/src/commands/task.ts`, `core/src/commands/router.ts`, `core/src/labeler.ts`, `core/src/classifier.ts`, `core/test/**`, `core/README.md`. Do **not** touch `core/src/cli.ts`, `core/src/commands/ui.ts`, anything under `core/src/ui/`, `core/src/report.ts`, `core/src/store.ts`, `core/src/types.ts`.

## 1. Facts (verified against real runs on 2026-11-09)

Neither real stream carries timestamps, so F12's parser always yields `model_ms: null, tool_ms: null`:

- dsh headless `--json` events: `{"type":"session",…}`, `{"type":"status","phase":"turn_start","turn":1}`, `{"type":"status","phase":"step_end","usage":{…}}`, `{"type":"thinking","text"}`, `{"type":"tool_call","callId","tool","input"}`, `{"type":"tool_result","callId","status","result"}`, `{"type":"text","text"}`, `{"type":"final","sessionId","reason":{"kind"},"text"}`. No `ts` anywhere.
- codex `exec --json` events: `thread.started`, `turn.started`, `item.started {item:{id,type:"command_execution",command,…}}`, `item.completed {item:{id,type,…}}`, `turn.completed {usage}`. No timestamps either.

## 2. Measure by arrival time

`runJsonlProcess` (process.ts) reads lines as they arrive. Record `Date.now()` when each line is parsed and pass it to the adapter's line handler as a second argument (`onLine(event, arrivedAtMs)`); keep the existing signature working for callers that ignore it.

- dsh: `tool_ms` = Σ over `callId` of (arrival of `tool_result` − arrival of matching `tool_call`); unmatched calls contribute nothing. `model_ms` = `wall_ms − tool_ms`, clamped ≥ 0, only when at least one tool pair was measured **or** the stream had no tool calls at all (then `model_ms = wall_ms`, `tool_ms = 0`).
- codex: pair `item.started`/`item.completed` by `item.id` for `command_execution` (and any other item type whose name contains `tool`, `command`, `mcp`, `patch`); same arithmetic.
- When a stream has explicit timestamps (the F12 fixtures) keep preferring them; arrival time is the fallback. Document the rule in `timing.ts`'s header: *arrival time measures what the dispatcher observed, which includes pipe latency; it is never written as a timestamp into `usage_raw`.*
- Host rounds (`done`) stay null.

## 3. Wire peak pricing into classifier and labeler

F12 made `classifyTarget`/`labelWithModel` accept an optional `pricing` parameter but the callers never pass it, so classifier and labeler costs are always `flat`. Load the pricing file where `task create` (labeler) and `decide` (classifier) already have the home/context, and pass it through (`router.decide` → `classifyTarget`). If the pricing file is missing or invalid, pass `undefined` (flat) and do not fail the command. Record `pricing_period` nowhere new: the classifier/labeler cost fields stay as they are, only the amount changes in peak windows.

## 4. Tests

a. Adapter tests with a fake process that emits dsh events with controlled delays (use the existing stubbing approach in `dispatch.test.ts`; if lines are fed synchronously, inject a clock function into the parser instead of sleeping): two tool pairs of 30 ms and 50 ms → `tool_ms` within [80, 200], `model_ms = wall − tool_ms`; stream with no tool calls → `tool_ms 0`, `model_ms = wall`; unmatched `tool_call` → ignored.
b. Same for codex `item.started`/`item.completed`.
c. Fixtures with explicit timestamps still produce the F12 values (regression).
d. `task create` and `decide` tests: with a pricing file whose schedule covers the injected "now" (inject the clock or choose a schedule window spanning the whole day with `weekdays_only: false`), the recorded `labeler_cost_usd` / `classifier_cost_usd` are doubled compared to a run with no schedule.

`npm test` green from the repo root; report the count.
