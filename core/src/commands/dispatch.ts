/**
 * `evener dispatch` — run one routed round on a target harness.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  defaultPolicy,
  defaultPricing,
  loadEffectivePolicy,
  loadPricing,
  pricingVersion,
} from "../config.js";
import { DispatchError, recordHostRound, runDispatch } from "../dispatch/index.js";
import type { DispatchResult } from "../dispatch/index.js";
import type { Policy, Pricing } from "../types.js";
import { nowIso } from "../util.js";
import { CommandError } from "./types.js";
import type { CommandContext, CommandRegistry } from "./types.js";

type OptionValue = string | boolean | string[] | undefined;

function stringOption(value: OptionValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredOption(values: Record<string, OptionValue>, key: string): string {
  const value = stringOption(values[key]);
  if (value === undefined || value.length === 0) {
    throw new CommandError("invalid_arguments", `--${key} is required`);
  }
  return value;
}

function loadDispatchPolicy(ctx: CommandContext, arm: string | null): Policy {
  if (!existsSync(ctx.policyPath)) return defaultPolicy();
  return loadEffectivePolicy(ctx.home, arm === null ? {} : { arm }).policy;
}

function loadDispatchPricing(ctx: CommandContext): { pricing: Pricing; version: string } {
  const pricing = existsSync(ctx.pricingPath) ? loadPricing(ctx.pricingPath) : defaultPricing();
  return { pricing, version: pricingVersion(pricing) };
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CommandError("invalid_arguments", "--timeout-s must be a positive number");
  }
  return seconds;
}

function nonNegativeNumber(
  value: string | undefined,
  flag: string,
  integer = false,
): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isInteger(number))) {
    throw new CommandError(
      "invalid_arguments",
      `--${flag} must be a non-negative${integer ? " integer" : " number"}`,
    );
  }
  return number;
}

async function cmdDispatch(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: "string" },
      "prompt-file": { type: "string" },
      cwd: { type: "string" },
      target: { type: "string" },
      "timeout-s": { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  const taskId = requiredOption(values, "task");
  const promptOption = requiredOption(values, "prompt-file");
  const promptPath = resolve(ctx.io.cwd, promptOption);

  try {
    readFileSync(promptPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError("file_not_found", `cannot read prompt file: ${message}`);
  }

  const store = ctx.store();
  const task = store.getTask(taskId);
  if (task === null) {
    throw new CommandError("task_not_found", `task not found: ${taskId}`);
  }
  if (task.state !== "routed") {
    throw new CommandError("invalid_state", `task ${taskId} is in state "${task.state}", expected "routed"`);
  }

  const target = stringOption(values["target"]) ?? task.current_target;
  if (target === null || target.length === 0) {
    throw new CommandError("invalid_state", `task ${taskId} has no current target`);
  }
  if (target === "host") {
    throw new CommandError("host_not_dispatchable", `target "host" runs in the current host session`);
  }

  const policy = loadDispatchPolicy(ctx, task.arm);
  if (policy.targets[target] === undefined) {
    throw new CommandError("unknown_target", `target "${target}" is not defined in policy.targets`);
  }
  const { pricing, version: pricingVersionValue } = loadDispatchPricing(ctx);

  const cwdOption = stringOption(values["cwd"]);
  const cwd = cwdOption === undefined ? ctx.io.cwd : resolve(ctx.io.cwd, cwdOption);
  const timeoutS = parseTimeout(stringOption(values["timeout-s"]));

  let result: DispatchResult;
  try {
    result = await runDispatch({
      store,
      policy,
      pricing,
      pricingVersion: pricingVersionValue,
      task,
      target,
      promptPath,
      cwd,
      ...(timeoutS === undefined ? {} : { timeoutS }),
      env: ctx.io.env,
      now: nowIso,
      home: ctx.home,
    });
  } catch (err) {
    if (err instanceof DispatchError) {
      throw new CommandError(err.code, err.message);
    }
    throw err;
  }

  return result;
}

// ---------------------------------------------------------------------------
// done — record a host-executed round
// ---------------------------------------------------------------------------

async function cmdDone(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: "string" },
      "wall-ms": { type: "string" },
      "cost-usd": { type: "string" },
      model: { type: "string" },
      status: { type: "string" },
      cwd: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  const taskId = requiredOption(values, "task");
  const wallMs = nonNegativeNumber(stringOption(values["wall-ms"]), "wall-ms", true);
  const costUsd = nonNegativeNumber(stringOption(values["cost-usd"]), "cost-usd");
  const statusRaw = stringOption(values["status"]) ?? "success";
  if (statusRaw !== "success" && statusRaw !== "error") {
    throw new CommandError("invalid_arguments", "--status must be success or error");
  }
  const model = stringOption(values["model"]) ?? null;

  const store = ctx.store();
  const task = store.getTask(taskId);
  if (task === null) {
    throw new CommandError("task_not_found", `task not found: ${taskId}`);
  }

  const { version } = loadDispatchPricing(ctx);
  const cwdOption = stringOption(values["cwd"]);
  const cwd = cwdOption === undefined ? ctx.io.cwd : resolve(ctx.io.cwd, cwdOption);

  try {
    return await recordHostRound({
      store,
      task,
      cwd,
      pricingVersion: version,
      ...(wallMs === undefined ? {} : { wallMs }),
      ...(costUsd === undefined ? {} : { costUsd }),
      model,
      status: statusRaw,
      now: nowIso,
    });
  } catch (err) {
    if (err instanceof DispatchError) {
      throw new CommandError(err.code, err.message);
    }
    throw err;
  }
}

export function register(commands: CommandRegistry): void {
  commands["dispatch"] = cmdDispatch;
  commands["done"] = cmdDone;
}
