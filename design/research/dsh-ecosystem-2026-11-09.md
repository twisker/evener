# What Evener can learn from dsh-context and the two "agent-team" plugins (read 2026-11-09)

Companion to `dsh-agent-teams-2026-11-09.md`. Three more DeepSeek Harness plugins were read from source (shallow clones in the session scratchpad):

| Plugin | Commit | What it is |
|---|---|---|
| bowenliang123/dsh-context (npm `dsh-context`) | ea9f2a7 | Context/cost/timing dashboard for every session and agent family; `/context` command |
| limuyang2/agent-team (npm `@limuyang2/dsh-agent-team` 0.1.4) | 3dfc9c2 (2026-08) | A team of independent root agents, each with its own provider/model/skills/permissions, one leader, shared workspace |
| Contexera/dsh-agent-team (npm `@contexera/dsh-agent-team` 0.2.7) | 7076dbd | Persistent named members with memory, projects with owners, tasks with one accountable owner, "the doer never accepts"; append-only operation ledger |

## dsh-context: the one most relevant to Evener

This plugin measures exactly the thing Evener's D17 says is unknown: what the host conversation costs. Everything it does is derived offline from the session log (`fold.ts`), which is what Evener's SQLite event store is for.

1. **Token categories as a billing breakdown.** Every request is split into system prompt / tool definitions / user / injected context / skill injections / tool calls / reasoning / answer, with cache hit rate. Evener records only `input/output/cached` per dispatch. For the *host* side (the skill's own overhead, D18) the useful split is: skill text, CLI JSON results, acceptance reading. Worth adding one field to `acceptance.recorded`: `reviewer_tokens {input, output, cached}` next to `reviewer_cost_usd`, so the report can show "acceptance overhead ratio" in tokens as well as dollars (dollars depend on the unverifiable Claude price, tokens do not).
2. **Timing categories.** `TimingTotals` splits wall time into TTFT, reasoning, text, tool-arg generation, tool execution, idle gap. Evener stores `wall_ms` per round only. Cheap addition from the JSONL we already parse: `model_ms` vs `tool_ms` for dsh (step_end timing) and codex (item timestamps), so the report can say whether a slow target is slow at thinking or slow at running tests.
3. **Peak/off-peak pricing done right.** `isBeijingPeak(time)` classifies each request by its own timestamp; usage is accumulated into `peak` and `off` buckets per (provider, model), and DeepSeek's list price is treated as off-peak with `PEAK_FACTOR = 2`. This is exactly the D21 gap. Implementation for Evener: add `peak_hours` to pricing.yaml (`{tz: "Asia/Shanghai", windows: ["01:00-04:00","06:00-10:00"], weekdays_only: true, factor: 2}` per model) and classify `dispatch.finished.ts`. Note their convention is list-price = off-peak × factor at peak; our template currently stores peak prices, so we would store off-peak and multiply. Pick one and document it.
4. **Price catalogue from models.dev** with a documented resolution ladder (provider branch → maker → unpriced) and explicit "unpriced" states instead of guessing. Evener's `pricing.yaml` is hand-maintained (D3). A `evener pricing refresh` that pulls models.dev for the ids in policy.yaml and writes a dated snapshot would remove D3's "placeholder" caveat; keep the local file as the override. Their rule "never borrow another vendor's price; say unpriced" is the right default for a cost-comparison tool.
5. **Context events** (compaction, prune, inject, model switch, mode switch) are first-class records with token deltas. For Evener, the equivalent host events worth logging are: `policy.changed` (hash before/after, via `apply`) and `pricing.changed`, so a report can mark the bar where cost per task shifted because prices changed rather than behaviour. We hash the policy per event already; pricing hash is recorded but never surfaced.
6. **Command executions card**: every shell run with exit status, wall time, program name, and a "notable" filter. Maps to item 8 in the dsh-agent-teams note (`commands_run[]` on accept).
7. **Fleet view**: the agent family (parent, children) with per-agent cost and a family total. Evener's analogue is the "host session → N tasks → M rounds" tree; `evener report --session <id>` showing total spend of one Claude Code session including delegated work would answer "did delegation pay off *in this session*".
8. **Engineering discipline worth copying**: `docs/host-client-principles.md` says all cost arithmetic happens on the host, the browser only renders; data sources (price list, versions) are fetched and cached host-side with TTL; everything is paginated and windowed. For Evener: keep all math in core, the skill only prints.

## limuyang2/agent-team: Evener's thesis stated as a product

Its README argues the same point as Evener's PRD: sub-agent patterns inherit the parent's expensive model, huge tool catalogue and growing context; "generating a commit message should not run on the architecture model". Their answer is per-member static configuration (provider, model, skills, MCP, permissions, thinking level) chosen by a human; Evener's answer is a policy that routes per task. Two things to take:

9. **Per-member context ring and token stats** (`contextUsage {usedTokens, input, output, cacheRead, cacheWrite, reasoning, contextWindow}`) shown on every member column, plus cache hit rate on hover. Reasoning tokens are tracked separately; Evener normalises codex `reasoning_output_tokens` into output but does not keep the split. Keep `reasoning_tokens` as its own field in `dispatch.finished.usage`: it is the main cost driver when a target thinks too much, and the labeler/classifier already have to disable thinking explicitly.
10. **Message types on the team bus**: `instruction | progress | result | question | warning | system`, and tool nodes with `running | success | error`. Evener's `runs/<task>/<round>.out.md` is the only "result" artefact. A typed `progress`/`question` channel is out of scope, but the *final message classification* is not: when a target's final message is a question or a warning rather than a result, `next` should see that (ties to item 11 of the first note: auto-classify `incomplete`).
11. **Runtime permission presets** per member (read-only / workspace-write / full) chosen per task from the UI. Evener passes codex `--sandbox workspace-write` statically in `targets.codex.command`. A per-label or per-rule `sandbox` override (`review`/`question` → read-only) is a two-line policy extension and reduces the blast radius of cheap models.

## Contexera/dsh-agent-team: governance patterns

Most of it (persistent members, inboxes, attention, reminders) is a team-collaboration product. Four patterns transfer:

12. **"The doer never accepts."** An agent can accept a task only if it never held a claim on it. Evener assumes the host accepts what it delegated, which is fine, but when the host routes to *itself* (`decided_by: rule → host`, `evener done`) the same session both does and accepts. Record that case as `self_accepted: true` on `acceptance.recorded` and show it in the report so host-round quality is not compared one-to-one with delegated-round quality.
13. **Append-only operation ledger with a sequence as the only authority; all views are projections.** Evener already does this (events table + rebuildable `tasks`). Their addition: an optimistic concurrency token (`revision`) that writers must echo back. Evener's equivalent is the `dispatch_id` guard proposed in the first note.
14. **Diagnostics are derived, never persisted** (`capabilityWarnings`, member diagnostics), because persisted warnings go stale after a host upgrade. Evener's `alerts` section in the report is computed at report time, which is the right place; do not store alerts.
15. **Bounded memory index with a usage gauge** (`memory.md` ≤ 8 KiB soft / 16 KiB hard, "X KiB / 16 KiB" printed on every injection). Evener's SKILL.md is ~155 lines; a size budget asserted in `scripts/selftest.sh` (fail above N bytes) is the cheapest guard against D18 regressing.
16. **Context lifecycle owned by the host, not the model**: compaction and session rollover have fixed triggers (idle > 60 min and context > 128k) and the model gets no tools to influence them. The analogue for Evener: `limits.*` are enforced by core, never suggested to the model. We already do this; keep it when adding `evener run`.

## Not worth copying

- Any of the three UIs: Claude Code has no plugin UI surface in v1; the report is our panel.
- Member mailboxes, threads, attention, reminders, subscriptions (Contexera), leader/member chat bus (limuyang2): intra-team coordination, out of scope.
- models.dev as the *only* price source: Evener targets may run through codex/dsh with subscription routes where list price is not what the user pays; keep the local override.

## Suggested follow-ups (not started; numbering continues the first note)

| # | Item | Size |
|---|---|---|
| F12 | Peak/off-peak pricing: `peak_hours` in pricing.yaml, classify by `dispatch.finished.ts`; decide list-price convention; closes D21 | M |
| F13 | `evener pricing refresh` from models.dev with dated snapshot and "unpriced" state; closes D3's placeholder caveat for DeepSeek/OpenAI | M |
| F14 | Keep `reasoning_tokens` split in usage; add `model_ms`/`tool_ms` per round; `reviewer_tokens` on accept | S |
| F15 | `self_accepted` flag for host rounds; report shows host rounds separately | S |
| F16 | `evener report --session` (per host session total incl. delegated spend); surface `price_table_version` changes as report markers | M |
| F17 | SKILL.md byte budget in selftest; per-rule `sandbox` override for codex | S |
