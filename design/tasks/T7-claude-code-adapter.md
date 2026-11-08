# T7 — Claude Code adapter: plugin manifest, skill, hooks, command, launcher

Prerequisites: T1–T6 merged; `npm run build` produces `core/dist/src/cli.js`. Read spec §10 and §11, and `core/README.md`.

## Scope (files you own)
- `adapters/claude-code/.claude-plugin/plugin.json`
- `adapters/claude-code/skills/evener/SKILL.md`
- `adapters/claude-code/hooks/hooks.json`
- `adapters/claude-code/scripts/sweep.sh`
- `adapters/claude-code/bin/evener` (POSIX sh launcher)
- `adapters/claude-code/commands/evener-report.md`, `adapters/claude-code/commands/evener-feedback.md`
- `adapters/claude-code/package.json` (private, name `@evener/claude-code-adapter`, version 0.1.0, no deps; `scripts.test` = `sh ./scripts/selftest.sh`)
- `adapters/claude-code/scripts/selftest.sh`
- `adapters/claude-code/README.md`
- `.claude-plugin/marketplace.json` at repo root (marketplace named `evener`, owner name `Evener contributors`, one plugin entry `evener` with source `./adapters/claude-code`)
- Root `package.json`: add `"test:adapter": "npm test -w adapters/claude-code"` and make root `test` run both.

## Verified facts about the plugin system (do not re-verify, just follow)
- Manifest: `.claude-plugin/plugin.json`, only `name` required; use `name: "evener"`, `version`, `description`, `author: {name}`, `skills: ["./skills/"]`, `hooks: "./hooks/hooks.json"`, `commands: "./commands/"`.
- Files in the plugin's `bin/` directory are on the Bash tool PATH while the plugin is enabled, so Claude can call `evener` by bare name.
- `${CLAUDE_PLUGIN_ROOT}` is substituted inline in SKILL.md and in hooks.json command strings; it is **not** exported as an environment variable to Bash commands Claude runs. Hook processes do receive it as an env var.
- hooks.json needs a top-level `"hooks"` wrapper; `Stop` and `SubagentStop` entries: `{"hooks":[{"type":"command","command":"\"${CLAUDE_PLUGIN_ROOT}\"/scripts/sweep.sh"}]}`. Hook stdin is JSON with `session_id`, `hook_event_name`, `stop_hook_active`. Exit 0 and empty stdout = do nothing.
- Skill frontmatter keys: `name`, `description`, `allowed-tools`, `argument-hint`. Skill directory `skills/evener/SKILL.md` → invocable as `/evener:evener`.
- Local test: `claude --plugin-dir adapters/claude-code`; validation: `claude plugin validate adapters/claude-code` (run it if `claude` is on PATH; otherwise note it).

## Requirements
1. `bin/evener`: resolve the core CLI in this order: `$EVENER_BIN` if set; `<plugin root>/../../core/dist/src/cli.js` (monorepo checkout) via `node`; a globally installed `evener` found with `command -v` that is not this script; else `npx -y evener`. `exec` it with all arguments.
2. `scripts/sweep.sh`: read stdin JSON, extract `session_id` with `node -e` (no jq dependency), run `"$(dirname "$0")/../bin/evener" sweep --host-session "$SESSION_ID" >/dev/null 2>&1 || true`; always exit 0, no stdout. Skip when `stop_hook_active` is true.
3. `SKILL.md` — `name: evener`, `description` beginning with "Route a delegated coding sub-task to the cheapest capable harness (Codex CLI, DeepSeek Harness or this session) and record cost/quality. Use when about to delegate a self-contained coding task, when the user says 路由/委派/用 evener/route this/delegate this, or when running /evener:evener." `allowed-tools: Bash(evener *), Bash(cat *), Bash(mktemp *)`. Body (English, ≤ 150 lines) must give the exact procedure from spec §10 with the real command lines and the JSON keys each returns (copy from spec §11), including:
   - writing the task description to a temp file (`mktemp`) and never passing it on argv;
   - `evener task create --description-file F --files … --host claude-code --host-session <session id if known, else omit> --cwd "$PWD"`;
   - `evener decide --task T`; branch on `target`: `host` → do the work in-session, then still call `accept`/`close` so the data is complete;
   - for `codex`/`dsh`: compose the **full prompt** for the target (task, relevant file paths, acceptance criteria, "do not touch other files") into a file, `evener dispatch --task T --prompt-file P --cwd "$PWD"`, read `output_path`;
   - acceptance is the host's job: run the project's tests/lint/build when they exist, inspect `git diff`, check scope; then `evener accept --task T --verdict accepted|rejected [--reason <enum>] --check tests=pass …`; the reject reason enum list verbatim;
   - `evener next --task T` and the loop on `action` (`redispatch` → repeat dispatch with the improved prompt, `hand_to_human` → stop and tell the user, `close` → `evener close --task T --outcome accepted`);
   - when the user gives thumbs up/down or asks to use a different target: `evener feedback`, `evener override`;
   - a short "what to tell the user" section: one line per round with target, status, cost, and the final totals from `close`.
   - a note that `${CLAUDE_PLUGIN_ROOT}` substitution is available if the bare `evener` is not found, e.g. `"${CLAUDE_PLUGIN_ROOT}/bin/evener"`.
4. `commands/evener-report.md`: frontmatter `description: Show the Evener routing report`, `allowed-tools: Bash(evener *)`; body instructs to run `evener report --format md --since ${1:-14d}` and show the output verbatim. `commands/evener-feedback.md`: `evener feedback --task <latest closed task of this session, via evener tasks --host-session> --rating $1`.
5. `selftest.sh`: `set -eu`; checks that `plugin.json`, `hooks.json`, `marketplace.json` parse as JSON (via `node -e`), that `SKILL.md` has the frontmatter keys, that `bin/evener --help` (after `npm run build` in root) exits 0 and prints JSON or help, and that `echo '{"session_id":"x","stop_hook_active":false}' | scripts/sweep.sh` exits 0 with empty stdout even when no DB exists. Run `claude plugin validate adapters/claude-code` when `claude` exists.
6. README: install (`claude plugin marketplace add <repo>` + `claude plugin install evener@evener`, or `claude --plugin-dir`), configuration pointers (`$EVENER_HOME/policy.yaml`), the hook behaviour, and the weekly cron example line.
7. Root `npm test` green including the adapter self-test.
