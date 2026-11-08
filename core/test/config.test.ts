import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  canonicalStringify,
  defaultPolicy,
  defaultPricing,
  loadEffectivePolicy,
  policyVersion,
  resolveHome,
  validatePolicy,
  validatePricing,
} from "../src/config.js";
import type { Policy } from "../src/types.js";

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "evener-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("bundled templates validate with zero errors and zero warnings", () => {
  const policyResult = validatePolicy(defaultPolicy());
  assert.equal(policyResult.ok, true);
  assert.deepEqual(policyResult.errors, []);
  assert.deepEqual(policyResult.warnings, []);
  if (policyResult.ok) {
    assert.equal(policyResult.policy.policy_name, "default");
    assert.equal(policyResult.policy.schema_version, 1);
  }

  const pricingResult = validatePricing(defaultPricing());
  assert.equal(pricingResult.ok, true);
  assert.deepEqual(pricingResult.errors, []);
  assert.deepEqual(pricingResult.warnings, []);
  if (pricingResult.ok) {
    assert.equal(pricingResult.pricing.schema_version, 1);
    assert.ok(pricingResult.pricing.models["gpt-5.1-codex"] !== undefined);
  }
});

test("policyVersion ignores key order and changes with policy content", () => {
  const policy = defaultPolicy();
  const roundTripped = JSON.parse(JSON.stringify(policy)) as Record<string, unknown>;
  const reversed: Record<string, unknown> = {};
  for (const key of Object.keys(roundTripped).reverse()) {
    reversed[key] = roundTripped[key];
  }

  assert.equal(policyVersion(policy), policyVersion(reversed as unknown as Policy));
  assert.equal(canonicalStringify(policy), canonicalStringify(reversed));

  const changed: Policy = {
    ...policy,
    limits: { ...policy.limits, max_rounds_per_task: policy.limits.max_rounds_per_task + 1 },
  };
  assert.notEqual(policyVersion(policy), policyVersion(changed));
});

test("validation reports a bad rule then target at /rules/0/then", () => {
  const policy = structuredClone(defaultPolicy());
  const first = policy.rules[0];
  assert.ok(first !== undefined);
  first.then = "does-not-exist";

  const result = validatePolicy(policy);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((issue) => issue.path === "/rules/0/then"),
    `expected /rules/0/then, got ${JSON.stringify(result.errors)}`,
  );
});

test("unknown top-level keys are errors and unknown nested keys are warnings", () => {
  const policy = defaultPolicy();
  const input = {
    ...policy,
    mystery: true,
    classifier: { ...policy.classifier, mystery: 1 },
  };

  const result = validatePolicy(input);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((issue) => issue.path === "/mystery"));
  assert.ok(result.warnings.some((issue) => issue.path === "/classifier/mystery"));
});

test("loadEffectivePolicy merges an experiment arm over the top-level policy", (t) => {
  const dir = tempDir(t);

  const top = defaultPolicy();
  top.experiment.mode = "interleave";
  top.experiment.arms = { A: "arm-a.yaml" };
  top.limits.max_rounds_per_task = 5;
  top.privacy.store_description_excerpt = true;
  top.quality_weights.feedback = 0.45;
  writeFileSync(join(dir, "policy.yaml"), JSON.stringify(top), "utf8");

  const arm = defaultPolicy();
  arm.policy_name = "arm-a";
  arm.classifier.model = "arm-classifier";
  const dsh = arm.targets["dsh"];
  assert.ok(dsh !== undefined);
  arm.targets["dsh"] = { ...dsh, enabled: false };
  writeFileSync(join(dir, "arm-a.yaml"), JSON.stringify(arm), "utf8");

  const effective = loadEffectivePolicy(dir, { arm: "A" });
  assert.equal(effective.arm, "A");
  assert.equal(effective.policy.classifier.model, "arm-classifier");
  assert.equal(effective.policy.targets["dsh"]?.enabled, false);
  assert.equal(effective.policy.experiment.mode, "interleave");
  assert.equal(effective.policy.limits.max_rounds_per_task, 5);
  assert.equal(effective.policy.privacy.store_description_excerpt, true);
  assert.equal(effective.policy.quality_weights.feedback, 0.45);
  assert.equal(effective.policy_version, policyVersion(effective.policy));
});

test("resolveHome prefers --home, then EVENER_HOME", (t) => {
  const dir = tempDir(t);
  const fromEnv = join(dir, "env-home");
  const fromFlag = join(dir, "flag-home");

  assert.equal(resolveHome({ home: fromFlag, env: { EVENER_HOME: fromEnv } }), fromFlag);
  assert.equal(resolveHome({ env: { EVENER_HOME: fromEnv } }), fromEnv);
});
