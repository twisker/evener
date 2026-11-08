# Evener v1 Specification (2026-11-09)

Status: **frozen for v1 implementation**. Every decision below was taken by Claude after local
verification; items the user may want to revisit are listed in `design/decisions-for-user.md`
and are exposed as configuration so they can be changed without code changes.

Read `design/prd-draft.md` for the motivation. This document is the implementation contract.

---

## 1. Verified facts (spikes done 2026-11-09)

| # | Question | Result |
|---|---|---|
| S1 | Codex `exec --json` usage semantics | `turn.completed.usage` is **cumulative for the thread**. Verified: turn 1 `output_tokens=5`, resumed turn 2 `output_tokens=11` (= 5 + 6); `input_tokens` 13239 → 26498. A fresh `codex exec` per round therefore equals per-round usage; on `codex exec resume` the adapter must subtract the previous cumulative value. |
| S2 | Codex usage fields | `input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens`. `cached_input_tokens` is a subset of `input_tokens`. |
| S3 | Codex event stream | `thread.started{thread_id}`, `turn.started`, `item.completed{item:{type:agent_message,text}}`, `turn.completed{usage}`. `-o FILE` writes the last message. Prompt `-` reads stdin; when stdin is a pipe and a prompt is given, stdin is appended, so the adapter always closes or pipes stdin deliberately. |
| S4 | dsh headless usage | `npx @deepseek-ai/dsh --profile headless --json` (0.2.2-rc.1) emits `{"type":"status","phase":"step_end","turn","step","usage":{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens}}` **per step**. Run usage = sum over `step_end`. The PRD's "no usage" claim applied to non-JSON mode only. |
| S5 | dsh headless stream | Opens with `session{sessionId,cwd}`, then `status{phase:turn_start|step_start|step_end|turn_end}`, `text`, `thinking`, `tool_call`, `tool_result`, closes with `final{sessionId,reason:{kind},text}`. Exit 0 = completed, 1 = aborted/error. Failure in-turn still emits `final`; use exit code + `turn_end.reason.kind`. Task may be piped on stdin when no positional argument is given. `--session-id` resumes. |
| S6 | dsh `inputTokens` | Excludes cache reads (`cacheReadTokens` separate), unlike Codex. Pricing must treat the two shapes differently (see §7). |
| S7 | Toolchain on dev machine | Node v26.13.0, npm 11, codex-cli 0.166.0, `sqlite3` CLI, `zstd`. No `uv`/`bun`; Python 3.9 only. |

## 2. Decisions taken in this spec

| Decision | Choice | Reason |
|---|---|---|
| Implementation language | **TypeScript on Node ≥ 22.13** | Node already required by dsh (`npx`), Claude Code plugins are language-agnostic, built-in `node:sqlite` removes native deps, `node:test` removes a test framework, `node:util.parseArgs` removes a CLI framework. Python 3.9 on the dev box is too old. |
| Runtime dependencies | **`yaml` only** | Everything else from Node built-ins. |
| Field naming | `router` → **`classifier`**, `router_model` → **`classifier_model`** | Consistent with "policy == classifier". |
| Storage path | `$EVENER_HOME` (default `~/.evener`) holding `policy.yaml`, `pricing.yaml`, `evener.sqlite` | One directory to back up or wipe. |
| Event store | Append-only `events` table + derived `tasks` table maintained by the CLI | Events are the source of truth; `tasks` is a cache for queries and can be rebuilt (`evener rebuild`). |
| Classifier transport | OpenAI-compatible `POST /chat/completions` with JSON-only answer | Covers Jev, DeepSeek, OpenAI, local servers. |
| Classifier fallback | Static `fallback_table` (label → target) in policy | Matches PRD §7 guardrail. |
| Analysis labeler | Same transport, **fixed prompt, fixed taxonomy**, separately configured model; keyword heuristic when no model configured | Must never depend on the policy. |
| Experiment v1 | `off` or `interleave`; `bandit` accepted but behaves as `interleave` with a warning | Bandit deferred; config shape already final. |
| Statistics | Compare **log(cost)** with Welch t-test, α = 0.10 default; MDD from pooled variance at power 0.8 | PRD §6. |
| Host interface | Skill drives CLI; hooks only sweep orphans | PRD §1. |
| Prompt handoff | Always via file / stdin, never argv | Long prompts, quoting. |

