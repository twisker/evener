# F13 — `tasks.current_target` must follow the dispatched target

Read `core/src/store.ts` (`applyProjection`, `rebuildTasks`), `core/src/report.ts` (`roundTarget`, added by F3 for the same reason), `core/src/ui/views.ts` (`taskSummaries`), and their tests.

Observed: a task routed to `codex` by `route.decided` and then dispatched with `evener dispatch --target dsh` shows `current_target: codex` in `tasks` (and therefore in the panel's Live table) while `current_model` is `deepseek-flash`. The report already attributes rounds to the dispatched target (F3); the projection does not.

Files you may modify: `core/src/store.ts`, `core/src/ui/views.ts`, `core/test/store.test.ts`, `core/test/ui-views.test.ts`.

1. In `applyProjection`, `dispatch.started` sets `current_target = data.target` (and `state = dispatching` as today). `user.override` already updates it; keep that. `rebuildTasks` must agree (it replays the same function).
2. `taskSummaries` keeps using `current_target` from the row; add a test where route says `codex` and dispatch says `dsh` → summary shows `dsh` and model `deepseek-flash`.
3. Store test: same sequence → `listTasks()[0].current_target === "dsh"`; after `rebuildTasks()` still `dsh`.

`npm test` green from the repo root; report the count.
