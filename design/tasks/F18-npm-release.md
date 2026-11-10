# F18 — Publishable core, plugin pins the core as an npm dependency, one release script, `--version`

Read first: `design/spec-v1.md` §10 "Installation" and "Updates" bullets (D16/D23), §11 global flags. Then `core/package.json`, `core/src/cli.ts`, `adapters/claude-code/package.json`, `adapters/claude-code/.claude-plugin/plugin.json`, `adapters/claude-code/bin/evener`, `adapters/claude-code/scripts/selftest.sh`, `adapters/claude-code/README.md`, root `package.json` (workspaces), root `LICENSE`.

Files you may create/modify: `core/package.json`, `core/.npmignore` (if needed), `core/LICENSE` (copy of root), `core/src/version.ts` (new), `core/src/cli.ts` (only: `--version` global flag), `core/test/version.test.ts` (new), `adapters/claude-code/package.json`, `adapters/claude-code/bin/evener`, `adapters/claude-code/scripts/selftest.sh`, `adapters/claude-code/README.md`, `scripts/release.sh` (new, repo root), `scripts/check-versions.sh` (new), root `package.json` (only to add a `check-versions` script to `test` if you want it run by `npm test`), `README.md` (Install/Release sections). Nothing else.

## 1. Core is publishable

- `core/package.json`: `license: "MIT"`, `repository: {type: git, url: https://github.com/twisker/evener.git, directory: core}`, `homepage`, `keywords`, `files: ["dist/src", "templates", "ui", "README.md", "LICENSE"]` (tests must not ship: today `npm pack --dry-run` lists 48 `dist/test` files), `prepublishOnly: "npm run build"`. Copy root `LICENSE` to `core/LICENSE`.
- `npm pack --dry-run` in `core` must list no `dist/test/` file and must include `dist/src/cli.js`, `templates/*.yaml`, `ui/index.html`, `LICENSE`, `README.md`.
- `core/src/version.ts`: `export function packageVersion(): string` reads `../../package.json` relative to `import.meta.url` once (works from `dist/src/`), returns `version`; throws a clear error if unreadable. Test it against `core/package.json`.
- `cli.ts`: `evener --version` prints the bare version string (no JSON) and exits 0; also `evener version` → `{version}` JSON for scripts. Usage line.

## 2. Plugin pins the core

- `adapters/claude-code/package.json`: keep `private: true`; add `"dependencies": {"evener": "<current version>"}` (exact, no caret). A `package-lock.json` with `lockfileVersion` 3 must sit next to it; because `evener` is not on npm yet, **do not try to install from the registry**. Generate the lockfile with `npm install --package-lock-only --ignore-scripts` *after* the first publish is the release script's job (step 4 below). For now write the lockfile by hand is not acceptable either; instead: make the launcher and selftest work without it, and have `scripts/check-versions.sh` tolerate a missing lockfile until the first release (print a warning, not a failure).
- Claude Code installs lockfile dependencies into the cached plugin at install/update (registry packages only, `--ignore-scripts`); the only transitive dependency is `yaml`, which is fine.
- `bin/evener` resolution order becomes: `$EVENER_BIN` → monorepo `../../core/dist/src/cli.js` → `<plugin root>/node_modules/evener/dist/src/cli.js` via `node` → global `evener` (not this launcher) → `npx -y evener@<plugin version>` (read `version` from `<plugin root>/.claude-plugin/plugin.json` with `node -p`; fall back to `npx -y evener` if unreadable). Update the header comment.
- `selftest.sh`: add a check that creates a temp copy of the plugin dir with a fake `node_modules/evener/dist/src/cli.js` (a one-line node script printing `{"fake":true}`) and no monorepo core reachable (copy to `$TMPDIR`, so `../../core` does not exist), runs `bin/evener`, and asserts the fake answered. Keep existing checks.

## 3. Versions agree

`scripts/check-versions.sh`: exits 1 unless `core/package.json` `version`, `adapters/claude-code/package.json` `version`, its `dependencies.evener`, and `plugin.json` `version` are identical; prints them. Wire it into root `npm test` (before the workspaces run) so CI catches drift.

## 4. Release script

`scripts/release.sh <new-version> [--dry-run]` (POSIX sh, repo root, refuses to run on a dirty tree or off `main`):
1. Validate semver `X.Y.Z[-pre]`.
2. Write the version into the four places of step 3 (use `node -e` with `JSON.parse`/`JSON.stringify(…, null, 2)` + trailing newline; do not reformat other keys).
3. `npm run build && npm test`.
4. `cd core && npm publish` (`--dry-run` when requested; print the exact command and the `npm whoami` result first, and stop with a clear message if not logged in: "run `npm login` first").
5. `cd adapters/claude-code && npm install --package-lock-only --ignore-scripts --no-audit --no-fund` (skipped on `--dry-run` since the version is not on the registry; say so).
6. `git add -A && git commit -m "Release v<version>" && git tag v<version>`; print the `git push --follow-tags` command but **do not push**.
Document in `README.md` "Release" section (4 lines) and in `adapters/claude-code/README.md` Install section: how Claude Code updates the plugin (auto-update is off by default for third-party marketplaces; `/plugin` → Marketplaces → evener → Enable auto-update; manual `claude plugin update evener@evener`), and that the plugin brings its own pinned core.

## 5. Tests

`npm test` green from the repo root (core tests + adapter selftest + check-versions); report the count. Run `sh scripts/release.sh 0.1.0 --dry-run` on a clean tree is **not** possible (tree will be dirty with your changes) — instead unit-check the version-writing step by running the `node -e` snippet against temp copies and asserting the files round-trip with only `version` changed.
