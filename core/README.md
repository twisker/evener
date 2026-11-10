# evener core

Host-independent routing engine and CLI for Evener.

## Install / build

```sh
npm install          # from the repository root
npm run build        # builds core to core/dist
npm test             # build + node:test suite
```

The CLI entry point is `core/dist/src/cli.js` (`bin: evener` once packaged).

## Getting started

```sh
node core/dist/src/cli.js init
node core/dist/src/cli.js policy validate
node core/dist/src/cli.js policy show
node core/dist/src/cli.js policy hash
```

`init` creates `$EVENER_HOME` (default `~/.evener`) with `policy.yaml`,
`pricing.yaml`, empty `runs/` and `reports/` directories, and the SQLite database
`evener.sqlite` (WAL mode) with its schema.

Global flags: `--home DIR`, `--format json|md`, `--quiet`.

## Labeler

The analysis labeler assigns each task a fixed-taxonomy label, a time bucket and a
`has_repro` flag; it only stratifies reports and never influences routing. By default it
calls `deepseek-flash` at `https://api.deepseek.com/v1` with thinking disabled, using
`DEEPSEEK_API_KEY` (the same key dsh needs). A call costs roughly $0.0001 per task at
the default DeepSeek flash off-peak/list price; when the key is missing or the call fails,
`task create` falls back to the keyword heuristic and prints a warning on stderr. Set
`labeler.model: null` in `policy.yaml` to disable the model and use heuristics only.

## Pricing and peak schedules

`pricing.yaml` holds per-model per-million-token prices. A model price may name an optional
top-level `peak_schedules` entry (`tz`, `windows`, `weekdays_only`, `factor`); the listed
price is the off-peak/list price and is multiplied by `factor` inside the local-time windows
on weekdays (public holidays are not modelled). Every `dispatch.finished` records
`pricing_period` as `peak`, `off` or `flat` (no schedule), and the classifier/labeler inline
prices accept the same `peak: <schedule>` key. `pricingPeriod(schedule, at)` is the exported
classifier used by both the dispatcher and those inline-price call sites.

## Update check

`evener update-check [--offline] [--force]` is notify-only: it compares the running
`packageVersion()` with the registry's `latest` and never downloads or applies an
update. A real check sends exactly one `GET <registry>/evener/latest` with
`Accept: application/json` (8 s timeout) and no task data, then caches
`{checked_at, current, latest, error}` in `$EVENER_HOME/update-check.json`. The
default registry is `https://registry.npmjs.org`; a successful answer is reused for
`update_check.interval_hours` (default 24) unless `--force` is given. `--offline`
reads the cache only, and network/parse failures are recorded in `error` while
keeping the previous `latest`; the command still exits 0.

Turn it off with `update_check.enabled: false`, or by setting any of
`EVENER_NO_UPDATE_CHECK`, `NO_UPDATE_NOTIFIER`, `CI`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` to a non-empty value. The Claude Code
SessionStart hook uses `--offline` for its one-line notice and refreshes the cache
in the background only when those variables are unset.

## Web panel

`evener ui` starts a local, read-only dashboard over the same SQLite store and
`runs/` directory the CLI uses. It binds `127.0.0.1` only; the default port is
7331 and `--port 0` asks the OS for a free port. The command prints
`{url, home, pid}` immediately, opens the browser unless `--no-open` is given, and
serves until SIGINT/SIGTERM. There is no authentication and no mutating route.

```sh
node core/dist/src/cli.js ui --port 7331 --no-open
```

| Route | Returns |
|---|---|
| `GET /` | `core/ui/index.html`, with `Cache-Control: no-store` |
| `GET /api/overview` | `{now, home, policy_name, policy_version, experiment_mode, arms: string[], pricing_version, open_tasks, tasks_7d, accepted_7d, cost_7d_usd, update: {current, latest: string\|null, available: bool, checked_at: string\|null}}` |
| `GET /api/tasks?state=open\|closed\|all&since=&limit=&host_session=` | `{tasks: TaskSummary[]}` newest first; `state` default `open`, `limit` default 50 |
| `GET /api/task/:id` | `{task: TaskRow, rounds: RoundView[], events: EvenerEvent[]}` |
| `GET /api/task/:id/output?round=n&stream=out\|stderr&tail=BYTES` | `text/plain` body of `runs/<task>/<round>.out.md` (or `.stderr`); last `tail` bytes when given; 404 when absent |
| `GET /api/report?since=&by=` | the `Report` object of `evener report --format json` |
| `GET /api/sessions?since=` | `{sessions: SessionView[]}` newest first |
| `GET /api/stream` | `text/event-stream`; one `change` event with `{seq}` when `max(events.seq)` grows (polled every 1 s); `: ping` every 15 s |

The page (`core/ui/index.html`) is a single static file with inline CSS/JS/SVG,
bilingual labels, light/dark support and a 390 px layout. All arithmetic happens in
core; the page only renders API values.

## Commands implemented so far

| Command | Description |
|---|---|
| `init [--force]` | Create the Evener home and default config files |
| `policy validate [--file]` | Validate a policy file (exit 2 on errors) |
| `policy show [--file]` | Print the effective policy as JSON |
| `policy hash [--file]` | Print the canonical policy version |
| `ui [--port N] [--no-open]` | Serve the local read-only web panel |
| `update-check [--offline] [--force]` | Notify-only version check against the npm registry |

All commands print one JSON object on stdout. Errors print
`{error: {code, message}}` and exit non-zero.
