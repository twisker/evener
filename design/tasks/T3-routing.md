# T3 — Classifier client, model labeler path, router, `decide`

Prerequisites: T1, T2 merged. Read `core/src/{types,config,store,labeler,experiment}.ts` and `core/src/commands/{types,task}.ts` first.

## Scope (files you own)
- `core/src/classifier.ts`, `core/src/router.ts`, `core/src/commands/router.ts` (replace the stub body)
- Edit `core/src/labeler.ts` only to wire the model path (§3).
- `core/test/classifier.test.ts`, `core/test/router.test.ts`

## Requirements
1. `classifier.ts`:
   - `renderClassifierPrompt(arm: ArmPolicy, task: TaskFeatures): {system: string, user: string}` exactly per spec §6.1. `TaskFeatures = {label, pre_features, constraints, excerpt: string|null}`. Never include hash. Include the literal JSON shape the model must return.
   - `callChatCompletions(opts: {endpoint, apiKey, model, messages, timeoutMs, temperature, maxTokens, fetchImpl?: typeof fetch}): Promise<{content: string, usage: {prompt_tokens, completion_tokens}|null, latency_ms}>` — POST `${endpoint}/chat/completions`, `response_format: {type: "json_object"}`, `AbortController` timeout, throws `ClassifierError` with codes `timeout|http|parse|no_key`.
   - `classifyTarget(arm, task, env, fetchImpl?): Promise<ClassifierResult>` where `ClassifierResult = {ok: true, target, scores: Record<string, number>, rationale, model, latency_ms, cost_usd} | {ok: false, code, message, latency_ms}`. Extract the first `{...}` JSON object from content (models sometimes wrap in fences). Reject a target that is not an enabled key of `arm.targets` with code `invalid_target`. Cost from `arm.classifier.price`.
   - `labelWithModel(policyLabeler, taxonomy, description, env, fetchImpl?)` — fixed prompt: "Classify this coding task into exactly one label from: … Answer {"label": "..."}"; falls back to `unknown` on failure. Endpoint/key fall back to the classifier's when null.
2. `router.ts` — `decide(input: {store, policy (effective), arm, task: TaskRow, created: TaskCreatedPayload, env, now, fetchImpl?}): Promise<RouteDecision>` implementing spec §6 steps 1–7 in order. Export `evaluateRules(rules, features): {rule, target} | null`, `openCircuits(store, now): Set<string>` (latest `target.circuit` event per target with state open and `until > now`), `fallbackTarget(arm, label, open)`, `firstEnabledInChain(arm, open, after?: string)`. The returned decision includes every `route.decided` payload field plus `locked`. Candidates for `decided_by: rule|fallback` = `[{target, score: 1}]`.
3. `labeler.ts`: replace the `labelerModelCall` parameter with a real call to `labelWithModel` when `policy.labeler.model` is set; keep heuristic fallback. Update `commands/task.ts` call site only if the signature changes (prefer keeping it).
4. `commands/router.ts` — `decide --task T`: loads task, checks state (`created` on round 1, else error `invalid_state`), loads the effective policy for the task's arm, runs `decide`, appends `route.decided`, prints `{task_id, round, target, decided_by, rule_id, rationale, candidates, arm, locked}`. `--dry-run` prints without appending.
5. Tests with an injected `fetchImpl` stub (never real network): rules win over classifier; `private_path` constraint locks to host; disabled target in fallback walks the chain; classifier timeout → fallback with `decided_by: fallback`; classifier returning a fenced JSON block parses; classifier returning a disabled target → fallback; open circuit excludes a target; prompt contains no `description_hash` and no excerpt when privacy flag is off; `decide` CLI refuses a task already in `routed` state.
6. `npm test` green.
