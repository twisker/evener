# Decisions deferred to the user (2026-11-09)

Everything here is implemented with a default and exposed as configuration, so the product works
without an answer. Review after v1 is complete.

| # | Item | Default chosen | Where to change | Why it is yours |
|---|---|---|---|---|
| D1 | Implementation language TypeScript (Node ≥ 22.13) | TypeScript | n/a (code) | Irreversible once the code base grows; chosen because dsh already requires Node and `node:sqlite` removes native deps. |
| D2 | Rename `router` → `classifier` | Renamed | n/a (schema) | Pure naming; PRD still says `router`. |
| D3 | Model prices in `pricing.yaml` | Placeholders: gpt-5.1-codex 1.25/0.125/10.0, deepseek-v3.2 0.28/0.028/0.42 USD per Mtok | `$EVENER_HOME/pricing.yaml` | Prices change; I could not verify current list prices offline. Cost figures are wrong until confirmed. |
| D4 | Default Codex model id for pricing | `gpt-5.1-codex` | `policy.targets.codex.model` | Codex JSONL does not report the model; must match your `~/.codex/config.toml`. |
| D5 | Default dsh model id for pricing | `deepseek-v3.2` | `policy.targets.dsh.model` | dsh JSON does not report the model name. |
| D6 | Classifier model | `null` (rules + fallback table only, no model call) | `policy.classifier.model/endpoint/api_key_env` | Needs an API key you pick (Jev, DeepSeek, …). |
| D7 | Analysis labeler | heuristic keyword labeler | `policy.labeler.model` | Same. Heuristic is crude; stratified reports are only as good as labels. |
| D8 | Experiment defaults α = 0.10, power = 0.80, "25 % detectable in 4 weeks" | as PRD | `policy.experiment.alpha/power` | PRD marks them "to be calibrated". |
| D9 | Codex sandbox flags in the dispatch command | `--sandbox workspace-write`, no `--approve-for-me` | `policy.targets.codex.command` | Trade-off between autonomy and safety on your machine. |
| D10 | dsh invocation | `npx @deepseek-ai/dsh` (floating pre-release version) | `policy.targets.dsh.command` | Pinning a version avoids surprise breaking changes but needs manual bumps. |
| D11 | Confirm before dispatch in Claude Code | off | `policy.host.claude_code.confirm_before_dispatch` | UX preference. |
| D12 | Ask 👍/👎 after each task | off (user can run `evener feedback` or `/evener:feedback`) | skill text / config | Interrupts flow vs. data quality. |
| D13 | Hook safety net scope | Stop + SubagentStop sweep open tasks of the session to `abandoned` | `hooks/hooks.json` | Could instead leave tasks open for later resume. |
| D14 | Store description excerpt | off | `policy.privacy.store_description_excerpt` | Privacy vs. debuggability. |
| D15 | Weekly report scheduling | documented cron line, not automated | — | Evener does not schedule itself (non-goal). |
| D16 | Package name on npm | `evener` (unverified availability) | `core/package.json` | Might be taken. |
| D17 | Host round cost | `evener done` without `--cost-usd` records cost 0 with `cost_unknown: true` | skill text: pass an estimate, or leave unknown | Claude Code does not expose per-turn cost to the model; any number would be a guess. Reports therefore understate host CPAT. |
| D18 | Skill chattiness | 8 CLI calls per task (create, decide, dispatch, accept, next, close + reads) | `SKILL.md`; could add a combined `evener run` command | Measured: a trivial delegated task cost $0.76 of host tokens vs $0.0008 of dsh. A single `evener run --description-file --prompt-file` that does create+decide+dispatch would cut round trips but hides the decision from the host. Product call. |
| D19 | dsh session litter | Each dispatch leaves a persisted dsh session under `~/.dsh/sessions/` | none yet | Could pass a flag if dsh offers an ephemeral mode (codex has `--ephemeral`). |
| D20 | `has_repro` / `time_bucket` heuristics | keyword + size heuristics with a negation guard; model labeler optional | `policy.labeler.model`, `labeler.time_bucket_heuristic` | Heuristics are crude; benchmark-style difficulty buckets are only as good as the labeler. Turning on a cheap labeler model is the real fix. |
