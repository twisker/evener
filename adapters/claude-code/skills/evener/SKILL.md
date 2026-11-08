---
name: evener
description: Route a delegated coding sub-task to the cheapest capable harness (Codex CLI, DeepSeek Harness or this session) and record cost/quality. Use when about to delegate a self-contained coding task, when the user says 路由/委派/用 evener/route this/delegate this, or when running /evener:evener.
allowed-tools: Bash(evener *), Bash(cat *), Bash(mktemp *)
argument-hint: "task description or delegation request"
---

# Evener: route a delegated task

Use when you are about to hand a self-contained coding sub-task to another harness —
including 路由 / 委派 / 用 evener / "route this" / "delegate this".

Every Evener command prints exactly one JSON object. On failure it prints
`{error: {code, message}}` and exits non-zero. Read the keys below; do not invent any.

**Launcher fallback.** The plugin's `bin/` directory is on PATH while enabled, so bare
`evener` normally works. If it is not found, use `"${CLAUDE_PLUGIN_ROOT}/bin/evener"`
instead. `${CLAUDE_PLUGIN_ROOT}` is substituted inside this skill, not exported to Bash.

## 1. Put the description in a temp file
Never pass the task description on argv.

```sh
DESC=$(mktemp)
```
Write the sub-task description to `$DESC` (Write tool, or
`cat > "$DESC" <<'EOF' ... EOF`): goal, relevant files, constraints, acceptance criteria.

## 2. Create the task and route it

```sh
evener task create --description-file "$DESC" --files path/a.ts,path/b.ts \
  --host claude-code --cwd "$PWD"
# Add --host-session <session id> only when you actually know it; otherwise omit it.
```

Returns `{task_id, analysis_label, pre_features, policy_version, arm}`.
Use its `task_id` as `$TASK` below.

```sh
evener decide --task "$TASK"
```

Returns `{task_id, round, target, decided_by, rule_id, rationale, candidates, arm, locked}`.

Branch on `target`:

- **`host`** — do the work yourself in this session. Afterwards still call
  `evener accept` and then `evener next` (and close) so the data is complete.
- **`codex` or `dsh`** — compose the *full* prompt for that target in a new temp file:

  ```sh
  PROMPT=$(mktemp)
  ```

  Include the task text, relevant file paths, acceptance criteria, and the instruction
  **"do not touch other files"**. Then:

  ```sh
  evener dispatch --task "$TASK" --prompt-file "$PROMPT" --cwd "$PWD"
  # Optional: --target <codex|dsh> --timeout-s <seconds>
  ```

  Returns `{task_id, round, target, status, wall_ms, usage, cost_usd, output_path,
  target_session_id, exit_code}`. Read the final message via `cat "$OUTPUT_PATH"`
  (the `output_path` value) and inspect `git diff`.

## 3. Acceptance is your job, not Evener's

For every round, after the work is done:

1. Run the project checks that exist — tests, lint, build (`npm test`, etc.).
2. Inspect `git diff` for correctness and unrelated changes.
3. Check scope: only the files named in the task should change.

Then record the verdict:

```sh
evener accept --task "$TASK" --verdict accepted \
  --check tests=pass --check lint=pass --check build=pass --check scope=pass
# Or, when rejecting (--reason is required):
evener accept --task "$TASK" --verdict rejected --reason tests_failed --check tests=fail
```

- `--verdict`: `accepted` or `rejected`.
- `--reason` (rejected only), verbatim enum: `tests_failed`, `build_failed`,
  `out_of_scope`, `incomplete`, `style`, `misunderstood`, `regression`, `other`.
- `--check name=result`, repeatable; name is `tests`, `lint`, `build`, `scope` or
  `other`; result is `pass`, `fail` or `skipped` (use `skipped` for absent checks).
- `--review pass|fail|skipped`, `--reviewer-cost-usd C`, `--reviewer-wall-ms W`
  record your review overhead.

Returns `{task_id, round, verdict}`.

## 4. Ask what happens next, then loop

```sh
evener next --task "$TASK"
```

Returns `{task_id, action, outcome?, kind?, next_target?, round?, why}`.

- **`redispatch`** — build an improved prompt (add missing context, name the failure to
  fix) and dispatch again with the same command as step 2. `next` already advanced the
  round and selected `next_target`; do not call `decide` again.
- **`hand_to_human`** — stop and tell the user what is blocked and `why`. Close the data
  with `evener close --task "$TASK" --outcome handed_to_human`.
- **`close`** — close the task with the accepted outcome:

  ```sh
  evener close --task "$TASK" --outcome accepted
  ```

  Returns `{task_id, outcome, total_rounds, total_cost_usd, total_wall_ms}`.

Use `--outcome abandoned` only when the work is being dropped.

## 5. Feedback and overrides

When the user gives a thumbs up/down or comments on quality:

```sh
evener feedback --task "$TASK" --rating up
evener feedback --task "$TASK" --rating down --comment "wrong file touched"
# Returns {task_id}
```

When the user asks to use a different target:

```sh
evener override --task "$TASK" --to codex
# Returns {task_id, from, to}. Then continue with dispatch (or next) as appropriate.
```

`override` is refused for a locked rule unless `--to host`.

## 6. What to tell the user

One line per completed round: target, status, and cost from `dispatch`
(`target`, `status`, `cost_usd`). End with the totals from `close`:

```
Round 1: codex — success — $0.18
Round 2: host — accepted — $0.04
Closed: accepted in 2 rounds — total $0.22, 7m 20s
```

Mention any `hand_to_human` reason and the final outcome. Do not paste the task
description unless privacy.store_description_excerpt is enabled.