## 3. Repository layout

```
package.json                    npm workspaces: core, adapters/*
core/                           package "evener" (bin: evener)
  package.json  tsconfig.json
  src/
    cli.ts                      entry; subcommand dispatch; all output JSON unless --format md
    config.ts                   EVENER_HOME, policy + pricing load/validate/hash, defaults
    types.ts                    event payload types, enums (single source of truth)
    store.ts                    node:sqlite wrapper, migrations, appendEvent, task projections
    classifier.ts               OpenAI-compatible call, prompt rendering, timeout, fallback
    labeler.ts                  fixed taxonomy labeler (model or heuristic)
    router.ts                   decide(): rules → experiment arm → classifier → fallback
    experiment.ts               arm assignment
    lifecycle.ts                task create / accept / next / close / feedback / override / sweep
    dispatch/
      index.ts                  runDispatch(), common process handling, timeout, usage normalisation
      codex.ts                  codex exec --json adapter
      dsh.ts                    dsh headless --json adapter
    pricing.ts                  usage → USD
    report.ts                   metrics, stratification, MDD, suggestions, md/json rendering
    apply.ts                    evener apply <n>
    export.ts                   jsonl / otel-json export
  test/                         node:test files, *.test.ts, run against dist/
  templates/policy.default.yaml templates/pricing.default.yaml
adapters/
  claude-code/
    .claude-plugin/plugin.json
    skills/evener/SKILL.md
    hooks/hooks.json
    scripts/sweep.sh
    commands/evener-report.md
    README.md
design/                         PRD, this spec, decisions, task briefs for delegated work
```

Build: `npm run build` → `tsc -b`. Test: `npm test` → build then `node --test core/dist/test/`. No bundler.

## 4. Event schema (final)

Common envelope (every row in `events`):

```ts
interface Envelope {
  event_id: string;        // uuid v4
  task_id: string;         // uuid v4
  round: number;           // 1-based, +1 on every redispatch
  ts: string;              // ISO-8601 UTC
  type: EventType;
  host: string;            // "claude-code"
  host_session_id: string | null;
  policy_version: string;  // sha256 of canonical policy yaml, first 12 hex
  schema_version: 1;
  data: object;            // payload per type, below
}
```

Payloads (field names are final; enums are closed):

