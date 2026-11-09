# What Evener can learn from dsh-agent-teams (read 2026-11-09)

Source: https://github.com/NanmiCoder/dsh-agent-teams at 369c278 (v0.1.29), a DeepSeek Harness plugin that turns one session into a captain with continuable sub-agent members, a task DAG, mailboxes and a live Web panel. ~17k lines TypeScript, host + browser programs, ~30 verify scripts.

Evener is a different product (routing between harnesses, not team orchestration inside one), so most of its scheduler/mailbox machinery does not transfer. The items below do.

## A. Monitoring sub-agents

1. **Disk state is the truth; live activity only decorates it.** `snapshot.ts` reads `team.json` and overlays the harness's real `running/idle/ready` status. The panel is explicitly designed for the case where "the model finished the work but never called `update_task`". Evener analogue: `tasks` projection + runs/ directory is the truth; a `dispatch.started` without `dispatch.finished` should show as *running* if the pid is alive, *orphaned* otherwise (sweep already does the latter; we have no *running* view).
2. **Attempt ids.** Every claimed task carries a monotonic `attempt` and a unique `attemptId`; late updates from a revoked attempt are rejected. Evener's `round` is close, but `accept`/`done` do not carry a dispatch id, so a late `evener done` after a re-dispatch could land on the wrong round. Cheap fix: `dispatch` returns a `dispatch_id`; `accept`/`done` take `--dispatch` and refuse mismatches.
3. **Distinguish `halted` (human stopped it) from `escalated` (automation hit its ceiling)**, and keep both as explicit states with a one-sentence `summary` string for the model. Evener's `next` returns an action but no equivalent human-readable "why we are here" sentence; the skill has to infer it.
4. **Record spawn failures on the record**, not just in logs (`member.spawnError`). Evener's `dispatch.finished{status:error}` has `error_excerpt`; fine. But a circuit-open target is invisible in `decide` output except via rationale text; expose `open_circuits` in the decide payload.

## B. Presenting execution and results

5. **Conversation card + side panel split.** A tiny card in the chat (team name, members, a button) and a detailed panel outside the stream. For Evener in Claude Code (no GUI), the equivalent is: the skill prints one compact line per step (`dsh ▸ bugfix ▸ round 1 ▸ $0.0008 ▸ 42 s`) and `evener report` is the panel. Our SKILL.md currently has no fixed one-line format; add one.
6. **Progress legend by state** (running / claimed / blocked / delivered) instead of a bare percentage, and a *completion card* after the run that lists every task with ✓ / · / ! and never shows a bare "pass" when the verdict is stale. Evener's `close` output could print a compact per-round table (target, status, reason, cost) instead of only totals.
7. **Show the model on the running node.** Each running task shows the short model id; member rows show `provider/model`. Evener's `dispatch` output has `model` but the skill does not surface it; it should, since cost attribution depends on it (D4/D5).
8. **Structured completion evidence.** Quality tasks must complete with `acceptanceResults[]`, `commandsRun[]` (command, status, exitCode, evidence) and `changedPaths[]`; a review must carry `verdict` and `findings[]` with severity, file, line, requiredFix. Evener's `accept` has `tests/lint/build: pass|fail|skipped`, `scope`, and a reject-reason enum, which is the right level for v1, but `commands_run` with exit codes would make the "insufficient context vs target failure" attribution more defensible and cost nothing to store.
9. **Stale verdicts.** They hash the reviewed bytes (`reviewedArtifacts` sha256) so a later edit invalidates the review. Evener could store `diff_hash` on `dispatch.finished` and refuse `accept` if the working tree hash no longer matches (prevents accepting a round whose output was already edited by the host).

## C. Robustness patterns

10. **Model fallback keyed by failure class.** `FALLBACK_FAILURE_CODES = {QUOTA, RATE_LIMIT, AUTH, MISSING_CREDENTIAL, NO_ADAPTER, …}`; only these switch to the configured fallback route, once, and the switch is persisted (`fallbackActive`) and announced to the agent. Evener's escalation chain reacts to *acceptance* reasons; it has no notion of *infrastructure* failure classes. Add `dispatch.finished.error_class` (auth / quota / rate_limit / timeout / crash / other) and let `next` skip straight to the next target for infra classes without counting it as a quality failure of the target. This matters for the report: a quota error is not evidence that dsh is bad at bugfixes.
11. **Output-limit → task failed, not hung.** v0.1.29 marks tasks failed when the model hits its output cap. Evener should detect truncated final messages (codex `turn.completed` without a final message, dsh `final.reason.kind != completed`) and classify as `incomplete` automatically rather than waiting for the host's verdict.
12. **Never rewrite the system prompt mid-session.** They tried progressive tool loading and reverted it because cache-hit rate dropped. Relevant to D18: shrinking the skill is good, but splitting it into "load more later" pieces would hurt Claude Code's prompt cache the same way. Keep SKILL.md one fixed block.

## D. Engineering process worth copying

13. **`compatibility.json` + a doctor script.** A machine-readable matrix of tested host versions (recommended / preview / legacy, per platform) that CI verifies and README reads from. Evener depends on two fast-moving pre-release CLIs (codex, dsh 0.2.x-rc) whose JSON shapes we parse; a `compatibility.json` listing tested codex/dsh versions plus `evener doctor` (checks binaries, versions, keys, runs one `--help`) would turn "it broke after dsh upgraded" into a diagnosed message.
14. **Verification pyramid**: offline pure-function tests → config composition without boot → real headless e2e with one LLM task → GUI. Reports keep request hashes and artifact sha256 so a claim is tied to bytes. Evener already has layers 1 and 3 by hand (`verification-2026-11-09.md`); a `scripts/e2e.sh` that runs one dsh and one codex task against a scratch `EVENER_HOME` and asserts the event sequence would make layer 3 repeatable.
15. **Paired A/B benchmark script** (`harness-model-benchmark.mjs`): freezes inputs (hashes of fixtures and artifacts) in a manifest before the first paid call, refuses mixed runtime cohorts, writes stdout/stderr per phase. Evener's experiment mode is the same idea in production; a `scripts/bench.mjs` that replays a fixed task set through two policies would let us demonstrate the "distinguish two policies" success metric before real usage accumulates.
16. **Bilingual release notes with issue links**, one file per version, and README verified against them by a script. Low cost once we publish.
17. **Append-only evidence** (`supplementalEvidence[]` attributed to attempt) rather than overwriting. Evener's event log already is append-only; keep it that way when adding `feedback` edits (we do).

## Not worth copying

- Mailboxes, DAG scheduler, staged plan approval UI, member tool policies: they solve intra-team coordination, which is out of Evener's scope (host owns decomposition).
- Web panel: Claude Code has no plugin UI surface; the CLI + markdown report is the right surface for v1.
- Their 30-script `pnpm verify` chain is a maintenance burden we do not need at 160 tests.

## Suggested follow-ups (not started)

| # | Item | Size |
|---|---|---|
| F7 | `dispatch_id` on dispatch; `accept`/`done --dispatch` guard; `error_class` on `dispatch.finished`; `next` treats infra classes as "skip target, not a quality failure" | M |
| F8 | Skill output format: one fixed status line per step; `close` prints per-round table; surface model id | S |
| F9 | `compatibility.json` + `evener doctor` | M |
| F10 | `scripts/e2e.sh` repeatable real-CLI smoke; `scripts/bench.mjs` paired policy replay | M |
| F11 | `commands_run[]` with exit codes on `accept`; `diff_hash` stale-accept guard | S |
