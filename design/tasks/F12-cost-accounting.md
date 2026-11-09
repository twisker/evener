# F12 — Cost accounting data layer: peak schedules, timing split, reviewer tokens, self_accepted

Read first: `design/spec-v1.md` §4 (`dispatch.finished`, `acceptance.finished`), §5 (`pricing.yaml` with `peak_schedules`, the inline `price` objects of `classifier`/`labeler`), §7. Then `core/src/pricing.ts`, `core/src/dispatch/{index,codex,dsh}.ts`, `core/src/classifier.ts`, `core/src/lifecycle.ts`, `core/src/store.ts`, `core/src/types.ts`, `core/src/config.ts` (pricing validation), `core/templates/pricing.default.yaml`, `core/templates/policy.default.yaml` and their tests.

Files you may modify: `core/src/types.ts`, `core/src/config.ts`, `core/src/pricing.ts`, `core/src/classifier.ts`, `core/src/labeler.ts`, `core/src/dispatch/**`, `core/src/lifecycle.ts`, `core/src/store.ts`, `core/src/commands/lifecycle.ts`, `core/src/commands/dispatch.ts`, `core/templates/*.yaml`, `core/test/**`, `core/README.md`. Do **not** touch `core/src/cli.ts`, `core/src/report.ts`, `core/src/commands/task.ts` or anything under `core/src/ui/` (another task owns them).

## 1. Peak schedules (pricing.ts, config.ts, templates)

- `pricing.yaml` gains an optional top-level `peak_schedules: {<name>: {tz: string, windows: ["HH:MM-HH:MM", …], weekdays_only: bool, factor: number}}` and each model price gains optional `peak: <name>`. Template per spec §5 verbatim (DeepSeek list prices become off-peak: flash 0.15/0.003/0.60, v4-pro 0.66/0.022/1.98, both `peak: deepseek`; schedule `deepseek: {tz: Asia/Shanghai, windows: ["09:00-12:00","14:00-18:00"], weekdays_only: true, factor: 2}`). `gpt-5.1-codex` has no `peak`.
- Validation: unknown schedule name → error with JSON pointer; `factor` > 0; windows `HH:MM-HH:MM` with start < end (no wrap-around in v1; reject with a clear message); `tz` must be accepted by `Intl.DateTimeFormat` (try/catch).
- `export function pricingPeriod(schedule: PeakSchedule | null, at: Date): "peak" | "off" | "flat"` — `flat` when no schedule; weekday and local time computed with `Intl.DateTimeFormat(…, {timeZone: tz, hour12: false, weekday, hour, minute})`. Weekdays are Mon–Fri. Public holidays are not modelled (say so in a comment).
- `priceUsage(usage, model, pricing, at: Date)` returns `{cost_usd, cost_unknown, pricing_period}`; cost multiplied by `factor` when `peak`.
- The classifier and labeler inline `price` objects accept optional `peak: <schedule name>` resolved against the pricing file's `peak_schedules`; `classifyTarget` / `labelWithModel` cost uses the current time. If the policy is loaded without a pricing file in reach, treat as `flat`. Keep the existing call signatures working by adding optional parameters.
- Update `policy.default.yaml` comments where they say "peak price" (classifier/labeler price stays the list = off-peak price 0.15 / 0.60, add `peak: deepseek`).

## 2. Timing split (dispatch adapters)

`dispatch.finished` gains `model_ms: int|null` and `tool_ms: int|null`.

- codex: the JSONL carries per-item events with timestamps (`item.started` / `item.completed`, or equivalents — inspect `core/test/fixtures/codex*.jsonl` and the adapter). `tool_ms` = Σ durations of command/tool items; `model_ms` = wall − tool_ms when at least one timestamped item exists; both `null` when the stream has no usable timestamps. Do not invent timestamps.
- dsh: `status.step_end` carries step timing if present (inspect fixtures); `tool_call`/`tool_result` pairs give tool durations when both have `ts`. Same null rule.
- Host rounds recorded by `done`: both `null`.
- `pricing_period` on every `dispatch.finished` (from §1, evaluated at the finish timestamp); host rounds → `flat`.

## 3. Acceptance fields (lifecycle.ts, commands/lifecycle.ts)

- `acceptance.finished` gains `reviewer_usage: {input, cached_input, output}|null` (CLI flags `--reviewer-input-tokens`, `--reviewer-cached-tokens`, `--reviewer-output-tokens`; null unless at least one given; missing ones default 0) and `self_accepted: bool` = true when the round's `dispatch.started.target` is `host`.
- Store validation accepts the new fields; absent is allowed (older events). Do not change `total_cost_usd` arithmetic.

## 4. Tests

a. `pricingPeriod`: Tuesday 10:30 Asia/Shanghai → peak; Tuesday 13:00 → off; Saturday 10:30 → off; a model without `peak` → flat; a DST-free zone is fine, but test with an explicit UTC instant so the test is machine-independent.
b. `priceUsage` doubles cost in peak, not off; `gpt-5.1-codex` always flat.
c. Config: unknown schedule name rejected with pointer `/models/deepseek-flash/peak`; bad window string rejected; template validates.
d. Adapters: fixtures with timestamps yield `model_ms`+`tool_ms` summing to ≤ wall; fixtures without yield null.
e. `accept` with reviewer token flags records `reviewer_usage`; without → null; host round → `self_accepted: true`, codex round → false.
f. Store: old payloads without new fields still validate.

## 5. Docs

`core/README.md`: one paragraph on `peak_schedules` and `pricing_period`. Nothing in `design/`.

`npm test` green from the repo root; report the count.
