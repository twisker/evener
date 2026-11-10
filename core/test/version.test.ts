import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runCli } from "../src/cli.js";
import type { CliIO } from "../src/cli.js";
import { packageVersion } from "../src/version.js";

interface Harness {
  io: CliIO;
  stdout(): string;
}

function harness(): Harness {
  const out: string[] = [];
  const io: CliIO = {
    stdout: (text) => {
      out.push(text);
    },
    stderr: () => {},
    env: {},
    cwd: process.cwd(),
  };
  return { io, stdout: () => out.join("") };
}

function corePackageVersion(): string {
  const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error("core/package.json has no version field");
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("core/package.json version is not a non-empty string");
  }
  return version;
}

test("packageVersion reads core/package.json", () => {
  const version = packageVersion();
  assert.equal(version, corePackageVersion());
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});

test("packageVersion is stable across calls", () => {
  assert.equal(packageVersion(), packageVersion());
});

test("--version prints the bare version and exits 0", async () => {
  const result = harness();
  assert.equal(await runCli(["--version"], result.io), 0);
  assert.equal(result.stdout(), `${corePackageVersion()}\n`);
});

test("version prints a JSON object for scripts", async () => {
  const result = harness();
  assert.equal(await runCli(["version"], result.io), 0);
  const payload = JSON.parse(result.stdout()) as { version: string };
  assert.deepEqual(payload, { version: corePackageVersion() });
});

test("help advertises the version command", async () => {
  const result = harness();
  assert.equal(await runCli(["help"], result.io), 0);
  const payload = JSON.parse(result.stdout()) as {
    commands: { name: string; usage: string }[];
  };
  const version = payload.commands.find((command) => command.name === "version");
  assert.ok(version !== undefined);
  assert.equal(version.usage, "version");
});
