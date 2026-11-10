#!/bin/sh
# Check that the three published version locations and the plugin's pinned core
# dependency all agree. Run from `npm test` and before a release.
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

node -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.cwd();

function readJson(relativePath) {
  const file = path.join(root, relativePath);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`cannot parse ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing ${label}`);
  }
  return value;
}

try {
  const core = readJson("core/package.json");
  const adapter = readJson("adapters/claude-code/package.json");
  const plugin = readJson("adapters/claude-code/.claude-plugin/plugin.json");

  const rows = [
    ["core/package.json", requireString(core.version, "core/package.json version")],
    ["adapters/claude-code/package.json", requireString(adapter.version, "adapter version")],
    [
      "adapters/claude-code/package.json dependencies.evener",
      requireString(
        adapter.dependencies && adapter.dependencies.evener,
        "adapters/claude-code/package.json dependencies.evener",
      ),
    ],
    ["adapters/claude-code/.claude-plugin/plugin.json", requireString(plugin.version, "plugin.json version")],
  ];

  for (const [label, value] of rows) {
    console.log(`${label}: ${value}`);
  }

  const expected = rows[0][1];
  const mismatched = rows.filter(([, value]) => value !== expected);
  if (mismatched.length > 0) {
    console.error(`error: version mismatch: expected ${expected} everywhere; run scripts/release.sh <version>`);
    process.exit(1);
  }

  const lockRelativePath = "adapters/claude-code/package-lock.json";
  const lockPath = path.join(root, lockRelativePath);
  if (!fs.existsSync(lockPath)) {
    console.error(
      `warning: ${lockRelativePath} is missing; it is generated after the first npm publish (scripts/release.sh)`,
    );
  } else {
    const lock = readJson(lockRelativePath);
    if (lock.lockfileVersion !== 3) {
      console.error(`error: ${lockRelativePath} must have lockfileVersion 3`);
      process.exit(1);
    }
  }
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
'