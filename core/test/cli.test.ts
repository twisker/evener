import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runCli } from "../src/cli.js";
import type { CliIO } from "../src/cli.js";
import { defaultPolicy, policyVersion, loadPolicy } from "../src/config.js";

interface Harness {
  io: CliIO;
  stdout(): string;
  stderr(): string;
}

function harness(env: Readonly<Record<string, string | undefined>> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
    env,
    cwd: process.cwd(),
  };
  return {
    io,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "evener-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface InitOutput {
  home: string;
  policy_path: string;
  pricing_path: string;
  db_path: string;
  created: boolean;
}

test("init creates the home, configs and run directories, then is idempotent", async (t) => {
  const home = tempDir(t);

  const first = harness();
  assert.equal(await runCli(["init", "--home", home], first.io), 0);
  const firstPayload = JSON.parse(first.stdout()) as InitOutput;

  assert.equal(firstPayload.home, home);
  assert.equal(firstPayload.policy_path, join(home, "policy.yaml"));
  assert.equal(firstPayload.pricing_path, join(home, "pricing.yaml"));
  assert.equal(firstPayload.db_path, join(home, "evener.sqlite"));
  assert.equal(firstPayload.created, true);
  assert.equal(existsSync(join(home, "policy.yaml")), true);
  assert.equal(existsSync(join(home, "pricing.yaml")), true);
  assert.equal(statSync(join(home, "runs")).isDirectory(), true);
  assert.equal(statSync(join(home, "reports")).isDirectory(), true);
  assert.equal(existsSync(join(home, "evener.sqlite")), true);

  const second = harness();
  assert.equal(await runCli(["init", "--home", home], second.io), 0);
  const secondPayload = JSON.parse(second.stdout()) as InitOutput;
  assert.equal(secondPayload.created, false);
});

test("policy validate succeeds against an initialised home", async (t) => {
  const home = tempDir(t);

  assert.equal(await runCli(["init", "--home", home], harness().io), 0);

  const result = harness();
  assert.equal(await runCli(["policy", "validate", "--home", home], result.io), 0);
  const payload = JSON.parse(result.stdout()) as {
    ok: boolean;
    errors: unknown[];
    warnings: unknown[];
  };
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.errors, []);
  assert.deepEqual(payload.warnings, []);
});

test("policy validate exits 2 and reports the bad path", async (t) => {
  const home = tempDir(t);
  assert.equal(await runCli(["init", "--home", home], harness().io), 0);

  const bad = structuredClone(defaultPolicy());
  const firstRule = bad.rules[0];
  assert.ok(firstRule !== undefined);
  firstRule.then = "does-not-exist";
  writeFileSync(join(home, "policy.yaml"), JSON.stringify(bad), "utf8");

  const result = harness();
  assert.equal(await runCli(["policy", "validate", "--home", home], result.io), 2);
  const payload = JSON.parse(result.stdout()) as {
    ok: boolean;
    errors: { path: string; message: string }[];
  };
  assert.equal(payload.ok, false);
  assert.ok(payload.errors.some((issue) => issue.path === "/rules/0/then"));
});

test("policy hash prints the canonical version", async (t) => {
  const home = tempDir(t);
  assert.equal(await runCli(["init", "--home", home], harness().io), 0);

  const result = harness();
  assert.equal(await runCli(["policy", "hash", "--home", home], result.io), 0);
  const payload = JSON.parse(result.stdout()) as { policy_version: string };
  assert.equal(payload.policy_version, policyVersion(loadPolicy(join(home, "policy.yaml"))));
});

test("unknown command returns exit 1 and error JSON", async () => {
  const result = harness();
  assert.equal(await runCli(["bogus"], result.io), 1);
  const payload = JSON.parse(result.stdout()) as { error: { code: string; message: string } };
  assert.equal(payload.error.code, "unknown_command");
  assert.ok(payload.error.message.length > 0);
});

test("help lists registered commands with usage for help, --help and -h", async () => {
  for (const argv of [["help"], ["--help"], ["-h"]]) {
    const result = harness();
    assert.equal(await runCli(argv, result.io), 0);

    const payload = JSON.parse(result.stdout()) as {
      commands: { name: string; usage: string }[];
    };
    const names = payload.commands.map((command) => command.name);
    for (const name of ["decide", "dispatch", "done", "report"]) {
      assert.ok(names.includes(name), `help is missing ${name}`);
    }
    assert.ok(payload.commands.every((command) => command.usage.length > 0));
  }
});
