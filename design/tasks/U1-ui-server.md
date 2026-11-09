# U1 — `evener ui` read-only HTTP server and JSON API

Read first: `design/spec-v1.md` §13 (the contract; follow it exactly), §11, §9. Then `core/src/cli.ts` (command registry, global options, `CommandContext`), `core/src/commands/{report,task}.ts` (`parseSince`, `listTasks`, `status`), `core/src/store.ts` (`Store` interface: `listTasks`, `getEvents`, `listEvents`), `core/src/report.ts` (`buildReport`, `roundTarget`), `core/src/config.ts`, `core/src/types.ts`.

Files you may create/modify: `core/src/ui/**` (new), `core/src/commands/ui.ts` (new), `core/src/cli.ts` (only: import + `registerUi(commands)` + a usage line), `core/package.json` (`files` adds `"ui"`), `core/test/ui-*.test.ts` (new), `core/README.md`. Do **not** modify `report.ts`, `store.ts`, `types.ts`, `pricing.ts`, `dispatch/**`, `lifecycle.ts` (another task is editing them). If you need a helper from them, import what exists today.

Another task (F12) is concurrently adding `model_ms`, `tool_ms`, `pricing_period` to `dispatch.finished` and `reviewer_usage`, `self_accepted` to `acceptance.finished`. Read those fields defensively (`(data as Record<string, unknown>)["model_ms"] ?? null`) so this task builds and tests with or without F12 merged; emit them as `null`/`false`/`"flat"` when absent.

## 1. Server (`core/src/ui/server.ts`)

- `export function startUiServer(opts: {home: string; port: number; openBrowser: boolean; io: CliIO}): Promise<{url: string; port: number; close(): Promise<void>}>` using `node:http`. Bind `127.0.0.1` only. `port: 0` → OS-assigned.
- Routes exactly as spec §13. Reject anything else with 404 JSON. Only `GET`/`HEAD`; other methods → 405.
- `GET /` serves `core/ui/index.html` resolved relative to the package (`new URL("../../ui/index.html", import.meta.url)` from `dist/src/ui/`); if the file is missing, serve a minimal placeholder page that says the UI file is absent (so the server task does not depend on the page task). `Cache-Control: no-store`.
- Output route: resolve `runs/<task>/<round>.out.md` or `.stderr` under `home`; refuse task ids or rounds that are not `[A-Za-z0-9-]+` / integers (path traversal guard); `tail=BYTES` reads only the last N bytes (`fs.open` + `read` at offset), never the whole file into memory when `tail` is given.
- `/api/stream`: SSE. Poll `SELECT max(seq) FROM events` every 1000 ms via a store method if one exists, else `listEvents` is not acceptable (too heavy) — add a tiny read-only query through the existing `DatabaseSync` handle if `Store` exposes it; if it does not, add `maxSeq(): number` to the Store **interface only via a local wrapper** in `core/src/ui/` that opens its own read-only `DatabaseSync` on the same path (WAL allows concurrent readers). Send `: ping\n\n` every 15 s. Clean up timers on client disconnect and on `close()`.
- Every handler is wrapped: thrown errors become `{error: {code: "internal", message}}` 500; `CommandError`-like validation errors 400.

## 2. Projections (`core/src/ui/views.ts`)

Pure functions over `TaskRow[]` + `EvenerEvent[]`, unit-tested without HTTP:

- `taskSummaries(tasks, eventsByTask, now)` → `TaskSummary[]` (spec §13).
- `roundViews(events)` → `RoundView[]`: group by `round`; `dispatch_status` is `running` when `dispatch.started` exists without `dispatch.finished`; `redispatch` from `task.redispatch`; `stderr_path` = `output_path` with `.out.md` → `.stderr` when `output_path` is set.
- `sessionViews(tasks, eventsByTask, since)` → `SessionView[]`: group by `host_session_id` (null → key `"(none)"`); cost split per spec §13 definitions; `peak_cost_usd`/`off_cost_usd` from `pricing_period` (`flat` counts as `off`); `reviewer_tokens` summed, null if no acceptance carried usage.
- `overview(tasks, events, policy, pricingVersion, now)`.

## 3. Command (`core/src/commands/ui.ts`)

`evener ui [--port N] [--no-open]`: starts the server, prints `{url, home, pid}` as the command's JSON output **immediately** (do not wait for SIGINT before printing), opens the browser via `child_process.spawn` of `open` (darwin) / `xdg-open` (linux) / `cmd /c start ""` (win32) with `stdio: "ignore"`, `detached`, errors ignored; then keeps the process alive until SIGINT/SIGTERM, closing the server. Respect `--home`. Register in `cli.ts` with a usage line.

## 4. Tests (node:test, real HTTP on port 0, temp `EVENER_HOME`)

a. `views.ts`: summaries, round views (running / finished / redispatch), session split (delegated vs host vs reviewer vs overhead; peak vs off; `(none)` session), overview counts.
b. Server: start on port 0 against a temp home seeded through the existing store API (create a task with a `task.created`, `route.decided`, `dispatch.started`, `dispatch.finished`, `acceptance.finished`, write a fake `runs/<task>/1.out.md`); assert `/api/overview`, `/api/tasks?state=all`, `/api/task/:id`, `/api/task/:id/output?round=1&tail=5` returns the last 5 bytes, `/api/report`, `/api/sessions`, 404 for unknown route and for `../` in the task id, 405 for POST, `/` serves HTML or the placeholder.
c. SSE: connect, append an event through the store, receive a `change` event within 3 s; `close()` ends the response.
d. No test opens a browser (`openBrowser: false`).

## 5. Docs

`core/README.md`: a "Web panel" section (command, port, read-only, routes table copied from spec). `npm test` green from the repo root; report the count.
