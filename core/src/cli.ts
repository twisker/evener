#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, resolveHome } from "./config.js";
import { openStore } from "./store.js";
import type { Store } from "./store.js";
import { CommandError } from "./commands/types.js";
import type { CliIO, CommandContext, CommandHandler, CommandRegistry } from "./commands/types.js";
import { register as registerPolicy } from "./commands/policy.js";
import { register as registerTask } from "./commands/task.js";
import { register as registerRouter } from "./commands/router.js";
import { register as registerDispatch } from "./commands/dispatch.js";
import { register as registerLifecycle } from "./commands/lifecycle.js";
import { register as registerReport } from "./commands/report.js";

export type { CliIO, CliSink, CommandHandler, CommandRegistry } from "./commands/types.js";
export { CommandError as CliError } from "./commands/types.js";

// ---------------------------------------------------------------------------
// IO / output
// ---------------------------------------------------------------------------

export type OutputFormat = "json" | "md" | "jsonl" | "otel";

function isOutputFormat(value: string): value is OutputFormat {
  return value === "json" || value === "md" || value === "jsonl" || value === "otel";
}

function emitText(sink: CliIO["stdout"], text: string): void {
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
      if (value === undefined || !isOutputFormat(value)) {
        return { options, rest, error: "--format must be json, md, jsonl or otel" };
      }
      options.format = value;
      index += 1;
    } else if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      if (!isOutputFormat(value)) {
        return { options, rest, error: "--format must be json, md, jsonl or otel" };
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
// Command registry
// ---------------------------------------------------------------------------

export const commands: CommandRegistry = {};
registerPolicy(commands);
registerTask(commands);
registerRouter(commands);
registerDispatch(commands);
registerLifecycle(commands);
registerReport(commands);

/**
 * `report` is implemented by a later task. Register a placeholder when the
 * module is still a stub so `evener help` can advertise the reserved name.
 */
if (commands["report"] === undefined) {
  commands["report"] = async () => {
    throw new CommandError("not_implemented", "report is not implemented in this build");
  };
}

/** One-line usage text for `evener help`, keyed by registered command name. */
const commandUsages: Readonly<Record<string, string>> = {
  init: "init [--force]",
  policy: "policy validate|show|hash [--file F]",
  task: "task create --description-file F [--files a,b] [--constraint c]* [--host H] [--host-session S] [--cwd DIR]",
  status: "status --task T",
  tasks: "tasks [--open] [--since 14d] [--host-session S]",
  event: "event --type X --task T [--round N] --data JSON",
  rebuild: "rebuild",
  decide: "decide --task T [--dry-run]",
  dispatch: "dispatch --task T --prompt-file F [--cwd DIR] [--target X] [--timeout-s N]",
  done: "done --task T [--wall-ms N] [--cost-usd C] [--model M] [--status success|error] [--cwd DIR]",
  accept:
    "accept --task T --verdict accepted|rejected [--reason R] [--check name=result]* [--review pass|fail|skipped] [--reviewer-cost-usd C] [--reviewer-wall-ms W]",
  next: "next --task T",
  close: "close --task T --outcome accepted|handed_to_human|abandoned",
  feedback: "feedback --task T --rating up|down [--comment TEXT]",
  override: "override --task T --to X",
  sweep: "sweep --host-session S",
  report: "report [--since 14d|YYYY-MM-DD] [--by label] [--format md|json] [--out FILE]",
  help: "help",
};

commands["help"] = async () => ({
  commands: Object.keys(commands)
    .sort()
    .map((name) => ({ name, usage: commandUsages[name] ?? name })),
});

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
  const policyPath = join(home, "policy.yaml");
  const pricingPath = join(home, "pricing.yaml");
  const dbPath = join(home, "evener.sqlite");

  const print = (value: unknown): void => {
    emitText(io.stdout, renderOutput(value, format));
  };

  let store: Store | undefined;
  const getStore = (): Store => {
    store ??= openStore(dbPath);
    return store;
  };

  const ctx: CommandContext = {
    home,
    policyPath,
    pricingPath,
    dbPath,
    store: getStore,
    io,
    format,
  };

  if (globals.error !== undefined) {
    print(errorPayload("invalid_arguments", globals.error));
    return 1;
  }

  const [first, ...rest] = globals.rest;
  const isHelp = first === "--help" || first === "-h";
  const command: string | undefined = isHelp ? "help" : first;
  const commandArgs: string[] = isHelp ? [] : rest;
  if (command === undefined) {
    print(errorPayload("unknown_command", "no command given"));
    return 1;
  }

  const handler: CommandHandler | undefined = commands[command];
  if (handler === undefined) {
    print(errorPayload("unknown_command", `unknown command: ${command}`));
    return 1;
  }

  try {
    const output = await handler(ctx, commandArgs);
    if (!globals.options.quiet && output !== undefined) print(output);
    return 0;
  } catch (err) {
    if (err instanceof CommandError) {
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
  } finally {
    store?.close();
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
