# T2 — SQLite event store, task projection, `task create`, `event`, `status`, `tasks`, `rebuild`

Prerequisite: T1 is merged (`core/src/{cli,config,types,util}.ts` exist). Read them first; reuse their exports.

## Scope (files you own)
- `core/src/store.ts`, `core/src/labeler.ts` (heuristic part only, see below), `core/src/features.ts`
- `core/src/commands/task.ts` (task create / status / tasks / event / rebuild)
- `core/test/store.test.ts`, `core/test/task-commands.test.ts`
- Edit `core/src/cli.ts` **only** to (a) register the new commands and (b) add the stub registration described in §5.
- Create stub files listed in §5.

## Requirements
1. `store.ts` — `openStore(dbPath): Store` using `node:sqlite` `DatabaseSync`. On open: `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`, run migrations keyed in `meta.schema_version` (migration 1 = DDL in spec §4, verbatim). API:
   - `appendEvent(ev: EvenerEvent): void` — inserts into `events` and applies the projection to `tasks` in one transaction (see §2). Validates `type` and required payload fields against `types.ts` (throw `StoreError` with code `invalid_event`).
   - `getTask(taskId): TaskRow | null`, `listTasks(filter: {open?: boolean, since?: string, hostSessionId?: string}): TaskRow[]`, `getEvents(taskId): EvenerEvent[]`, `listEvents(filter: {since?: string, types?: EventType[]}): EvenerEvent[]`.
   - `rebuildTasks(): number` — truncates `tasks` and replays all events in `seq` order.
   - `withTransaction(fn)`, `close()`.
   - `nextRound(taskId): number`.
2. Projection rules (`applyProjection(row, ev)` must be a pure function exported for tests):
   - `task.created` → insert row: state `created`, round 1, label, arm (from `data.arm` if present else null), policy_version.
   - `route.decided` → `current_target`, `arm` if provided, state `routed`.
   - `dispatch.started` → state `dispatching`.
   - `dispatch.finished` → `total_cost_usd += cost_usd`, `total_wall_ms += wall_ms`, state `awaiting_acceptance`.
   - `acceptance.finished` → `total_cost_usd += reviewer_cost_usd`, `total_wall_ms += reviewer_wall_ms`; if round == 1 set `first_pass` = verdict == accepted ? 1 : 0.
   - `route.decided` with `classifier_cost_usd` → add to `total_cost_usd`.
   - `task.redispatch` → `current_round = round + 1`? **No**: the redispatch event already carries the *new* round number in the envelope; set `current_round = ev.round`, `current_target = data.next_target`, state `routed`.
   - `task.closed` → `closed_ts`, `outcome`, state `closed`.
   - `user.feedback` → `rating`; `user.override` → `overridden = 1`, `current_target = to`.
   - `target.circuit`, `post.revert` → no change to tasks.
3. `features.ts` — `computePreFeatures(description: string, files: string[], cwd?: string): PreFeatures` (`description_chars`, `files_mentioned` = `files.length` + distinct path-like tokens in the description matching `/[\w./-]+\.[a-z]{1,6}/`, `repo_files` = `git ls-files | wc -l` when `cwd` is a git repo else null; use `execFileSync` with a 2 s timeout, swallow errors) and `repoFingerprint(cwd): string | null` (sha256 of `git remote get-url origin` + root path; null outside git).
4. `labeler.ts` — export `labelHeuristic(description: string): Label` with keyword rules (lower-cased): contains `fix|bug|crash|error|regression|broken` → bugfix; `test|spec|coverage` → test; `doc|readme|comment|changelog` → docs; `rename|move|migrate|format|lint|boilerplate|bulk|batch|replace all` → mechanical; `refactor|extract|cleanup|simplify|restructure` → refactor; question mark at end or starts with `why|what|how|explain|where` → question; `add|implement|feature|support|new` → feature; else `unknown`. First matching rule in the order bugfix, question, mechanical, refactor, test, docs, feature. Also export `async labelTask(description, policy, io): Promise<{label, labeler_model}>` that returns the heuristic when `policy.labeler.model` is null; when set, call `classifyWithModel` from `core/src/classifier.ts` **if that module exists**; it does not yet, so for now put the model branch behind a `labelerModelCall` function parameter defaulting to `undefined` and fall back to heuristic. Document in the file header that T3 wires the model path.
5. Stub registration so parallel tasks do not fight over `cli.ts`: create `core/src/commands/router.ts`, `core/src/commands/dispatch.ts`, `core/src/commands/lifecycle.ts`, `core/src/commands/report.ts`, each exporting `export function register(commands: CommandRegistry): void {}` (empty). `cli.ts` imports all five command modules (task + these four) and calls `register(commands)` for each. Define and export `CommandRegistry`, `CommandContext` (`{home, policyPath, pricingPath, dbPath, store: () => Store (lazy), io}`) and `CommandHandler` types in a new `core/src/commands/types.ts`. Move the existing `init`/`policy` commands into `core/src/commands/policy.ts` using the same mechanism.
6. Commands (`commands/task.ts`):
   - `task create --description-file F [--files a,b] [--constraint c]* [--host H=claude-code] [--host-session S] [--cwd DIR]` → loads effective policy (experiment arm assignment happens here when `experiment.mode != off`: `random` = `crypto.randomInt`, `by_label_stratified` = pick arm by `parseInt(sha256(task_id)[0..8],16) % arms.length` — expose `assignArm(policy, taskId, label)` from a new `core/src/experiment.ts`), computes label (heuristic path), features, fingerprint, applies `privacy.private_paths` (if any `--files` entry matches a glob → add constraint `private_path`; implement a small glob matcher supporting `**` and `*`), checks `privacy.never_delegate_repos` (fingerprint or remote url substring → constraint `never_delegate`), emits `task.created`, prints `{task_id, analysis_label, pre_features, policy_version, arm}`.
   - `status --task T` → `{task, events}`. `tasks [--open] [--since 14d|ISO] [--host-session S]` → `{tasks}`.
   - `event --type X --task T [--round n] --data JSON` → validates and appends; `{event_id}`.
   - `rebuild` → `{tasks}`.
   - `init` must now also open the store once so the DB and schema exist (edit `commands/policy.ts` accordingly; `db_path` in output).
7. Tests: open store in a temp dir; append a full happy-path sequence (created → decided → started → finished → acceptance accepted → closed) and assert the `tasks` row (`state`, `first_pass`, totals = dispatch cost + reviewer cost + classifier cost); a rejected-then-redispatched sequence yields `current_round 2`, `first_pass 0`; `rebuildTasks` reproduces identical rows; invalid event type throws; `labelHeuristic` table test (≥ 8 cases); `assignArm` is deterministic for stratified and returns null when mode off; `runCli(["task","create",…])` round-trips through `status`; `event` rejects bad JSON with exit 1.
8. `npm test` green.
