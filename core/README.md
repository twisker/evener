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
`pricing.yaml`, and empty `runs/` and `reports/` directories. It does not create
the SQLite database.

Global flags: `--home DIR`, `--format json|md`, `--quiet`.

## Commands implemented so far

| Command | Description |
|---|---|
| `init [--force]` | Create the Evener home and default config files |
| `policy validate [--file]` | Validate a policy file (exit 2 on errors) |
| `policy show [--file]` | Print the effective policy as JSON |
| `policy hash [--file]` | Print the canonical policy version |

All commands print one JSON object on stdout. Errors print
`{error: {code, message}}` and exit non-zero.