```yaml
task.created:
  description_hash: string           # sha256 hex
  description_excerpt: string|null   # first 200 chars, only if privacy.store_description_excerpt
  repo_fingerprint: string|null      # sha256 of git remote url + root path
  pre_features: {description_chars: int, files_mentioned: int, repo_files: int|null, language: ts|js|py|go|rs|java|kt|rb|php|cs|cpp|c|swift|sh|sql|md|yaml|json|other|null, has_repro: bool, cross_file: bool, time_bucket: lt15m|15m_1h|1h_4h|gt4h|unknown}
  analysis_label: bugfix|feature|refactor|test|docs|mechanical|question|unknown
  labeler_model: string              # "heuristic" or model id
  constraints: [string]              # free-form tags from host, e.g. private_path
  arm: string|null                   # experiment arm assigned at creation

route.decided:
  target: string                      # a key in policy.targets
  candidates: [{target: string, score: number}]
  rationale: string
  decided_by: rule|classifier|fallback|override
  rule_id: string|null
  classifier_model: string|null
  classifier_latency_ms: int|null
  classifier_cost_usd: number|null
  arm: string|null                    # "A"|"B"|null
  escalated_from: string|null

dispatch.started:
  target: string
  target_version: string|null
  model: string|null
  context_bytes: int
  command: string                     # argv joined, for audit

dispatch.finished:
  status: success|error|timeout|budget_exceeded
  wall_ms: int
  usage: {input: int, cached_input: int, output: int, reasoning: int}   # normalised, see §7
  usage_raw: object                   # as emitted by the target
  cost_usd: number
  price_table_version: string
  diff_stats: {files: int, insertions: int, deletions: int}|null
  tool_calls: int|null
  exit_code: int|null
  target_session_id: string|null      # codex thread_id / dsh sessionId
  output_path: string|null            # file holding final message

acceptance.finished:
  verdict: accepted|rejected
  checks: [{name: tests|lint|build|scope|other, result: pass|fail|skipped}]
  review_verdict: pass|fail|skipped
  reject_reason: tests_failed|build_failed|out_of_scope|incomplete|style|misunderstood|regression|other|null
  reviewer_cost_usd: number
  reviewer_wall_ms: int

task.redispatch:
  reason: string                      # the reject_reason that triggered it
  context_delta: added|modified|unchanged
  next_target: string
  kind: retry|escalate

task.closed:
  outcome: accepted|handed_to_human|abandoned
  total_rounds: int
  total_cost_usd: number              # all dispatches + all acceptance + all classifier calls
  total_wall_ms: int

user.feedback: {rating: up|down, comment: string|null}
user.override: {from: string, to: string}
post.revert:   {days_after: int, reverted_ratio: number}
target.circuit: {target: string, state: open|closed, until: string|null}
```

SQLite DDL (migration 1):

```sql
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL, round INTEGER NOT NULL,
  ts TEXT NOT NULL, type TEXT NOT NULL, host TEXT NOT NULL, host_session_id TEXT,
  policy_version TEXT NOT NULL, schema_version INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX events_task ON events(task_id, seq);
CREATE INDEX events_type_ts ON events(type, ts);
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY, created_ts TEXT NOT NULL, closed_ts TEXT,
  host TEXT NOT NULL, host_session_id TEXT, analysis_label TEXT NOT NULL,
  arm TEXT, policy_version TEXT NOT NULL,
  current_round INTEGER NOT NULL DEFAULT 1, current_target TEXT,
  state TEXT NOT NULL,            -- created|routed|dispatching|awaiting_acceptance|closed
  outcome TEXT,                   -- accepted|handed_to_human|abandoned
  first_pass INTEGER,             -- 1 if round 1 accepted
  total_cost_usd REAL NOT NULL DEFAULT 0, total_wall_ms INTEGER NOT NULL DEFAULT 0,
  rating TEXT, overridden INTEGER NOT NULL DEFAULT 0);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- schema_version, etc.
```

## 5. Policy schema (final, `policy.yaml`)

