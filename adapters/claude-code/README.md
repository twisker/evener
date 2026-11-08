# Evener for Claude Code

Claude Code plugin for [Evener](../../README.md). It adds the `/evener:evener` skill,
two slash commands, `Stop`/`SubagentStop` cleanup hooks, and an `evener` launcher
that puts the core CLI on the plugin's Bash PATH.

## Requirements

- Claude Code with plugin support.
- Node.js >= 22.13 (the core CLI uses `node:sqlite`).
- The Evener core package. In this checkout run `npm run build` first; the launcher
  also uses a globally installed `evener` or `npx -y evener` when the monorepo
  build is absent.

## Install

From a published repository:

```sh
claude plugin marketplace add <owner>/evener
claude plugin install evener@evener
```

From a local checkout, either add the repository as a marketplace:

```sh
claude plugin marketplace add /path/to/evener
claude plugin install evener@evener
```

or load the plugin directly for a single session:

```sh
claude --plugin-dir adapters/claude-code
```

The marketplace definition lives in `.claude-plugin/marketplace.json` at the
repository root; the plugin manifest is `adapters/claude-code/.claude-plugin/plugin.json`.

## Use

The skill is `/evener:evener` (also triggered by delegation language such as
"route this", "delegate this", 路由, 委派, 用 evener). It records the sub-task,
asks the routing policy for a target, dispatches to Codex CLI or DeepSeek Harness
when selected, performs acceptance in the host session, and records the verdict.

Slash commands:

- `/evener:evener-report [since]` — show `evener report --format md --since <since>`
  (default `14d`).
- `/evener:evener-feedback <up|down>` — record feedback on this session's latest
  closed task.

### CLI resolution

The plugin's `bin/` directory is on the Bash PATH while the plugin is enabled, so
Claude can call `evener` by bare name. `bin/evener` resolves, in order:

1. `$EVENER_BIN` when set (for example `EVENER_BIN=/path/to/core/dist/src/cli.js`
   only works if that file is executable; otherwise point it at an `evener` wrapper).
2. `<plugin root>/../../core/dist/src/cli.js` via `node` (monorepo checkout).
3. A globally installed `evener` found with `command -v`, unless it is this launcher.
4. `npx -y evener`.

## Configuration

Evener reads its configuration from `$EVENER_HOME` (default `~/.evener`):

| Path | Purpose |
|---|---|
| `$EVENER_HOME/policy.yaml` | Routing policy: targets, rules, fallback table, limits, privacy, experiment. |
| `$EVENER_HOME/pricing.yaml` | Per-model input/cached-input/output prices used for cost. |
| `$EVENER_HOME/evener.sqlite` | Local event store (WAL). |
| `$EVENER_HOME/runs/` | Dispatch stdout/stderr artifacts and final messages. |
| `$EVENER_HOME/reports/` | Saved report JSON (suggestions) and weekly markdown. |

Create the directory and default files with `evener init`, then edit
`policy.yaml`. API keys are read from the environment named in the policy and are
never stored by Evener: `EVENER_CLASSIFIER_API_KEY` for the classifier, and
`OPENAI_API_KEY` / `DEEPSEEK_API_KEY` for target preflight checks by default
(`targets.<name>.api_key_env`).

Privacy defaults keep task descriptions out of the store
(`privacy.store_description_excerpt: false`); only a hash and derived features are
recorded. See `design/spec-v1.md` §5 for the full policy schema.

## Hooks

`hooks/hooks.json` registers the same command for `Stop` and `SubagentStop`:

```json
{ "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/sweep.sh" }
```

The hook reads `session_id` and `stop_hook_active` from stdin JSON. Unless
`stop_hook_active` is true, it runs
`evener sweep --host-session <session_id>`, which closes that session's still-open
tasks as `abandoned` with their accumulated totals. The hook never blocks the host:
it discards stdout/stderr, ignores failures, and always exits 0. This is a safety
net only; the skill should close tasks normally.

## Weekly report

Generate a markdown report from cron. The CLI does not schedule itself:

```cron
0 9 * * 1 EVENER_HOME="$HOME/.evener" evener report --format md --since 7d --out "$HOME/.evener/reports/weekly-$(date +\%F).md"
```

Review the report and apply suggestions deliberately with `evener apply <n>`.

## Development

```sh
npm run build                 # builds core to core/dist
npm test -w adapters/claude-code
claude plugin validate adapters/claude-code
claude --plugin-dir adapters/claude-code
```

`npm test` from the repository root runs both the core suite and this adapter's
self-test (`scripts/selftest.sh`). The self-test parses the manifests, checks the
skill frontmatter, runs `bin/evener --help`, exercises `scripts/sweep.sh`, and
runs `claude plugin validate` when `claude` is on PATH.
