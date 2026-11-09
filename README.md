# Evener

**Route each delegated coding task to the harness that does it cheapest, then prove it with data.**

Evener is an open-source plugin for AI coding harnesses. When your host harness (Claude Code first) decides to delegate a sub-task, Evener picks which agent/harness should run it — Codex CLI, DeepSeek Harness, or the host itself — based on a user-editable policy. It records cost, time, acceptance outcomes and user feedback for every task, and compares routing policies against each other so you can see which one actually gives the best quality per dollar.

The name: an *evener* (whiffletree) is the bar in a multi-horse harness that distributes the pull so every horse carries its fair share. 中文「匀杆」。

## Why

Frontier closed models are expensive. Cheaper models are good enough for a large share of everyday coding work. Instead of letting a middleman proxy "mix in" cheaper models opaquely, Evener lets you do it yourself, transparently, with your own API keys, and measures whether it paid off.

## What Evener does

- **Routes** a task to a target harness using a structured policy (YAML) executed by a cheap classifier model (e.g. [Jev](https://jevmodel.net), or any OpenAI-compatible model). The policy *is* the classifier; the model is a pluggable executor.
- **Escalates**: on rejection, re-dispatch to the same target with more context, or move up a cost chain (dsh → codex → host). Round and budget caps per task.
- **Observes**: tokens, cost, wall time, acceptance verdicts and rejection reasons, user 👍/👎, manual overrides, later git reverts. Stored locally in SQLite.
- **Compares**: interleaved A/B of two policies (later a bandit), stratified by a fixed task taxonomy, with "minimum detectable difference" reported honestly.
- **Recommends**: a weekly local report with at most three concrete policy edits you can apply with one command.

## What Evener does not do

- No task decomposition, no context assembly, no acceptance review — those belong to the host harness.
- No token proxy. You bring your own API keys; nothing leaves your machine except your own calls to your own providers.
- No subscription-quota rotation. Evener is about API spend.
- No GUI in v1. Config file + CLI.

## Status

v1 is implemented and locally verified (2026-11-09): both target adapters were exercised against the
real `codex` and `dsh` CLIs, and the full flow (create → decide → dispatch → accept → next → close →
report) runs end to end. Model prices and a few defaults still need the maintainer's confirmation; see
[`design/decisions-for-user.md`](design/decisions-for-user.md).

- [`design/spec-v1.md`](design/spec-v1.md) — the frozen implementation contract (schemas, CLI, algorithms)
- [`design/prd-draft.md`](design/prd-draft.md) — motivation and history
- [`design/tasks/`](design/tasks/) — the briefs the implementation was delegated from

## Install

Requirements: Node ≥ 22.13 (for `node:sqlite`), plus the targets you want to route to
(`codex` on PATH with `OPENAI_API_KEY`, and/or `DEEPSEEK_API_KEY` for `npx @deepseek-ai/dsh`).

```sh
git clone https://github.com/twisker/evener && cd evener
npm install && npm run build && npm test
node core/dist/src/cli.js init          # creates ~/.evener/{policy.yaml,pricing.yaml,evener.sqlite}
```

Claude Code plugin (local checkout):

```sh
claude --plugin-dir ./adapters/claude-code          # session-only
# or, as a marketplace:
claude plugin marketplace add ./                     # repo root holds .claude-plugin/marketplace.json
claude plugin install evener@evener
```

The plugin puts `evener` on the Bash PATH of the session, adds the `/evener:evener` skill, the
`/evener:evener-report` and `/evener:evener-feedback` commands, a SessionStart hook that tells Claude
the session id, and Stop / SubagentStop hooks that close orphaned tasks as `abandoned`.

## How a task flows

```
evener task create --description-file F --files a.ts,b.ts --host-session S --cwd .
evener decide   --task T                 # rules → classifier → fallback table
evener dispatch --task T --prompt-file P --cwd .     # codex / dsh; host rounds use `evener done`
evener accept   --task T --verdict accepted|rejected [--reason <enum>] --check tests=pass
evener next     --task T                 # close | redispatch (retry / escalate) | hand_to_human
evener close    --task T --outcome accepted
evener report   --since 14d --format md  # CPAT, quality, 性价比, strata, MDD, ≤3 suggestions
evener apply 1                           # apply suggestion 1 to policy.yaml
```

Every command prints one JSON object (the report can print Markdown). Acceptance (tests, lint, diff
review, scope check) is done by the host; Evener only records the verdict and decides what happens next.

## Configuration

Everything lives in `$EVENER_HOME` (default `~/.evener`):

| File | Purpose |
|---|---|
| `policy.yaml` | targets and their commands, hard rules, fallback table, soft preferences, escalation chain, limits, privacy, experiment arms |
| `pricing.yaml` | USD per million tokens per model id; `price_table_version` is its hash |
| `evener.sqlite` | append-only `events` plus a rebuildable `tasks` projection (WAL) |
| `runs/<task>/<round>.out.md` | the target's final message; `.stderr` next to it |
| `reports/<ts>.json` | saved reports, the source for `evener apply` |

Run `evener ui` to open the local read-only web panel (live tasks, per-round replay, policy
comparison, per-session cost split); it binds 127.0.0.1 only and needs no extra dependency.

Set `classifier.model` (any OpenAI-compatible endpoint; key via `api_key_env`) to let a cheap model
apply the policy; leave it `null` to route with rules and the fallback table only. Set
`experiment.mode: interleave` and two arm files to A/B-compare policies.

The analysis labeler (label, time bucket, has-repro, used only to stratify reports) calls
`deepseek-flash` with `DEEPSEEK_API_KEY` by default, costing about $0.0001 per task; if the key
is missing or the call fails it falls back to keyword heuristics and `task create` prints a
warning. Set `labeler.model: null` for heuristics only. Prices in `pricing.yaml` are list prices; DeepSeek's peak windows are
modelled by `peak_schedules` (see `design/decisions-for-user.md` D21).

## Repository layout

```
design/                 PRD, frozen spec, deferred decisions, task briefs
core/                   npm package `evener`: CLI + library (TypeScript, Node built-ins + `yaml`)
adapters/claude-code/   Claude Code plugin: manifest, skill, hooks, commands, launcher
.claude-plugin/         marketplace.json for `claude plugin marketplace add`
```

Weekly report via cron:

```
0 9 * * 1  cd ~ && evener report --since 7d --format md --out ~/.evener/reports/weekly-$(date +\%F).md
```

## License

MIT
