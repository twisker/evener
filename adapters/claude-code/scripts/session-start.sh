#!/bin/sh
# SessionStart hook: tell the host this session's Claude Code id and surface a
# notify-only Evener update when the cached check says one is available.
# Hook JSON on stdin: {"session_id": "...", "hook_event_name": "SessionStart", ...}
# Prints one hookSpecificOutput JSON object, or nothing for malformed input.
# Always exits 0 so the hook never blocks the session.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
plugin_root=$(CDPATH= cd -- "$script_dir/.." && pwd)

if [ -n "${EVENER_BIN:-}" ]; then
  evener_bin=$EVENER_BIN
else
  evener_bin="$plugin_root/bin/evener"
fi

input=$(cat)

# `--offline` reads the cache only, so it is normally instant. Run it under a
# Node watchdog anyway: `timeout` is not available on every platform.
update_json=$(
  node -e '
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const bin = process.argv[1];
let executable = false;
try {
  fs.accessSync(bin, fs.constants.X_OK);
  executable = true;
} catch {}
const options = {
  encoding: "utf8",
  timeout: 2000,
  stdio: ["ignore", "pipe", "ignore"],
};
const result = executable
  ? spawnSync(bin, ["update-check", "--offline"], options)
  : spawnSync(process.execPath, [bin, "update-check", "--offline"], options);
if (result.status === 0 && typeof result.stdout === "string") {
  process.stdout.write(result.stdout);
}
' "$evener_bin" 2>/dev/null
) || update_json=""

printf '%s' "$input" | node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(raw);
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
    if (typeof payload.session_id !== "string" || payload.session_id.length === 0) return;
    const id = payload.session_id;
    let context = `Evener: this Claude Code session id is ${id}. Pass it as --host-session ${id} to \`evener task create\` and \`evener tasks\`.`;
    try {
      const update = JSON.parse(process.argv[1]);
      if (
        update !== null &&
        typeof update === "object" &&
        update.available === true &&
        typeof update.latest === "string" &&
        typeof update.current === "string"
      ) {
        context += " Evener " + update.latest + " is available (installed " + update.current +
          "). Update with `claude plugin update evener@evener`, or enable auto-update for the evener marketplace.";
      }
    } catch {
      // No usable cache result: keep the session-id sentence only.
    }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    }));
  } catch {
    // Malformed hook input: print nothing.
  }
});
' "$update_json" 2>/dev/null || true

# Refresh the cache for the next session unless the check is explicitly off.
if [ -n "$evener_bin" ]; then
  case "${EVENER_NO_UPDATE_CHECK:-}${NO_UPDATE_NOTIFIER:-}${CI:-}${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-}" in
    "")
      if [ -x "$evener_bin" ]; then
        nohup "$evener_bin" update-check >/dev/null 2>&1 &
      else
        nohup node "$evener_bin" update-check >/dev/null 2>&1 &
      fi
      ;;
  esac
fi

exit 0
