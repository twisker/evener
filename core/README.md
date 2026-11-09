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

## Commands implemented so far

| Command | Description |
|---|---|
| `init [--force]` | Create the Evener home and default config files |
| `policy validate [--file]` | Validate a policy file (exit 2 on errors) |
| `policy show [--file]` | Print the effective policy as JSON |
| `policy hash [--file]` | Print the canonical policy version |

All commands print one JSON object on stdout. Errors print
`{error: {code, message}}` and exit non-zero.
