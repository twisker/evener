#!/bin/sh
# Release Evener: bump all version locations, test, publish the core to npm,
# regenerate the plugin lockfile, commit and tag. Never pushes.
#
# Usage: scripts/release.sh <new-version> [--dry-run]
set -eu

usage() {
  printf 'usage: %s <new-version> [--dry-run]\n' "$0" >&2
  exit 2
}

dry_run=0
version=
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      dry_run=1
      ;;
    -h | --help)
      usage
      ;;
    -*)
      printf 'release: unknown option: %s\n' "$arg" >&2
      usage
      ;;
    *)
      if [ -n "$version" ]; then
        printf 'release: too many arguments\n' >&2
        usage
      fi
      version=$arg
      ;;
  esac
done

[ -n "$version" ] || usage

if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  printf 'release: invalid version %s; expected X.Y.Z[-pre]\n' "$version" >&2
  exit 1
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
if [ "$branch" != "main" ]; then
  printf 'release: must run on main (currently %s)\n' "${branch:-unknown}" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  printf 'release: working tree is dirty; commit or stash your changes first\n' >&2
  git status --short >&2
  exit 1
fi

write_version() {
  file=$1
  key_path=$2
  node -e '
const fs = require("node:fs");
const [file, nextVersion, keyPath] = process.argv.slice(1);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const keys = keyPath.split(".");
let target = data;
for (const key of keys.slice(0, -1)) {
  const child = target[key];
  if (typeof child !== "object" || child === null || Array.isArray(child)) {
    throw new Error(`${keyPath}: missing object at ${key}`);
  }
  target = child;
}
const leaf = keys[keys.length - 1];
if (typeof target[leaf] !== "string") {
  throw new Error(`${keyPath}: missing string at ${leaf}`);
}
target[leaf] = nextVersion;
fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
' "$file" "$version" "$key_path"
  printf 'release: %s %s = %s\n' "$file" "$key_path" "$version"
}

printf 'release: writing version %s\n' "$version"
write_version "$repo_root/core/package.json" "version"
write_version "$repo_root/adapters/claude-code/package.json" "version"
write_version "$repo_root/adapters/claude-code/package.json" "dependencies.evener"
write_version "$repo_root/adapters/claude-code/.claude-plugin/plugin.json" "version"

printf 'release: building and testing\n'
npm run build && npm test

printf 'release: checking npm login\n'
if ! npm_user=$(npm whoami 2>&1); then
  printf '%s\n' "$npm_user" >&2
  printf 'release: not logged in to npm; run `npm login` first\n' >&2
  exit 1
fi
printf 'npm whoami: %s\n' "$npm_user"

if [ "$dry_run" -eq 1 ]; then
  printf 'release: running (cd core && npm publish --dry-run)\n'
  (cd core && npm publish --dry-run)
else
  printf 'release: running (cd core && npm publish)\n'
  (cd core && npm publish)
fi

if [ "$dry_run" -eq 1 ]; then
  printf 'release: skipping package-lock.json regeneration; evener@%s is not on the registry in a dry run\n' "$version"
  printf 'release: dry run: skipping commit and tag; version files remain modified in the working tree\n'
  exit 0
fi

printf 'release: regenerating adapters/claude-code/package-lock.json\n'
(cd adapters/claude-code && npm install --package-lock-only --ignore-scripts --no-audit --no-fund)

git add -A
git commit -m "Release v$version"
git tag "v$version"
printf 'release: tagged v%s; nothing was pushed. To publish the tag, run:\n' "$version"
printf '  git push --follow-tags\n'
