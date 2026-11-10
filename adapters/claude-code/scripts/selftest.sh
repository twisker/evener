#!/bin/sh
# Self-test for the Claude Code adapter. Runs from `npm test` in this workspace.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
adapter_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
repo_root=$(CDPATH= cd -- "$adapter_dir/../.." && pwd)

fail() {
  printf 'adapter selftest: FAIL: %s\n' "$*" >&2
  exit 1
}

check_json() {
  file=$1
  [ -f "$file" ] || fail "missing $file"
  node -e '
const fs = require("node:fs");
const file = process.argv[1];
try {
  JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
}
' "$file" || fail "invalid JSON: $file"
}

printf 'adapter selftest: checking plugin metadata\n'

plugin_json="$adapter_dir/.claude-plugin/plugin.json"
hooks_json="$adapter_dir/hooks/hooks.json"
marketplace_json="$repo_root/.claude-plugin/marketplace.json"
skill_md="$adapter_dir/skills/evener/SKILL.md"

check_json "$plugin_json"
check_json "$hooks_json"
check_json "$marketplace_json"

node -e '
const fs = require("node:fs");
const plugin = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (plugin.name !== "evener") throw new Error("plugin name must be evener");
if (typeof plugin.version !== "string" || plugin.version.length === 0) throw new Error("plugin version missing");
if (typeof plugin.description !== "string" || plugin.description.length === 0) throw new Error("plugin description missing");
if (!plugin.author || plugin.author.name !== "Evener contributors") throw new Error("plugin author missing");
' "$plugin_json" || fail "plugin.json fields are wrong"

node -e '
const fs = require("node:fs");
const hooks = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const expected = {
  SessionStart: "scripts/session-start.sh",
  Stop: "scripts/sweep.sh",
  SubagentStop: "scripts/sweep.sh",
};
for (const [event, script] of Object.entries(expected)) {
  const entries = hooks.hooks && hooks.hooks[event];
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`missing hooks.hooks.${event}`);
  const command = entries[0] && entries[0].hooks && entries[0].hooks[0] && entries[0].hooks[0].command;
  if (typeof command !== "string" || !command.includes(script)) {
    throw new Error(`bad ${event} command`);
  }
}
' "$hooks_json" || fail "hooks.json shape is wrong"

node -e '
const fs = require("node:fs");
const market = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (market.name !== "evener") throw new Error("marketplace name must be evener");
if (!market.owner || market.owner.name !== "Evener contributors") throw new Error("marketplace owner is wrong");
if (!Array.isArray(market.plugins) || market.plugins.length !== 1) throw new Error("marketplace must have one plugin");
const plugin = market.plugins[0];
if (plugin.name !== "evener" || plugin.source !== "./adapters/claude-code") throw new Error("marketplace plugin entry is wrong");
' "$marketplace_json" || fail "marketplace.json fields are wrong"

[ -f "$skill_md" ] || fail "missing SKILL.md"

node -e '
const fs = require("node:fs");
const text = fs.readFileSync(process.argv[1], "utf8");
const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
if (!match) throw new Error("missing frontmatter");
const frontmatter = match[1];
for (const key of ["name", "description", "allowed-tools", "argument-hint"]) {
  if (!new RegExp(`^${key}:`, "m").test(frontmatter)) throw new Error(`missing frontmatter key: ${key}`);
}
if (!/^name:\s*evener\s*$/m.test(frontmatter)) throw new Error("skill name must be evener");
const description = /^description:\s*(.*)$/m.exec(frontmatter);
if (!description || !description[1].startsWith("Route a delegated coding sub-task to the cheapest capable harness")) {
  throw new Error("description does not begin with the required sentence");
}
const lineCount = text.split(/\r?\n/).length;
if (lineCount > 170) throw new Error(`SKILL.md is ${lineCount} lines; maximum is 170`);
' "$skill_md" || fail "SKILL.md checks failed"

printf 'adapter selftest: building core\n'
(cd "$repo_root" && npm run build >/dev/null) || fail "core build failed"

printf 'adapter selftest: checking launcher\n'
[ -x "$adapter_dir/bin/evener" ] || fail "bin/evener is not executable"
help_output=$("$adapter_dir/bin/evener" help) || fail "bin/evener help failed"
[ -n "$help_output" ] || fail "bin/evener help produced no output"
case "$help_output" in
  *'"commands"'*) ;;
  *) fail "bin/evener help does not print \"commands\"" ;;
esac

printf 'adapter selftest: checking pinned core resolution\n'
tmp_plugin=$(mktemp -d)
fake_plugin="$tmp_plugin/evener-plugin"
fake_cli="$fake_plugin/node_modules/evener/dist/src/cli.js"
mkdir -p "$fake_plugin"
cp -R "$adapter_dir/." "$fake_plugin/"
mkdir -p "$(dirname -- "$fake_cli")"
printf '%s\n' 'console.log(JSON.stringify({ fake: true }));' > "$fake_cli"
fake_output=$(EVENER_BIN= "$fake_plugin/bin/evener") || fail "bin/evener failed with a fake node_modules core"
case "$fake_output" in
  *'"fake":true'*) ;;
  *) fail "bin/evener did not run the pinned node_modules core" ;;
esac

printf 'adapter selftest: checking SessionStart hook\n'
tmp_home=$(mktemp -d)
trap 'rm -rf "$tmp_home" "$tmp_plugin"' EXIT HUP INT TERM

session_start_output=$(
  printf '%s\n' '{"session_id":"abc"}' \
    | EVENER_HOME="$tmp_home" sh "$adapter_dir/scripts/session-start.sh"
) || fail "session-start.sh failed with valid input"
case "$session_start_output" in
  *abc*) ;;
  *) fail "session-start.sh did not include the session id" ;;
esac

printf 'adapter selftest: checking sweep hook\n'

sweep_output=$(
  printf '%s\n' '{"session_id":"x","stop_hook_active":false}' \
    | EVENER_HOME="$tmp_home" sh "$adapter_dir/scripts/sweep.sh"
) || fail "sweep.sh failed with stop_hook_active=false"
[ -z "$sweep_output" ] || fail "sweep.sh wrote to stdout"

stop_output=$(
  printf '%s\n' '{"session_id":"x","stop_hook_active":true}' \
    | EVENER_HOME="$tmp_home" sh "$adapter_dir/scripts/sweep.sh"
) || fail "sweep.sh failed with stop_hook_active=true"
[ -z "$stop_output" ] || fail "sweep.sh wrote to stdout when stop_hook_active=true"

if command -v claude >/dev/null 2>&1; then
  printf 'adapter selftest: running claude plugin validate\n'
  claude plugin validate "$adapter_dir" || fail "claude plugin validate failed"
else
  printf 'adapter selftest: claude not on PATH; skipping plugin validation\n'
fi

printf 'adapter selftest: ok\n'
