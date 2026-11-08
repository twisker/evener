#!/bin/sh
# Stop / SubagentStop safety net: close orphaned Evener tasks for the session.
# Hook JSON on stdin: {"session_id": "...", "hook_event_name": "...", "stop_hook_active": false}
# Always exits 0 and writes nothing to stdout.
set -eu

input=$(cat)

session_id=$(
  printf '%s' "$input" | node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(raw);
    if (payload === null || typeof payload !== "object") return;
    if (payload.stop_hook_active === true) return;
    if (typeof payload.session_id !== "string" || payload.session_id.length === 0) return;
    process.stdout.write(payload.session_id);
  } catch {
    // Malformed hook input: do nothing.
  }
});
' 2>/dev/null
) || session_id=""

if [ -z "$session_id" ]; then
  exit 0
fi

"$(dirname "$0")/../bin/evener" sweep --host-session "$session_id" >/dev/null 2>&1 || true

exit 0
