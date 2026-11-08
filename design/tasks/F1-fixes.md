# F1 — Post-review fixes (batch)

Each item is small. Keep `npm test` green; add or adjust a test for every item.

1. `core/src/lifecycle.ts` `decideNext`: the repeated-same-reason counter must count only rejections whose round was dispatched to the **current target** (PRD §7: "同目标同原因重复驳回"). Join `acceptance.finished` events to the `route.decided`/`task.redispatch` target of the same round. Add a test: dsh rejected `incomplete` → escalated to codex → codex rejected `incomplete` once → codex gets its retry (not forced escalation).
