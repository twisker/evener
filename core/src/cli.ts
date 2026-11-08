#!/usr/bin/env node
import { copyFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  ConfigError,
  defaultPolicy,
  loadEffectivePolicy,
  loadPolicy,
  policyTemplatePath,
  policyVersion,
  pricingTemplatePath,
  resolveHome,
  validatePolicy,
  validatePolicyFile,
} from "./config.js";
import type { PolicyValidationResult } from "./config.js";
import type { Policy } from "./types.js";
import { ensureDir } from "./util.js";

// ---------------------------------------------------------------------------
// IO / context
// ---------------------------------------------------------------------------

export type CliSink =
  | ((text: string) => void)
  | {
      write(chunk: string): unknown;
    };

export interface CliIO {
  stdout: CliSink;
  stderr: CliSink;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
}

export type OutputFormat = "json" | "md";

export interface CliContext {
  home: string;
  format: OutputFormat;
  quiet: boolean;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  io: CliIO;
  print(value: unknown): void;
}

export type CommandHandler = (ctx: CliContext, argv: string[]) => Promise<unknown>;

function emitText(sink: CliSink, text: string): void {
  if (typeof sink === "function") {
    sink(text);
  } else {
    sink.write(text);
  }
}

function renderOutput(value: unknown, format: OutputFormat): string {
  const json = JSON.stringify(value, null, 2) ?? "null";
  if (format === "md") return `\`\`\`json\n${json}\n\`\`\`\n`;
  return `${json}\n`;
}

/** Command failures that carry their own machine-readable output and exit code. */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly payload: unknown;

  constructor(code: string, message: string, opts: { exitCode?: number; payload?: unknown } = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = opts.exitCode ?? 1;
    this.payload = opts.payload;
  }
}

// ---------------------------------------------------------------------------
// Global flags
// ---------------------------------------------------------------------------

interface GlobalOptions {
  home?: string;
  format: OutputFormat;
  quiet: boolean;
}

interface GlobalParseResult {
  options: GlobalOptions;
  rest: string[];
  error?: string;
}

function extractGlobalOptions(argv: string[]): GlobalParseResult {
  const options: GlobalOptions = { format: "json", quiet: false };
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (arg === "--home") {
      const value = argv[index + 1];
      if (value === undefined) return { options, rest, error: "--home requires a value" };
      options.home = value;
      index += 1;
    } else if (arg.startsWith("--home=")) {
      const value = arg.slice("--home=".length);
      if (value.length === 0) return { options, rest, error: "--home requires a value" };
      options.home = value;
    } else if (arg === "--format") {
      const value = argv[index + 1];
      if (value !== "json" && value !== "md") {
        return { options, rest, error: "--format must be json or md" };
      }
      options.format = value;
      index += 1;
    } else if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      if (value !== "json" && value !== "md") {
        return { options, rest, error: "--format must be json or md" };
      }
      options.format = value;
    } else if (arg === "--quiet" || arg === "-q") {
      options.quiet = true;
    } else if (arg === "--json") {
      options.format = "json";
    } else {
      rest.push(arg);
    }
  }

  return { options, rest };
}

function errorPayload(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdInit(ctx: CliContext, argv: string[]): Promise<unknown> {
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

  return {
    home,
    policy_path: policyPath,
    pricing_path: pricingPath,
    db_path: dbPath,
    created,
  };
}

function policyForCommand(ctx: CliContext, file: string | undefined): Policy {
  if (file !== undefined) return loadPolicy(file);
  const homePolicy = join(ctx.home, "policy.yaml");
  if (existsSync(homePolicy)) return loadEffectivePolicy(ctx.home).policy;
  return defaultPolicy();
}

async function cmdPolicyValidate(ctx: CliContext, argv: string[]): Promise<unknown> {
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
    throw new CliError("validation_failed", "policy validation failed", {
      exitCode: 2,
      payload,
    });
  }
  return payload;
}

async function cmdPolicyShow(ctx: CliContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: { file: { type: "string" } },
    allowPositionals: false,
    strict: true,
  });
  return policyForCommand(ctx, values["file"]);
}

async function cmdPolicyHash(ctx: CliContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: { file: { type: "string" } },
    allowPositionals: false,
    strict: true,
  });
  const policy = policyForCommand(ctx, values["file"]);
  return { policy_version: policyVersion(policy) };
}

async function cmdPolicy(ctx: CliContext, argv: string[]): Promise<unknown> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "validate") return cmdPolicyValidate(ctx, rest);
  if (subcommand === "show") return cmdPolicyShow(ctx, rest);
  if (subcommand === "hash") return cmdPolicyHash(ctx, rest);
  throw new CliError("unknown_command", subcommand === undefined ? "policy requires a subcommand" : `unknown policy command: ${subcommand}`);
}

// ---------------------------------------------------------------------------
// Command registry — later tasks add their commands here.
// ---------------------------------------------------------------------------

export const commands: Record<string, CommandHandler> = {
  init: cmdInit,
  policy: cmdPolicy,
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the CLI in-process. Tests use this directly; the bin wrapper calls it
 * with the real process streams. Returns the process exit code.
 */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const globals = extractGlobalOptions(argv);
  const format = globals.options.format;
  const home = resolveHome({ home: globals.options.home, env: io.env });

  const print = (value: unknown): void => {
    emitText(io.stdout, renderOutput(value, format));
  };

  const ctx: CliContext = {
    home,
    format,
    quiet: globals.options.quiet,
    cwd: io.cwd,
    env: io.env,
    io,
    print,
  };

  if (globals.error !== undefined) {
    print(errorPayload("invalid_arguments", globals.error));
    return 1;
  }

  const [command, ...commandArgs] = globals.rest;
  if (command === undefined) {
    print(errorPayload("unknown_command", "no command given"));
    return 1;
  }

  const handler = commands[command];
  if (handler === undefined) {
    print(errorPayload("unknown_command", `unknown command: ${command}`));
    return 1;
  }

  try {
    const output = await handler(ctx, commandArgs);
    if (!ctx.quiet && output !== undefined) print(output);
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      print(err.payload ?? errorPayload(err.code, err.message));
      return err.exitCode;
    }
    if (err instanceof ConfigError) {
      const payload = {
        ...errorPayload(err.code, err.message),
        errors: err.errors,
        warnings: err.warnings,
      };
      print(payload);
      return err.exitCode;
    }
    const code = typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      const message = err instanceof Error ? err.message : String(err);
      print(errorPayload("invalid_arguments", message));
      return 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    print(errorPayload("internal_error", message));
    return 1;
  }
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const code = await runCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
  });
  process.exitCode = code;
}
