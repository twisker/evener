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
import type { Policy, RuleCondition } from "../src/types.js";

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
    assert.deepEqual(pricingResult.pricing.models["deepseek-flash"], {
      input_per_mtok: 0.3,
      cached_input_per_mtok: 0.006,
      output_per_mtok: 1.2,
    });
    assert.deepEqual(pricingResult.pricing.models["deepseek-v4-pro"], {
      input_per_mtok: 1.32,
      cached_input_per_mtok: 0.044,
      output_per_mtok: 3.96,
    });
    assert.equal(pricingResult.pricing.models["deepseek-v3.2"], undefined);
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

test("the bundled labeler is on by default with the DeepSeek price and thinking request extra", () => {
  const policy = defaultPolicy();
  assert.equal(policy.labeler.model, "deepseek-flash");
  assert.equal(policy.labeler.endpoint, "https://api.deepseek.com/v1");
  assert.equal(policy.labeler.api_key_env, "DEEPSEEK_API_KEY");
  assert.equal(policy.labeler.timeout_ms, 5000);
  assert.deepEqual(policy.labeler.price, {
    input_per_mtok: 0.3,
    output_per_mtok: 1.2,
  });
  assert.deepEqual(policy.labeler.request_extra, { thinking: { type: "disabled" } });
  assert.deepEqual(policy.classifier.request_extra, { thinking: { type: "disabled" } });
  assert.deepEqual(policy.labeler.time_bucket_heuristic, {
    lt15m: { max_files: 1, max_chars: 400 },
    "15m_1h": { max_files: 3, max_chars: 1500 },
    "1h_4h": { max_files: 8, max_chars: 5000 },
  });
  assert.equal(policy.labeler.prompt_extra, null);
});

test("request_extra must be an object and cannot shadow transport fields", () => {
  const messages = structuredClone(defaultPolicy()) as unknown as {
    classifier: { request_extra: unknown };
  };
  messages.classifier.request_extra = { messages: [] };
  const messagesResult = validatePolicy(messages);
  assert.equal(messagesResult.ok, false);
  assert.ok(
    messagesResult.errors.some((issue) => issue.path === "/classifier/request_extra/messages"),
    JSON.stringify(messagesResult.errors),
  );

  const array = structuredClone(defaultPolicy()) as unknown as {
    classifier: { request_extra: unknown };
  };
  array.classifier.request_extra = [];
  assert.equal(validatePolicy(array).ok, false);

  const nullExtra = structuredClone(defaultPolicy());
  nullExtra.classifier.request_extra = null;
  nullExtra.labeler.request_extra = null;
  const accepted = validatePolicy(nullExtra);
  assert.equal(accepted.ok, true, JSON.stringify(accepted.errors));
  if (accepted.ok) {
    assert.equal(accepted.policy.classifier.request_extra, null);
    assert.equal(accepted.policy.labeler.request_extra, null);
  }
});

test("a policy without the new labeler fields loads with nulls, not template values", () => {
  const legacy = JSON.parse(JSON.stringify(defaultPolicy())) as Record<string, unknown>;
  const classifier = legacy["classifier"] as Record<string, unknown>;
  const labeler = legacy["labeler"] as Record<string, unknown>;
  delete classifier["request_extra"];
  delete labeler["timeout_ms"];
  delete labeler["price"];
  delete labeler["request_extra"];

  const result = validatePolicy(legacy);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  if (!result.ok) return;
  assert.equal(result.policy.classifier.request_extra, null);
  assert.equal(result.policy.labeler.timeout_ms, null);
  assert.equal(result.policy.labeler.price, null);
  assert.equal(result.policy.labeler.request_extra, null);
  assert.equal(result.policy.labeler.model, "deepseek-flash");
});

test("labeler timeout_ms must be a positive integer or null", () => {
  const zero = structuredClone(defaultPolicy());
  zero.labeler.timeout_ms = 0;
  assert.equal(validatePolicy(zero).ok, false);

  const fractional = structuredClone(defaultPolicy());
  fractional.labeler.timeout_ms = 1.5;
  assert.equal(validatePolicy(fractional).ok, false);
});

test("labeler price is validated like classifier price", () => {
  const bad = structuredClone(defaultPolicy());
  bad.labeler.price = { input_per_mtok: -1, output_per_mtok: 1 };
  const result = validatePolicy(bad);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((issue) => issue.path === "/labeler/price/input_per_mtok"),
    JSON.stringify(result.errors),
  );

  const nullPrice = structuredClone(defaultPolicy());
  nullPrice.labeler.price = null;
  assert.equal(validatePolicy(nullPrice).ok, true);
});

test("rule conditions combine with AND and reject a bad time_bucket at its JSON pointer", () => {
  const policy = structuredClone(defaultPolicy());
  const rule = policy.rules[0];
  assert.ok(rule !== undefined);
  rule.if = {
    label: "bugfix",
    has_repro: false,
    cross_file: true,
  };
  const valid = validatePolicy(policy);
  assert.equal(valid.ok, true, JSON.stringify(valid.errors));

  rule.if = { time_bucket: "5h" } as unknown as RuleCondition;
  const invalid = validatePolicy(policy);
  assert.equal(invalid.ok, false);
  assert.ok(
    invalid.errors.some((issue) => issue.path === "/rules/0/if/time_bucket"),
    `expected /rules/0/if/time_bucket, got ${JSON.stringify(invalid.errors)}`,
  );
});

test("the heuristic rejects non-positive file and character limits", () => {
  const policy = defaultPolicy();
  policy.labeler.time_bucket_heuristic.lt15m.max_files = 0;
  policy.labeler.time_bucket_heuristic["15m_1h"].max_chars = 0;

  const result = validatePolicy(policy);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (issue) => issue.path === "/labeler/time_bucket_heuristic/lt15m/max_files",
    ),
  );
  assert.ok(
    result.errors.some(
      (issue) => issue.path === "/labeler/time_bucket_heuristic/15m_1h/max_chars",
    ),
  );
});
