# F4 — Benchmark-informed stratification features: language, has_repro, time_bucket, cross_file

Prerequisites: everything on main. Read spec §4, §5, §6, §9; `core/src/{types,features,labeler,classifier,router,config,store,report}.ts` and their tests. This task **may** edit `design/spec-v1.md` (only the places listed in §7 below) and the policy template.

## Why
Leaderboards (SWE-bench Verified's human-time buckets, Aider polyglot's per-language results, RepoBench's cross-file dependency, SWE-bench's FAIL_TO_PASS) show that model rankings flip with difficulty, language and whether a failing test exists — not with task type alone. Reports must be able to stratify on these. The closed `Label` taxonomy stays unchanged.

## Scope
- `core/src/types.ts`, `core/src/features.ts`, `core/src/labeler.ts`, `core/src/classifier.ts` (prompt only), `core/src/config.ts` (schema/validation/defaults), `core/templates/policy.default.yaml`, `core/src/router.ts` (rule conditions), `core/src/store.ts` (migration 2 + projection), `core/src/report.ts`, `core/src/commands/{task,report}.ts`
- tests: extend `features`, `labeler` (in `store.test.ts`/`task-commands.test.ts` or new `labeler.test.ts`), `config`, `router`, `store`, `report` tests
- `design/spec-v1.md` §4 (`pre_features`), §5 (`labeler`, `rules`), §9 (`--by`)

## Requirements
1. `PreFeatures` gains, all required: `language: string | null` (one of `ts, js, py, go, rs, java, kt, rb, php, cs, cpp, c, swift, sh, sql, md, yaml, json, other` or null when no files), `has_repro: boolean`, `cross_file: boolean`, `time_bucket: "lt15m" | "15m_1h" | "1h_4h" | "gt4h" | "unknown"`. Export const arrays `LANGUAGES`, `TIME_BUCKETS`. Existing fields keep their meaning. Old `task.created` events without these fields must still load (treat as `null/false/false/"unknown"` in projection and report).
2. `features.ts`: `language` = most frequent extension among `--files` plus path-like tokens in the description (map extensions → language table; ties → first seen); `cross_file` = `files_mentioned >= 2`; `has_repro` = description matches (case-insensitive) any of: `reproduc`, `repro`, `failing test`, `stack trace`, `traceback`, `steps to`, `expected .* (but|got|actual)`, `复现`, `报错`, `堆栈`, or contains a fenced code block with `Error`/`Exception`. Export the regex list so tests can enumerate it.
3. `time_bucket`: heuristic function `timeBucketHeuristic(pre, thresholds)` using `policy.labeler.time_bucket_heuristic` (new config, defaults below): walk buckets in order and pick the first whose `max_files` and `max_chars` both hold; else `gt4h`. When `labeler.model` is set, the model prompt asks for `{"label": ..., "time_bucket": ...}` in one call with the four buckets described as human time to complete (<15 min, 15 min–1 h, 1–4 h, >4 h) and falls back to the heuristic for any invalid value. Config:
   ```yaml
   labeler:
     model: null
     endpoint: null
     api_key_env: null
     time_bucket_heuristic:
       lt15m:  {max_files: 1, max_chars: 400}
       15m_1h: {max_files: 3, max_chars: 1500}
       1h_4h:  {max_files: 8, max_chars: 5000}
     prompt_extra: null          # free text appended to the model labeler prompt
   ```
   Validate: files/chars positive integers, buckets in that order.
4. Rules: `rules[].if` may now contain **one or more** of `constraint, label, files_mentioned_gte, description_chars_gte, time_bucket, language, has_repro, cross_file` (all must hold = AND). Update validation (at least one key; values typed per key) and `evaluateRules`. Add to the template, after the existing three rules:
   ```yaml
   - {id: long_task, if: {time_bucket: gt4h}, then: host}
   - {id: bugfix_no_repro_cross_file, if: {label: bugfix, has_repro: false, cross_file: true}, then: host}
   ```
   (This encodes the PRD cold-start table rows that the labeler could not express before.)
5. Classifier prompt: include the four new features in the task-features block.
6. Store: migration 2 adds nullable columns `language TEXT, has_repro INTEGER, cross_file INTEGER, time_bucket TEXT` to `tasks`; projection fills them from `task.created.pre_features`; `rebuildTasks` reproduces them; `meta.schema_version` becomes 2; opening a v1 database upgrades in place (test with a DB created by running migration 1 only).
7. Report: `--by label|language|time_bucket|has_repro|cross_file` (default `label`); the strata section groups by the chosen dimension (`has_repro`/`cross_file` render as `true/false`), header names the dimension. `buildReport` accepts `by` as that union; JSON strata rows carry `{dimension, key, arm, ...}`. Suggestion rule 1 keeps using `label`.
8. Spec edits: §4 `pre_features` line → list the new fields; §5 `labeler` block and the `rules` comment → as above; §9 the `--by` option.
9. Tests: feature extraction table (language from mixed files, has_repro positive/negative incl. Chinese, cross_file); time bucket heuristic at each boundary; config rejects a bad `time_bucket` value in a rule with a JSON-pointer path; AND-rule matches only when all conditions hold; migration 1→2 upgrade keeps rows and fills nulls; report `--by time_bucket` groups correctly on a seeded dataset; old-style `task.created` without the new fields still projects.
10. `npm test` green (core + adapter self-test).
