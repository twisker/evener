# T1 — Repository scaffold, config layer, types, CLI skeleton

## Goal
Create the npm-workspace scaffold, the `core` package with build/test wiring, the shared `types.ts`,
the configuration module (policy + pricing load / validate / hash / defaults), the default YAML
templates, and a CLI skeleton that implements `init` and `policy validate|show|hash`.

## Scope (files you own)
- `package.json` (root), `core/package.json`, `core/tsconfig.json`, `.npmrc` if needed
- `core/src/cli.ts`, `core/src/config.ts`, `core/src/types.ts`, `core/src/util.ts` (small helpers: uuid, sha256, nowIso, ensureDir)
- `core/templates/policy.default.yaml`, `core/templates/pricing.default.yaml`
- `core/test/config.test.ts`, `core/test/cli.test.ts`
- `core/README.md` (short: install, init, commands implemented so far)

## Requirements
1. Root `package.json`: `"private": true`, `"workspaces": ["core", "adapters/*"]`, scripts `build` = `npm run build -w core`, `test` = `npm run test -w core`. `core/package.json`: name `evener`, version `0.1.0`, `type: module`, `bin: {evener: "./dist/src/cli.js"}`, `engines.node >=22.13`, `files: [dist, templates]`, scripts `build` = `tsc -p tsconfig.json`, `test` = `npm run build && node --test dist/test/`, `exports` for `./dist/src/index.js` (create `core/src/index.ts` re-exporting config and types). `tsconfig`: target ES2022, module NodeNext, moduleResolution NodeNext, rootDir `.`, outDir `dist`, include `src` and `test`, strict, noUncheckedIndexedAccess, declaration true, sourceMap true.
2. `types.ts`: TypeScript types + runtime const arrays for every enum in spec §4 and §5 (EventType union, Verdict, RejectReason, DispatchStatus, Outcome, Label, DecidedBy, CheckName, CheckResult, ContextDelta, RedispatchKind, ExperimentMode, Assignment, Rating, CircuitState), the `Envelope` interface, a payload interface per event type, a discriminated `EvenerEvent` union, and the `Policy`, `ArmPolicy`, `Pricing`, `TaskRow` interfaces matching §4 DDL and §5 YAML exactly.
3. `config.ts`:
   - `resolveHome(opts?: {home?: string}): string` — `--home` > `$EVENER_HOME` > `~/.evener`.
   - `defaultPolicy(): Policy` and `defaultPricing(): Pricing` — parsed from the templates (templates are the single source of defaults; tests assert the template validates).
   - `loadPolicy(path): Policy`, `loadPricing(path): Pricing` — YAML parse then `validatePolicy(obj): {ok: true, policy} | {ok: false, errors: {path: string, message: string}[]}`. Validation is hand-written (no schema library): required keys, enum membership, number ranges (weights in [0,1], `per_label_bias` values in [-1,1], `timeout_ms > 0`, `limits.*` positive), `rules[].if` has exactly one of `constraint | label | files_mentioned_gte | description_chars_gte`, rule `then`/`fallback_table` values/`escalation.chain` entries must be keys of `targets`, `taxonomy.labels` must be a subset of the closed Label set, `experiment.arms` values are strings. Unknown top-level keys → error; unknown nested keys → warning array (returned alongside).
   - Missing optional sections are filled from defaults (deep merge, arrays replaced not merged).
   - `policyVersion(policy): string` — sha256 over `JSON.stringify` of the object with **recursively sorted keys**, first 12 hex chars. Same for `pricingVersion`.
   - `loadEffectivePolicy(home, {arm?: string})` — implements the experiment-arm merge described in spec §5 (top-level supplies experiment/limits/privacy/host/quality_weights; arm file supplies the rest). Returns `{policy, policy_version, arm}`.
4. `cli.ts`: `parseArgs` based dispatcher. Global options `--home`, `--format json|md` (default json), `--quiet`. Implement `init [--force]` (creates home, copies both templates if missing, creates empty `runs/` and `reports/` dirs, does **not** create the database — that is another task; prints `{home, policy_path, pricing_path, db_path, created}`), `policy validate [--file]`, `policy show [--file]` (prints effective policy as JSON), `policy hash [--file]`. Unknown command → `{error:{code:"unknown_command",message}}` exit 1. Validation failure → exit 2. Leave a clearly marked `registry` object where later tasks add commands: `const commands: Record<string, (ctx, argv) => Promise<unknown>>`. Export `runCli(argv: string[], io: {stdout, stderr, env, cwd}): Promise<number>` so tests call it without spawning. The bin entry calls `runCli(process.argv.slice(2), …)` and exits with its return code.
5. Templates: copy the exact YAML from spec §5 (policy) and the `pricing.yaml` block. Keep the comments.
6. Tests (node:test): template validates with zero errors and zero warnings; `policyVersion` is identical for two objects with different key order and differs when `limits.max_rounds_per_task` changes; validation reports a bad `rules[0].then` with path `/rules/0/then`; `loadEffectivePolicy` merges an arm file correctly (write temp files under `os.tmpdir()`); `runCli(["init","--home",tmp])` creates the files and a second call reports `created: false`; `runCli(["policy","validate","--home",tmp])` returns 0; `runCli(["bogus"])` returns 1 and prints the error JSON.
7. Run `npm install` at the root (network allowed), then `npm test`. Fix until green.

## Out of scope
SQLite store, routing, dispatch, report, adapter. Do not create those files.