```yaml
schema_version: 1
policy_name: default

classifier:
  model: null                      # null → never call a model, use rules + fallback_table
  endpoint: https://api.deepseek.com/v1
  api_key_env: EVENER_CLASSIFIER_API_KEY
  timeout_ms: 3000
  temperature: 0
  max_tokens: 300
  price: {input_per_mtok: 0.28, output_per_mtok: 0.42}

labeler:
  model: null                      # null → heuristic
  endpoint: null                   # null → reuse classifier endpoint/key
  api_key_env: null
  time_bucket_heuristic:
    lt15m:  {max_files: 1, max_chars: 400}
    15m_1h: {max_files: 3, max_chars: 1500}
    1h_4h:  {max_files: 8, max_chars: 5000}
  prompt_extra: null               # free text appended to the model labeler prompt

taxonomy:
  labels: [bugfix, feature, refactor, test, docs, mechanical, question]   # closed; "unknown" always allowed

targets:
  host:
    description: The current host session does the work itself
    cost_tier: high
    enabled: true
  codex:
    description: OpenAI Codex CLI
    command: [codex, exec, --json, --skip-git-repo-check, --sandbox, workspace-write, -o, "{output_file}", "-"]
    model: gpt-5.1-codex          # for pricing only; null → cost unknown (recorded as 0, flagged)
    api_key_env: OPENAI_API_KEY   # presence check only
    cost_tier: mid
    strengths: [bugfix, feature, test]
    weaknesses: []
    enabled: true
  dsh:
    description: DeepSeek Harness (headless)
    command: [npx, "@deepseek-ai/dsh", --profile, headless, --json]
    model: deepseek-v3.2
    api_key_env: DEEPSEEK_API_KEY
    cost_tier: low
    strengths: [mechanical, docs, test]
    weaknesses: [refactor]
    enabled: true

rules:                              # evaluated in order; first match wins; all conditions in `if` must hold (AND); locked = user cannot override to a non-host target
  - {id: private, if: {constraint: private_path}, then: host, locked: true}
  - {id: question, if: {label: question}, then: host}
  - {id: wide, if: {files_mentioned_gte: 8}, then: host}
  - {id: long_task, if: {time_bucket: gt4h}, then: host}
  - {id: bugfix_no_repro_cross_file, if: {label: bugfix, has_repro: false, cross_file: true}, then: host}

fallback_table:                     # used when classifier.model is null, times out, or errors
  mechanical: dsh
  docs: dsh
  test: dsh
  bugfix: codex
  feature: codex
  refactor: codex
  question: host
  unknown: codex

preferences:
  cost_weight: 0.6
  quality_weight: 0.4
  per_label_bias:
    mechanical: {dsh: 0.8, codex: 0.2}
    refactor: {host: 0.6, codex: 0.3, dsh: -0.5}

escalation:
  chain: [dsh, codex, host]
  retry_same_target_once: true
  escalate_on_reasons: [misunderstood, incomplete, regression]
  never_escalate_on: [style]
  force_escalate_after_same_reason: 2

limits:
  max_rounds_per_task: 3
  max_cost_per_task_usd: 2.00
  max_wall_per_round_s: 900
  daily_budget_usd: null
  acceptance_overhead_warn_task_ratio: 0.30
  acceptance_overhead_warn_weekly_ratio: 0.20
  circuit_breaker: {failures: 3, open_minutes: 30}

privacy:
  store_description_excerpt: false
  private_paths: ["**/secrets/**", "**/.env*"]
  never_delegate_repos: []

experiment:
  mode: off                         # off | interleave | bandit (bandit == interleave in v1)
  arms: {}                          # e.g. {A: policy-a.yaml, B: policy-b.yaml}; paths relative to EVENER_HOME
  assignment: random                # random | by_label_stratified
  alpha: 0.10
  power: 0.80

quality_weights: {first_pass: 0.4, final_pass: 0.2, feedback: 0.3, revert: 0.1}
style_rejection_suspect_ratio: 0.5

host:
  claude_code:
    confirm_before_dispatch: false
    route_subagent_tasks: true
```

`policy_version` = first 12 hex chars of sha256 over the canonical JSON (recursively sorted keys) of the **effective** policy, i.e. after default filling and, under an experiment, after merging the arm file over the top-level file. The hash therefore identifies exactly what routed the task.
Validation errors list every problem with a JSON pointer path; `evener policy validate` exits 2 on error.

When `experiment.mode != off`, the top-level `policy.yaml` is the *experiment* file: its `experiment`,
`limits`, `privacy`, `host`, `quality_weights` sections apply, and each arm file supplies
`classifier`, `labeler`, `targets`, `rules`, `fallback_table`, `preferences`, `escalation`; `taxonomy` and `style_rejection_suspect_ratio` stay
top-level because labels are experiment-wide. The effective `policy_version` is recorded on every event of that task.

`pricing.yaml`:

```yaml
schema_version: 1
models:
  gpt-5.1-codex:   {input_per_mtok: 1.25, cached_input_per_mtok: 0.125, output_per_mtok: 10.0}
  deepseek-v3.2:   {input_per_mtok: 0.28, cached_input_per_mtok: 0.028, output_per_mtok: 0.42}
```
Prices are **placeholders the user must confirm** (listed in decisions-for-user.md).
`price_table_version` = first 12 hex of sha256 of the file.

