---
description: Record thumbs up/down feedback for this session's latest closed Evener task
allowed-tools: Bash(evener *)
---

The rating is `$1`; it must be `up` or `down`. If it is missing or anything else,
ask the user for `up` or `down` and stop without running anything.

Find the latest closed task for this Claude Code session:

```sh
evener tasks --host-session "$SESSION_ID"
```

Use the session id you know for the current conversation (from the hook payload or
host metadata). If you do not know it, run `evener tasks` instead and tell the user
which task you selected. From the returned `{tasks: [...]}`, choose the row with
`state` equal to `closed` and the greatest `created_ts`; use its `task_id` as
`$TASK`. If there is no closed task, tell the user and stop.

Record the feedback:

```sh
evener feedback --task "$TASK" --rating $1
```

It returns `{task_id}`. Confirm the rating to the user in one line.
