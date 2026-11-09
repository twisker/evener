# F6 — Turn the model labeler on by default (DeepSeek flash), record its cost

Read first: `design/spec-v1.md` §4 (`task.created` payload), §5 (`classifier:` and `labeler:` blocks, `pricing.yaml`), §11 (`task create` row). Then `core/src/labeler.ts`, `core/src/classifier.ts`, `core/src/commands/task.ts`, `core/src/store.ts`, `core/src/lifecycle.ts`, `core/src/report.ts`, `core/src/config.ts`, `core/src/types.ts`, `core/templates/*.yaml` and their tests.

Files you may modify: `core/src/types.ts`, `core/src/config.ts`, `core/src/classifier.ts`, `core/src/labeler.ts`, `core/src/store.ts`, `core/src/lifecycle.ts`, `core/src/report.ts`, `core/src/commands/task.ts`, `core/templates/policy.default.yaml`, `core/templates/pricing.default.yaml`, `core/test/**`, `core/README.md`. Nothing else.

Verified facts you can rely on (do not re-verify, no network in tests):
- DeepSeek's OpenAI-compatible endpoint `https://api.deepseek.com/v1/chat/completions` serves `deepseek-flash` and `deepseek-v4-pro`. `deepseek-flash` thinks by default and returns `reasoning_content` plus ~90 reasoning tokens for a one-line answer; sending `"thinking": {"type": "disabled"}` in the request body turns that off and `response_format: {type: json_object}` still works. `usage` has `prompt_tokens`, `completion_tokens`, `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`.
- The user's dsh runs on `deepseek-flash`; the dsh key env is `DEEPSEEK_API_KEY`.

## 1. Config schema (types.ts, config.ts, templates)

New fields, all with the fallbacks written in the spec §5 comments:
- `classifier.request_extra: object | null` — plain JSON object merged into the chat/completions request body. Default in the template: `{thinking: {type: disabled}}`.
- `labeler.timeout_ms: int | null` (null → `classifier.timeout_ms`), `labeler.price: {input_per_mtok, output_per_mtok} | null` (null → `classifier.price`), `labeler.request_extra: object | null` (null → `classifier.request_extra`).
- Validation: `request_extra` must be null or a JSON object (arrays rejected) and may not contain the keys `model`, `messages`, `temperature`, `max_tokens`, `response_format` (error with the JSON pointer of the offending key). `labeler.price` validated like `classifier.price`. `labeler.timeout_ms` positive integer or null.
- A user policy file that predates these fields must still validate and load: missing fields default to null (classifier.request_extra too — the template default is not applied to user files silently; a missing field means null).
- Templates: make `core/templates/policy.default.yaml` and `core/templates/pricing.default.yaml` match spec §5 exactly (labeler block, classifier price/request_extra, `targets.dsh.model: deepseek-flash`, pricing models `deepseek-flash` and `deepseek-v4-pro`; `deepseek-v3.2` disappears). Fix every test or fixture that asserted the old values.

## 2. Transport (classifier.ts)

- `callChatCompletions` takes an optional `requestExtra` and spreads it into the body **before** the fixed fields (model, messages, temperature, max_tokens, response_format), so the fixed fields always win. Return `latency_ms` alongside `usage` if it does not already.
- Wire `classifier.request_extra` into `classifyTarget` as well.
- `labelWithModel`: prompt asks for three fields — `label` (taxonomy), `time_bucket` (existing four buckets) and `has_repro` (boolean: true only if the task text itself supplies a failing test, reproduction steps, or an error/stack trace). Keep the prompt fixed and policy-independent; `prompt_extra` stays appended at the end. Resolve transport from labeler fields with classifier fallbacks (endpoint, api_key_env, timeout_ms, price, request_extra; temperature/max_tokens from classifier). Return `{label, time_bucket, has_repro: boolean|null, cost_usd: number|null, latency_ms: number|null, error: string|null}`: cost = usage × resolved price (null when usage is missing); on any failure `error` is `"<code>: <message>"` using the existing `ClassifierError` codes (`no_key`, `timeout`, `http`, …) instead of swallowing silently. A model answer whose `label` is not in the taxonomy is `error: "parse: …"`.

## 3. Labeler (labeler.ts)

`labelTask` returns additionally `has_repro: boolean | null` (model value when it is a boolean, else null), `labeler_cost_usd: number | null`, `labeler_latency_ms: number | null`, `warning: string | null`. When a model is configured but the heuristic result was used, `labeler_model` is `"heuristic"` and `warning` is `labeler: <error>; fell back to heuristic`. Heuristic path: all new fields null, no warning.

## 4. `task create` (commands/task.ts)

- `pre_features.has_repro` = model value when boolean, otherwise the existing heuristic value. `time_bucket` as today.
- Payload gains `labeler_cost_usd` and `labeler_latency_ms` (spec §4).
- Output object gains `labeler_model` and `warnings: string[]` (empty when none). When warnings are non-empty and `--quiet` is not set, also print each as `warning: …` on stderr. stdout stays exactly one JSON object.
- Inject `fetch` the same way `decide` injects it for the classifier so tests can stub it.

## 5. Cost accounting (store.ts, lifecycle.ts, report.ts)

- Store validation accepts the two new fields as `number ≥ 0 | null`; **absent** is also accepted (events written before this change).
- Task projection (`applyProjection`, `rebuildTasks`) adds `labeler_cost_usd ?? 0` to `tasks.total_cost_usd`. The totals computed in lifecycle (used by `close` and the budget check) include it the same way classifier cost is included today.
- Report: wherever classifier cost is counted as Evener overhead (`classifierCostUsd` in report.ts), count labeler cost the same way. No new sections or columns.

## 6. Tests (node:test, stubbed fetch, no network)

a. Model path happy case: stub returns `{"label":"bugfix","time_bucket":"1h_4h","has_repro":false}` with usage 176/23 → label, bucket and has_repro taken from the model; `labeler_cost_usd` equals the arithmetic from `labeler.price`; the request body contains `thinking.type === "disabled"` and `response_format.type === "json_object"`; the Authorization header carries the value of `DEEPSEEK_API_KEY` from the injected env (not process.env).
b. Env without the key → heuristic label, `labeler_model: "heuristic"`, warning contains `no_key`.
c. Stub returns HTTP 401 → heuristic + warning containing `http`.
d. Model returns `has_repro: "yes"` (non-boolean) → `has_repro` falls back to the heuristic value.
e. Config: `request_extra: {messages: []}` is rejected with pointer `/classifier/request_extra/messages`; `request_extra: []` rejected; null accepted; a policy lacking all new fields validates and loads with nulls; template validates and `policy show` reflects the new defaults.
f. Store: a `task.created` payload without the new fields validates; one with `labeler_cost_usd: 0.0001` raises `total_cost_usd` by that amount; `rebuildTasks` agrees.
g. `task create` command: with stubbed fetch → output has `warnings: []` and `labeler_model: "deepseek-flash"`; with no key in env → `warnings.length === 1`, stderr contains `warning:`, exit 0.

## 7. Docs

`core/README.md`: a short "Labeler" paragraph (what it does, the env var, how to disable, cost order of magnitude). Nothing in `design/`.

`npm test` from the repo root must be green. Report the test count.
