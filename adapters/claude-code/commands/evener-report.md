---
description: Show the Evener routing report
allowed-tools: Bash(evener *)
---

Run:

```sh
evener report --format md --since ${1:-14d}
```

Show the command's output verbatim inside a fenced block. Do not summarize, edit,
or reorder the report. If the command fails, show the `{error: {code, message}}`
JSON exactly. If bare `evener` is not found, retry with
`"${CLAUDE_PLUGIN_ROOT}/bin/evener" report --format md --since ${1:-14d}`.
