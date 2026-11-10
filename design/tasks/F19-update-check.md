# F19 — `evener update-check`: notify-only version check, config, hook, overview field

Read first: `design/spec-v1.md` §5 `update_check` block, §10 "Updates" bullet, §11 `update-check` row, §13 `/api/overview` `update` field. Then `core/src/version.ts` (`packageVersion`, from F18), `core/src/cli.ts`, `core/src/commands/{task,types}.ts` (command registration style, `injectedFetch(ctx)`), `core/src/config.ts` (policy validation, `host` block as the model), `core/src/types.ts` (`Policy`), `core/templates/policy.default.yaml`, `core/src/ui/{server,views}.ts` (`overview`), `adapters/claude-code/scripts/session-start.sh`, `adapters/claude-code/hooks/hooks.json`, and their tests.

Files you may create/modify: `core/src/update-check.ts` (new), `core/src/commands/update-check.ts` (new), `core/src/cli.ts` (registration + usage line), `core/src/config.ts`, `core/src/types.ts`, `core/templates/policy.default.yaml`, `core/src/ui/views.ts`, `core/src/ui/server.ts`, `core/test/**`, `adapters/claude-code/scripts/session-start.sh`, `adapters/claude-code/scripts/selftest.sh`, `core/README.md`, `README.md` (one paragraph). Do not touch `core/ui/index.html` (another task).

## 1. Config

`policy.update_check: {enabled: bool = true, interval_hours: number > 0 = 24, registry: string = "https://registry.npmjs.org"}`; validated like the other blocks with JSON-pointer errors; absent block → defaults (older policies keep validating). `registry` must parse as an `http(s)` URL. Add to `Policy`, template (with the D23 comment), and the policy hash (it is part of the effective policy like everything else).

## 2. Library (`core/src/update-check.ts`)

- `compareVersions(a, b): -1|0|1` for `X.Y.Z[-pre]`: numeric on the three parts; a prerelease is lower than the same release; prereleases compare by dot-separated identifiers (numeric < alpha, numeric ascending, else lexical). Unparsable → treat as `0.0.0` and never report an update for it.
- `readUpdateCache(home): UpdateCache|null` for `$EVENER_HOME/update-check.json` `{checked_at, current, latest, error}`; malformed file → null.
- `updateView(cache, current): {current, latest, available, checked_at}` (the `/api/overview` shape); `available` only when `latest` parses and `compareVersions(latest, current) > 0`.
- `checkForUpdate({home, policy, current, now, fetch, force, offline}): UpdateCheckResult` (the §11 output shape):
  - `skipped: "disabled"` when `policy.update_check.enabled === false`; `"env"` when any of `EVENER_NO_UPDATE_CHECK`, `NO_UPDATE_NOTIFIER`, `CI`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set to a non-empty value (read `process.env` once at the call site and pass an `env` object in, so tests inject it); `"offline"` when `offline` (cache only); `"fresh"` when the cache is younger than `interval_hours` and not `force`. No network and no file write in any skipped case except that `offline`/`fresh` still return the cached `latest`.
  - Otherwise `GET <registry>/evener/latest` with `Accept: application/json`, 8 s timeout via `AbortSignal.timeout`, no proxy handling (fetch honours the environment); parse `{version}`; write the cache atomically (temp file + rename) with `checked_at = now`; on any failure write the cache with `error: "<code>: <message>"`, keep the previous `latest` if there was one, exit 0 — never throw out of the command.

## 3. Command

`evener update-check [--offline] [--force]` prints the result as JSON (spec §11). `--quiet` suppresses nothing here (the output is the point). Register in `cli.ts` with a usage line.

## 4. Hook

`session-start.sh` keeps its current output and adds, when `"${CLAUDE_PLUGIN_ROOT}"/bin/evener update-check --offline` returns `available: true` within 2 s (`timeout` is not portable; run it under `node` with a watchdog or just rely on `--offline` being instant), one more sentence in `additionalContext`: `Evener <latest> is available (installed <current>). Update with \`claude plugin update evener@evener\`, or enable auto-update for the evener marketplace.` Then, unless the same env vars are set, spawn `"${CLAUDE_PLUGIN_ROOT}"/bin/evener update-check` detached in the background (`nohup … >/dev/null 2>&1 &`) so the next session sees a fresh cache. The hook must still exit 0 and print valid JSON (or nothing) in every case, including when `evener` is missing. Add a selftest case with `EVENER_HOME` pointing at a temp dir holding a cache file with a newer `latest` and `EVENER_BIN` pointing at the monorepo CLI: the hook output must contain "is available"; with `CI=1` set, the background spawn must not happen (assert no new cache file appears after 1 s).

## 5. Overview

`/api/overview` gains `update` (spec §13) computed by `updateView(readUpdateCache(home), packageVersion())` in the server; `views.overview` takes it as a parameter so the pure function stays testable. Server test: seed a cache file with a newer version → `available: true`; no file → `latest: null, available: false`.

## 6. Tests

`compareVersions` table (incl. `0.1.0-rc.1 < 0.1.0`, `0.1.0 < 0.1.0-rc.1` false, `0.10.0 > 0.9.9`, garbage → equal to `0.0.0`); `checkForUpdate` with an injected fetch: network success writes cache; 500 / timeout / invalid JSON record `error` and keep the old `latest`; `fresh` skip does not call fetch; `env` skip with `CI=1`; `disabled`; `offline`. Config validation: bad `interval_hours`, bad `registry`, absent block → defaults. `npm test` green from the repo root; report the count. `core/README.md`: a "Update check" section (what is sent: one GET to the registry, nothing else; how to turn it off).