## 6. Routing algorithm (`evener decide`)

1. Load task; if `state` is not `created` (round 1) or `awaiting_acceptance` (later rounds), error.
2. Circuit breaker: targets with an open circuit are treated as `enabled: false` for this decision.
3. Rules in order: first match → `decided_by: rule`, `rule_id`. A rule has exactly one condition among `constraint`, `label`, `files_mentioned_gte`, `description_chars_gte`.
4. Experiment: if `mode != off` and round == 1, assign arm (random, or stratified by label using hash(task_id) parity within label) and load that arm's sections. Rounds > 1 reuse the task's arm.
5. If round > 1, the target comes from §8 (escalation), not from the classifier.
6. Classifier: if `classifier.model` set, render prompt (§6.1), call with timeout; parse JSON `{target, scores:{target:number}, rationale}`. Validate target is enabled. On any failure → fallback.
7. Fallback: `fallback_table[label]`, else `fallback_table.unknown`, else `host`. If that target is disabled, walk `escalation.chain` for the first enabled one.
8. Emit `route.decided`; update `tasks.current_target`, `state = routed`.

### 6.1 Classifier prompt
System: "You are a routing classifier. Answer with one JSON object and nothing else."
User: rendered policy (targets with description/cost_tier/strengths/weaknesses/enabled, preferences, taxonomy) + task features (label, description_chars, files_mentioned, constraints, excerpt if allowed) + the exact JSON shape. The excerpt is never sent when `privacy.store_description_excerpt` is false; the hash is never sent.

## 7. Dispatch (`evener dispatch`)

```
evener dispatch --task T --prompt-file F [--cwd DIR] [--target X] [--timeout-s N]
```
`--target` defaults to `tasks.current_target`. Steps: emit `dispatch.started`; spawn `targets[X].command` with `{output_file}` substituted, `cwd` = `--cwd` or process cwd, stdin = prompt file content then EOF, stdout parsed line-by-line as JSONL, stderr captured to `$EVENER_HOME/runs/<task>/<round>.stderr`. Kill on timeout (SIGTERM, then SIGKILL after 5 s) → `status: timeout`. Pre-check `api_key_env` presence; missing → `status: error` without spawning (and no circuit-breaker failure).

Normalised usage:
- codex: `input = input_tokens - cached_input_tokens`, `cached_input = cached_input_tokens`, `output = output_tokens`, `reasoning = reasoning_output_tokens` (reasoning is a subset of output; informational).
- dsh: sum over `step_end`: `input = Σ inputTokens`, `cached_input = Σ cacheReadTokens`, `output = Σ outputTokens`, `reasoning = 0`. `cacheWriteTokens` kept in `usage_raw`.
- cost = input·p.input + cached_input·p.cached_input + output·p.output, per million tokens. Missing model or price → cost 0 and `data.cost_unknown = true`.

`diff_stats`: if `cwd` is a git repo, `git diff --shortstat` before/after (numstat parsed). `tool_calls`: count of `tool_call` (dsh) / `item.completed` with `type != agent_message` (codex).

Success criteria: codex exit 0 and a `turn.completed` seen; dsh exit 0 and `final.reason.kind == completed`. Otherwise `error`. Circuit breaker: `limits.circuit_breaker.failures` consecutive `error|timeout` for a target → emit `target.circuit{open}` and skip it in decisions until `until`.

Budget: before spawning, if `tasks.total_cost_usd >= limits.max_cost_per_task_usd` → `status: budget_exceeded` without spawning.

The final message is written to `$EVENER_HOME/runs/<task>/<round>.out.md` and its path returned.

