# F6b — Pass the global `--quiet` flag through CommandContext

Files you may modify: `core/src/cli.ts`, `core/src/commands/types.ts`, `core/src/commands/task.ts`, `core/test/cli.test.ts`, `core/test/task-commands.test.ts`.

1. Add `quiet?: boolean` to `CommandContext` (commands/types.ts) and set it from the parsed global options where `cli.ts` builds the context (next to `format`).
2. In `commands/task.ts`, `quietRequested` must use only `ctx.quiet === true`. Remove the `process.argv` inspection and the `(ctx as { quiet?: boolean })` cast.
3. Tests: `runCli(["--home", H, "--quiet", "task", "create", …])` with an env lacking the labeler key prints nothing on stderr; without `--quiet` it prints `warning: labeler: no_key…`. Use the existing stubbed-fetch/no-key setup from task-commands.test.ts.
4. `npm test` green; report the count.
