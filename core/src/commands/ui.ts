/**
 * `evener ui` (spec §11, §13).
 *
 * The command prints `{url, home, pid}` immediately and leaves the process
 * alive through the HTTP server until SIGINT/SIGTERM closes it.
 */

import { parseArgs } from "node:util";
import { startUiServer } from "../ui/server.js";
import { CommandError } from "./types.js";
import type { CommandContext, CommandRegistry } from "./types.js";

const DEFAULT_PORT = 7331;

function parsePort(value: string | boolean | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new CommandError("invalid_arguments", "--port must be an integer from 0 to 65535");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new CommandError("invalid_arguments", "--port must be an integer from 0 to 65535");
  }
  return port;
}

async function cmdUi(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      "no-open": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  const port = parsePort(values["port"]);
  const server = await startUiServer({
    home: ctx.home,
    port,
    openBrowser: values["no-open"] !== true,
    io: ctx.io,
  });

  const shutdown = (): void => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    void server.close();
  };
  const onSigint = (): void => shutdown();
  const onSigterm = (): void => shutdown();
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return { url: server.url, home: ctx.home, pid: process.pid };
}

export function register(commands: CommandRegistry): void {
  commands["ui"] = cmdUi;
}
