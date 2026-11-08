import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  defaultPolicy,
  loadEffectivePolicy,
  loadPolicy,
  policyTemplatePath,
  policyVersion,
  pricingTemplatePath,
  validatePolicy,
  validatePolicyFile,
} from "../config.js";
import type { PolicyValidationResult } from "../config.js";
import type { Policy } from "../types.js";
import { ensureDir } from "../util.js";
import { CommandError } from "./types.js";
import type { CommandContext, CommandRegistry } from "./types.js";

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function cmdInit(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      force: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  const home = ctx.home;
  const policyPath = join(home, "policy.yaml");
  const pricingPath = join(home, "pricing.yaml");
  const dbPath = join(home, "evener.sqlite");

  ensureDir(home);
  ensureDir(join(home, "runs"));
  ensureDir(join(home, "reports"));

  const force = values["force"] === true;
  let created = false;

  if (force || !existsSync(policyPath)) {
    copyFileSync(policyTemplatePath(), policyPath);
    created = true;
  }
  if (force || !existsSync(pricingPath)) {
    copyFileSync(pricingTemplatePath(), pricingPath);
    created = true;
  }

  // Open once so the database file and schema exist after init. The CLI closes
  // the handle when the command returns.
  ctx.store();

  return {
    home,
    policy_path: policyPath,
    pricing_path: pricingPath,
    db_path: dbPath,
    created,
  };
}

// ---------------------------------------------------------------------------
// policy validate / show / hash
// ---------------------------------------------------------------------------

function policyForCommand(ctx: CommandContext, file: string | undefined): Policy {
  if (file !== undefined) return loadPolicy(file);
  const homePolicy = join(ctx.home, "policy.yaml");
  if (existsSync(homePolicy)) return loadEffectivePolicy(ctx.home).policy;
  return defaultPolicy();
}

async function cmdPolicyValidate(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: { file: { type: "string" } },
    allowPositionals: false,
    strict: true,
  });

  let result: PolicyValidationResult;
  if (values["file"] !== undefined) {
    result = validatePolicyFile(values["file"]);
  } else {
    const homePolicy = join(ctx.home, "policy.yaml");
    result = existsSync(homePolicy) ? validatePolicyFile(homePolicy) : validatePolicy(defaultPolicy());
  }

  const payload = { ok: result.ok, errors: result.errors, warnings: result.warnings };
  if (!result.ok) {
    throw new CommandError("validation_failed", "policy validation failed", {
      exitCode: 2,
      payload,
    });
  }
  return payload;
}

async function cmdPolicyShow(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: { file: { type: "string" } },
    allowPositionals: false,
    strict: true,
  });
  return policyForCommand(ctx, values["file"]);
}

async function cmdPolicyHash(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: { file: { type: "string" } },
    allowPositionals: false,
    strict: true,
  });
  const policy = policyForCommand(ctx, values["file"]);
  return { policy_version: policyVersion(policy) };
}

async function cmdPolicy(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "validate") return cmdPolicyValidate(ctx, rest);
  if (subcommand === "show") return cmdPolicyShow(ctx, rest);
  if (subcommand === "hash") return cmdPolicyHash(ctx, rest);
  throw new CommandError(
    "unknown_command",
    subcommand === undefined ? "policy requires a subcommand" : `unknown policy command: ${subcommand}`,
  );
}

export function register(commands: CommandRegistry): void {
  commands["init"] = cmdInit;
  commands["policy"] = cmdPolicy;
}
