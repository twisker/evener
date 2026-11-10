/**
 * `evener update-check` (spec §11): notify-only version check.
 */

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { defaultPolicy, loadPolicy } from "../config.js";
import { checkForUpdate } from "../update-check.js";
import { packageVersion } from "../version.js";
import type { CommandContext, CommandRegistry } from "./types.js";

/** Tests may inject a fetch implementation on the CLI IO object. */
function injectedFetch(ctx: CommandContext): typeof fetch | undefined {
  const value = (ctx.io as { fetchImpl?: unknown }).fetchImpl;
  return typeof value === "function" ? (value as typeof fetch) : undefined;
}

async function cmdUpdateCheck(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      offline: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  const policy = existsSync(ctx.policyPath) ? loadPolicy(ctx.policyPath) : defaultPolicy();
  return checkForUpdate({
    home: ctx.home,
    policy,
    current: packageVersion(),
    now: new Date(),
    fetch: injectedFetch(ctx) ?? globalThis.fetch,
    force: values["force"] === true,
    offline: values["offline"] === true,
    env: ctx.io.env,
  });
}

export function register(commands: CommandRegistry): void {
  commands["update-check"] = cmdUpdateCheck;
}
