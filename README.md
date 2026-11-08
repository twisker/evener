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

Design stage. See [`design/prd-draft.md`](design/prd-draft.md) for the current PRD and open questions.

Planned v1 scope:

| Role | Tool |
|---|---|
| Host | Claude Code |
| Targets | Codex CLI (`codex exec --json`), DeepSeek Harness (`npx @deepseek-ai/dsh`) |
| Classifier | Jev or any OpenAI-compatible model |
| Storage | SQLite, local only |

## Repository layout (planned)

```
design/     PRD, decisions, schemas
core/       host-independent routing engine, store, report  (CLI + library)
adapters/   thin per-host packages for marketplace packaging (claude-code/ first)
```

## License

MIT
