#!/bin/sh
# SessionStart hook: tell the host this session's Claude Code id.
# Hook JSON on stdin: {"session_id": "...", "hook_event_name": "SessionStart", ...}
# Prints one hookSpecificOutput JSON object, or nothing for malformed input.
# Always exits 0 so the hook never blocks the session.
set -eu

input=$(cat)

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
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `Evener: this Claude Code session id is ${id}. Pass it as --host-session ${id} to \`evener task create\` and \`evener tasks\`.`,
      },
    }));
  } catch {
    // Malformed hook input: print nothing.
  }
});
' 2>/dev/null || true

exit 0