`evener done --task T [--wall-ms N] [--cost-usd C] [--model M] [--status success|error] [--cwd DIR]`
records a round the host executed itself: it appends `dispatch.started` with `target: host`,
`target_version: null`, `context_bytes: 0` and `command: host`, then `dispatch.finished` with
`status` defaulting to `success`, `wall_ms` defaulting to 0, all-zero usage, `usage_raw: {}`,
`cost_unknown: true` when `--cost-usd` is absent, `diff_stats` from `git diff --numstat` in
`--cwd`, and null `tool_calls` / `exit_code` / `target_session_id` / `output_path`. The task must
be in state `routed` with `current_target: host`; host rounds never touch the circuit breaker.

## 8. Acceptance and next step

`evener accept --task T --verdict V [--reason R] [--check name=result ...] [--review pass|fail|skipped] [--reviewer-cost-usd C] [--reviewer-wall-ms W]` emits `acceptance.finished`, sets state `awaiting_acceptance → accepted-pending-close` (we keep `awaiting_acceptance` and let `next` decide). `--reason` required when rejected.

`evener next --task T` returns one of:
- `{action: close, outcome: accepted}` if last acceptance accepted.
- `{action: hand_to_human, why}` if rounds ≥ `max_rounds_per_task`, or cost ≥ budget, or last target was `host`, or chain exhausted.
- `{action: redispatch, kind: retry|escalate, next_target, round}` otherwise:
  - `retry` same target if `retry_same_target_once` and the target has not been retried for this task and reason ∉ `escalate_on_reasons`;
  - else `escalate` to the next enabled target in `escalation.chain` after the current one (chain positions are by name; a target not in the chain escalates to the first chain element after `host`-less filtering). Reasons in `never_escalate_on` always retry (unless retry exhausted → escalate anyway).
  - same reason repeated `force_escalate_after_same_reason` times → escalate.
`next` with `redispatch` emits `task.redispatch`, increments `tasks.current_round`, sets `current_target`, `state = routed`, and also emits a `route.decided` with `decided_by: rule`, `rule_id: escalation`, `escalated_from`.

`evener close --task T --outcome O` emits `task.closed` with totals computed from events. `evener sweep --host-session S` closes every open task of that session as `abandoned` (used by hooks). `evener feedback`, `evener override` emit the obvious events; override with a `locked` rule in force is refused unless `--to host`.

## 9. Report (`evener report`)

```
evener report [--since 14d|YYYY-MM-DD] [--by label|language|time_bucket|has_repro|cross_file] [--format md|json] [--out FILE]
```
Sections exactly as PRD §5. Definitions:
- Quality score per arm/target = Σ w·metric with `quality_weights`; `first_pass` = share of closed tasks accepted in round 1; `final_pass` = share accepted at all; `feedback` = (ups − downs)/(ups+downs) mapped to [0,1]; `revert` = 1 − mean reverted_ratio. If no feedback events in the window, redistribute 0.3 proportionally to first/final. If no revert events, redistribute 0.1 the same way.
- CPAT = Σ total_cost_usd over closed tasks / # accepted tasks. 性价比 = quality / CPAT.
- Comparison between arms: Welch t-test on log(total_cost_usd + 0.001) of accepted tasks; report p and the 90 % CI of the ratio. MDD = minimum relative difference detectable at `alpha`, `power` given current n and pooled variance (normal approximation).
- Cells with n < 8 render "样本不足 / insufficient".
- Target profile: first-pass rate, reject-reason distribution, mean cost/wall, failure rate (`error|timeout`), classifier latency p50/p90.
- Acceptance overhead alert if any task > 30 % or window mean > 20 %.
- Style suspicion: if `style` ≥ 50 % of a target's rejections → flag, exclude style from its quality penalty.
- Suggestions (≤ 3), deterministic, each `{n, field, from, to, evidence}`:
  1. For a label where target X has first-pass ≥ Y's + 0.2 with n ≥ 8 each and lower CPAT → raise `preferences.per_label_bias[label][X]` by 0.2 (clamped ±1).
  2. A target with failure rate > 0.3 (n ≥ 8) → `targets[X].enabled: false`.
  3. If round-2 acceptance rate after `retry` < 0.2 (n ≥ 8) → `escalation.retry_same_target_once: false`.
  Suggestions are saved to `$EVENER_HOME/reports/<ts>.json`; `evener apply <n>` edits the top-level policy (or the named arm with `--arm`) and prints the new `policy_version`.

