/**
 * Shared command registration and execution types.
 *
 * Command modules are registered into a flat registry keyed by the top-level
 * CLI name. The context owns a lazy store handle so commands that do not touch
 * the database (policy show/hash) never create it.
 */

import type { Store } from "../store.js";

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

export interface CommandContext {
  home: string;
  policyPath: string;
  pricingPath: string;
  dbPath: string;
  /** Lazily open the store; repeated calls return the same handle. */
  store: () => Store;
  io: CliIO;
  /** Global `--format` value (commands that emit raw text use this). */
  format?: "json" | "md" | "jsonl" | "otel";
  /** Global `--quiet` / `-q` flag; suppresses warnings and result output. */
  quiet?: boolean;
}

export type CommandHandler = (ctx: CommandContext, argv: string[]) => Promise<unknown>;

export type CommandRegistry = Record<string, CommandHandler>;

export interface CommandErrorOptions {
  exitCode?: number;
  payload?: unknown;
}

/** Command failures that carry a machine-readable code and exit status. */
export class CommandError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly payload: unknown;

  constructor(code: string, message: string, opts: CommandErrorOptions = {}) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.exitCode = opts.exitCode ?? 1;
    this.payload = opts.payload;
  }
}
