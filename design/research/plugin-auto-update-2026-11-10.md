# Auto-update mechanisms of harness plugins, and what Evener should do (read 2026-11-10)

Question from the user: does the Evener plugin auto-update, and what is the best mechanism?
Answer today: **no**. Neither the adapter nor the core has any update logic; the only path is
Claude Code's marketplace update, which is **off by default** for third-party marketplaces.

## 1. Survey

| System | Install | Auto-update default | Manual update | Pinning | Opt-out | Source |
|---|---|---|---|---|---|---|
| Claude Code plugins | `claude plugin marketplace add`, `claude plugin install name@mkt`; copied to `~/.claude/plugins/cache/<mkt>/<plugin>/<version>/` | **Off** for every non-Anthropic marketplace. When on: after first message, random delay ≤ 10 min, update on disk, "Run /reload-plugins to apply" | `claude plugin update name@mkt`; `/plugin` → Update now | `version` in `plugin.json` > marketplace entry `version` > commit SHA; `ref`/`sha` in entry; `#ref` on add | per-marketplace `autoUpdate`; `DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | code.claude.com/docs/en/plugins/loading.md, install.md, host-marketplace.md |
| Claude Code npm deps of a plugin | automatic when plugin root has `package.json` + `package-lock.json`/`npm-shrinkwrap.json` | runs at install, at every version update, at session start if uncached | n/a | lockfile exact versions, registry packages only, `--ignore-scripts`, 60 s timeout | cannot be disabled; **not run for in-place local-path plugins** | loading.md "Node.js package dependencies" |
| Codex CLI plugins | `codex plugin add name@mkt`, `codex plugin marketplace add` | **On**: every startup re-syncs curated marketplace and configured git marketplaces; reinstalls when manifest `version` differs | `codex plugin marketplace upgrade [name]` | `--ref`, entry `ref`/`sha`, npm `version` | none documented beyond disabling plugins | developers.openai.com/codex/plugins; codex-rs/core-plugins |
| Codex CLI self | npm / brew / installer | checks GitHub releases on start when `version.json` older than 20 h; banner next run; popup with "Don't remind" | `codex update` | — | `check_for_update_on_startup = false` | codex-rs/tui/src/updates.rs |
| dsh plugins | `dsh plugin --profile <p> add <pkg>` (verbatim pnpm) | **Off**; dsh itself has no update check | `dsh plugin --profile <p> update <pkg>` then restart; Web UI "Refresh" → "Update available" → confirm | `add --save-exact pkg@x.y.z`; `engines.dsh` compatibility + exemptions | — | deepseek-harness apps/cli/reference/README.md, packages/boot/plugin-manager/README.md |
| dsh-context (community) | npm package | **Notify only**: host fetches `registry.npmjs.org/dsh-context/latest`, 1 h TTL, 8 s timeout; panel shows "↑ v<latest>" pill linking to releases | `dsh plugin … update dsh-context@latest` | exact version | — | github.com/bowenliang123/dsh-context src/host/catalog.ts, versionRoute.ts |
| dsh-agent-teams (community) | npm or `github:` | none at runtime | re-run `add --save-exact …@x.y.z`, restart | exact version; `compatibility.json` host matrix; per-version release notes | — | github.com/NanmiCoder/dsh-agent-teams README |
| Gemini CLI extensions | `gemini extensions install <url> [--ref] [--auto-update]` | checks **every launch**, unthrottled; applies only with `--auto-update`, else prints "N extension(s) with an update available" | `gemini extensions update <name>|--all` | `--ref` | omit `--auto-update` | gemini-cli docs/extensions/reference.md; useExtensionUpdates.ts |
| OpenCode plugins | `plugins: ["pkg", "pkg@1.2.0"]` in config | startup installs missing, **checks** unpinned for updates without changing them | `opencode plugin check|update` | exact version or full git SHA | pin | opencode.ai/docs/plugins |
| VS Code / Cursor | marketplace | **On** (`extensions.autoUpdate: "on"`, 12 h delay) | Update button | "Install Another Version" | `extensions.autoUpdate: off`, `autoCheckUpdates: false` | code.visualstudio.com docs |
| update-notifier (Node lib) | — | checks registry in an unref'd child every 24 h, shows result on the **next** run, TTY only, skipped in CI | prints install hint | — | `NO_UPDATE_NOTIFIER`, `--no-update-notifier` | github.com/yeoman/update-notifier |
| npx | `npx -y pkg@latest` | re-resolves the tag against the registry on every run (`preferOnline`) | — | `pkg@1.2.3` | `--prefer-offline` | npm/cli libnpmexec |
| Homebrew / oh-my-zsh | — | `brew update` before install if > 24 h; omz prompt every 13 days | `brew upgrade`, `omz update` | `brew pin` | `HOMEBREW_NO_AUTO_UPDATE`, omz `mode disabled` | docs.brew.sh; ohmyzsh wiki |

## 2. Patterns that recur

1. **Check at session start, throttled** (24 h is the common interval; Gemini's every-launch check is the outlier).
2. **Notify, don't apply** by default; applying is opt-in. VS Code is the exception.
3. **Check off the hot path**: detached child or background task, cache the result, show it next time.
4. **Respect the environment**: CI / non-TTY → silent; `NO_UPDATE_NOTIFIER`, `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` → no network.
5. **Exact specifier = pin, tag/branch = tracked**; applied updates still need a restart/reload.
6. Hosts that auto-update their own plugins key the update on a **version string**, not on commits (Claude Code with `version` set, Codex always).

## 3. Evener's situation

Two moving parts with different update paths today:

- **Adapter** (`adapters/claude-code`): updated only by Claude Code, only when `plugin.json` `version` changes, and only if the user enabled auto-update for the `evener` marketplace or runs `claude plugin update evener@evener`.
- **Core CLI** (`core`, npm `evener`): the launcher `bin/evener` resolves monorepo build → global `evener` → `npx -y evener`. The npx path re-resolves `latest` on every call (slow, and may drift from the adapter), the global path never updates, the monorepo path updates with `git pull`.

So "the plugin updated but the CLI did not" (or the reverse) is possible, and the skill text + CLI JSON contract would skew. The event store has `schema_version` + `migrate()`, so a newer core can open an older DB; the reverse is not guaranteed.

## 4. Recommendation

**R1. One version, one artifact: ship the core as a lockfile-pinned npm dependency of the plugin.**
`adapters/claude-code/package.json` gets `"dependencies": {"evener": "x.y.z"}` plus a committed `package-lock.json` (npm ≥ 7, lockfileVersion 3). Claude Code installs it into the cached plugin at install and at every update, with no scripts and no network beyond the registry. `bin/evener` resolves `<plugin root>/node_modules/evener/dist/src/cli.js` *before* the global/npx fallbacks. Requirements: core published on npm (D16), `yaml` is the only dependency (registry, no native code, well within 60 s). Caveat: in-place local-path marketplaces get no dependency install; the monorepo path (`../../core/dist`) already covers that case.

**R2. Release = bump one version string, in one script.** `scripts/release.sh <version>` sets `core/package.json`, `adapters/claude-code/package.json` (`version` and the `evener` dependency), `plugin.json` `version`, regenerates the lockfile, tags `v<version>`, and CI publishes core to npm. Keep `version` set in `plugin.json` (do **not** rely on commit SHA): users then get released states only, and can pin.

**R3. Notify, never apply, inside Evener.** A throttled version check, following update-notifier/Codex:
- Run from the existing `SessionStart` hook (already spawns `node`) as a detached, unref'd child: `evener update-check` compares the running version with `https://registry.npmjs.org/evener/latest` (8 s timeout), writes `$EVENER_HOME/update-check.json` `{checked_at, latest, current}`.
- Interval 24 h; the hook reads the cached file and, only when `latest > current`, adds one line of `additionalContext`: "Evener x.y.z is available (installed a.b.c). Run `claude plugin update evener@evener` or enable auto-update for the evener marketplace." The same fact becomes a small pill in `evener ui`'s top bar (dsh-context pattern) and a line in `evener status`.
- Silent when any of `EVENER_NO_UPDATE_CHECK`, `NO_UPDATE_NOTIFIER`, `CI`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, or when stdout is not a TTY for direct CLI use.
- Config, since the user's rule is "uncertain things become config": `policy.update_check: {enabled: true, interval_hours: 24, registry: https://registry.npmjs.org}`.

**R4. Document the Claude Code side.** README Install section: auto-update is off by default for third-party marketplaces; how to turn it on (`/plugin` → Marketplaces → evener → Enable auto-update) and the manual command. Recommend enabling it once R1 makes updates atomic.

**R5. Compatibility with the *targets*.** Codex updates itself (20 h check) and its plugins on every start; dsh floats on `npx @deepseek-ai/dsh` (D10). Their JSON shapes are what Evener parses. This is the stronger argument for F11 (`compatibility.json` + `evener doctor`): record the codex/dsh versions each dispatch saw (`target_version` already exists), and let `doctor` warn when the installed target is newer than the tested matrix.

**Not recommended**: Evener applying updates itself (running `claude plugin update` or `npm i -g` from a hook). Every surveyed system that applies updates is the host, not the plugin; a plugin that rewrites its own cache directory mid-session races with Claude Code's loader and the 14-day orphan sweep.

Rough sizes: R1 + R2 S (half a day, mostly release plumbing and a launcher test); R3 M (one command, hook change, ui pill, tests with an injected fetch); R4 XS; R5 is F11.