Weekly generation: `evener report --out $EVENER_HOME/reports/weekly-<date>.md` is documented for cron; the CLI does not schedule itself.

## 10. Claude Code adapter

- `.claude-plugin/plugin.json`: name `evener`, version from core, description, author.
- `skills/evener/SKILL.md`: triggers when the host is about to delegate a self-contained coding sub-task or the user asks to route/delegate/"用 evener". Procedure: write the sub-task description to a temp file → `evener task create` → `evener decide` → if `host`, do it in-session; else write the full prompt file → `evener dispatch` → host performs acceptance (run tests/lint/build it knows, read the output file, check scope) → `evener accept` → `evener next` → loop or `evener close`. Ask for 👍/👎 at the end only if `host.claude_code.confirm_before_dispatch` is true (configurable). Skill text includes the exact JSON fields returned by each command.
- `hooks/hooks.json`: `Stop` and `SubagentStop` → `scripts/sweep.sh` (reads `session_id` from stdin JSON, runs `evener sweep --host-session <id>`; never blocks, exit 0).
- `commands/evener-report.md`: runs `evener report --format md` and shows it.
- Installation: documented via `claude --plugin-dir adapters/claude-code` for local use and a `marketplace.json` for publishing. `evener` must be on PATH (`npm i -g evener` or `npx evener`); the skill uses `npx -y evener` when the bare command is missing (configurable through `EVENER_BIN`).

## 11. CLI contract summary

All commands print one JSON object on stdout (or markdown for `report --format md`) and exit 0; errors print `{error: {code, message}}` and exit 1 (2 for validation). Global flags: `--home DIR` (= `$EVENER_HOME`), `--json` (default), `--quiet`.

| Command | Output keys |
|---|---|
| `init [--force]` | `{home, policy_path, pricing_path, db_path, created: bool}` |
| `policy validate|show|hash [--file]` | `{ok, errors[]}` / policy / `{policy_version}` |
| `task create --description-file F [--files a,b] [--constraint c]* [--host H] [--host-session S] [--cwd DIR]` | `{task_id, analysis_label, pre_features, policy_version, arm}` |
| `decide --task T` | `{task_id, round, target, decided_by, rule_id, rationale, candidates, arm, locked}` |
| `dispatch --task T --prompt-file F [--cwd DIR] [--target X] [--timeout-s N]` | `{task_id, round, target, status, wall_ms, usage, cost_usd, output_path, target_session_id, exit_code}` |
| `done --task T [--wall-ms N] [--cost-usd C] [--model M] [--status success|error] [--cwd DIR]` | `{task_id, round, target, status, wall_ms, cost_usd}` |
| `accept --task T --verdict V ...` | `{task_id, round, verdict}` |
| `next --task T` | `{task_id, action, outcome?, kind?, next_target?, round?, why}` |
| `close --task T --outcome O` | `{task_id, outcome, total_rounds, total_cost_usd, total_wall_ms}` |
| `feedback --task T --rating up|down [--comment]` | `{task_id}` |
| `override --task T --to X` | `{task_id, from, to}` |
| `sweep --host-session S` | `{closed: [task_id]}` |
| `status --task T` / `tasks [--open] [--since]` | task row + events / rows |
| `event --type X --task T [--round n] --data JSON` | `{event_id}` (raw ingestion, validated against §4) |
| `report ...` | markdown or JSON object with every section |
| `apply <n> [--arm A] [--report FILE]` | `{field, from, to, policy_version}` |
| `export --format jsonl|otel [--since]` | writes to stdout |
| `rebuild` | `{tasks}` rebuilt from events |

## 12. Non-goals restated

No task decomposition, no context assembly, no acceptance review inside Evener, no token proxy,
no quota rotation, no GUI, no scheduler, no auto-apply.
