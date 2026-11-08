/**
 * Dispatch orchestration (spec §7).
 *
 * `runDispatch` is the library entry point behind `evener dispatch`: it checks
 * the API key and task budget, runs the target's JSONL stream, normalises usage
 * and cost, captures git diff statistics and the final message, records the
 * event pair and maintains the per-target circuit breaker.
 */

import { execFile } from "node:child_process";
import type { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveHome } from "../config.js";
import { priceUsage } from "../pricing.js";
import type { Store } from "../store.js";
import type {
  DiffStats,
  DispatchFinishedPayload,
  DispatchStatus,
  EvenerEvent,
  EventType,
  NormalisedUsage,
  PayloadByType,
  Policy,
  Pricing,
  TargetPolicy,
  TaskRow,
} from "../types.js";
import { ensureDir, uuid } from "../util.js";
import { codexAdapter } from "./codex.js";
import { dshAdapter } from "./dsh.js";
import { runJsonlProcess } from "./process.js";
import type { JsonlProcessResult } from "./process.js";

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export interface ParsedRun {
  usage: NormalisedUsage;
  usage_raw: unknown;
  final_text: string | null;
  target_session_id: string | null;
  tool_calls: number | null;
  completed: boolean;
  model: string | null;
}

export interface RunParser {
  onLine(obj: unknown, raw: string): void;
  result(): ParsedRun;
}

export interface TargetAdapter {
  name: string;
  /** Substitute every `{output_file}` placeholder with `ctx.outputFile`. */
  buildArgv(command: string[], ctx: { outputFile: string }): string[];
  createParser(): RunParser;
}

const ADAPTERS: Readonly<Record<string, TargetAdapter>> = {
  codex: codexAdapter,
  dsh: dshAdapter,
};

/** Look up the adapter for a policy target name, or null when unsupported. */
export function adapterForTarget(name: string): TargetAdapter | null {
  return ADAPTERS[name] ?? null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A dispatch failure that the command layer maps to a CLI error code. */
export class DispatchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DispatchError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function zeroUsage(): NormalisedUsage {
  return { input: 0, cached_input: 0, output: 0, reasoning: 0 };
}

function makeEvent<T extends EventType>(
  task: TaskRow,
  type: T,
  ts: string,
  data: PayloadByType[T],
): EvenerEvent {
  return {
    event_id: uuid(),
    task_id: task.task_id,
    round: task.current_round,
    ts,
    type,
    host: task.host,
    host_session_id: task.host_session_id,
    policy_version: task.policy_version,
    schema_version: 1,
    data,
  } as EvenerEvent;
}

// ---------------------------------------------------------------------------
// git diff statistics
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 2_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export function parseNumstat(output: string): DiffStats {
  let files = 0;
  let insertions = 0;
  let deletions = 0;

  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const [rawInsertions, rawDeletions] = line.split("\t");
    if (rawInsertions === undefined || rawDeletions === undefined) continue;

    files += 1;
    const added = Number.parseInt(rawInsertions, 10);
    const removed = Number.parseInt(rawDeletions, 10);
    if (Number.isFinite(added)) insertions += added;
    if (Number.isFinite(removed)) deletions += removed;
  }

  return { files, insertions, deletions };
}

/**
 * `git diff --numstat` totals for `cwd`, or null when `cwd` is not a git work
 * tree. Errors and timeouts are swallowed: diff stats are best-effort.
 */
export function gitDiffStats(cwd: string): Promise<DiffStats | null> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      ["diff", "--numstat"],
      {
        cwd,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      },
      (error, stdout) => {
        if (error !== null) {
          resolvePromise(null);
          return;
        }
        resolvePromise(parseNumstat(String(stdout)));
      },
    );
  });
}

function nonNegativeDifference(after: DiffStats, before: DiffStats): DiffStats {
  return {
    files: Math.max(0, after.files - before.files),
    insertions: Math.max(0, after.insertions - before.insertions),
    deletions: Math.max(0, after.deletions - before.deletions),
  };
}

// ---------------------------------------------------------------------------
// Circuit breaker bookkeeping
// ---------------------------------------------------------------------------

/**
 * Count trailing `error|timeout` finished dispatches for `target`.
 *
 * A `dispatch.started` in the same task/round identifies the target of a
 * `dispatch.finished` payload (which intentionally has no target field). The
 * count restarts at the latest `target.circuit` event for the same target.
 */
export function consecutiveFailures(store: Store, target: string): number {
  const events = store.listEvents({
    types: ["dispatch.started", "dispatch.finished", "target.circuit"],
  });
  const startedTargets = new Map<string, string>();
  let count = 0;

  for (const event of events) {
    if (event.type === "dispatch.started") {
      startedTargets.set(`${event.task_id}:${event.round}`, event.data.target);
      continue;
    }
    if (event.type === "target.circuit") {
      if (event.data.target === target) count = 0;
      continue;
    }
    if (event.type !== "dispatch.finished") continue;

    const eventTarget = startedTargets.get(`${event.task_id}:${event.round}`);
    if (eventTarget !== target) continue;
    count = event.data.status === "error" || event.data.status === "timeout" ? count + 1 : 0;
  }

  return count;
}

function untilIso(ts: string, openMinutes: number): string {
  const base = Date.parse(ts);
  const millis = Number.isNaN(base) ? Date.now() : base;
  return new Date(millis + openMinutes * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// runDispatch
// ---------------------------------------------------------------------------

export interface RunDispatchOptions {
  store: Store;
  policy: Policy;
  pricing: Pricing;
  pricingVersion: string;
  task: TaskRow;
  /** Key in `policy.targets`; the adapter is selected by this name. */
  target: string;
  promptPath: string;
  cwd: string;
  timeoutS?: number;
  env: Readonly<Record<string, string | undefined>>;
  now: () => string;
  spawnImpl?: typeof spawn;
  /** Defaults to the effective `$EVENER_HOME` derived from `env`. */
  home?: string;
}

export interface DispatchResult {
  task_id: string;
  round: number;
  target: string;
  status: DispatchStatus;
  wall_ms: number;
  usage: NormalisedUsage;
  cost_usd: number;
  output_path: string | null;
  target_session_id: string | null;
  exit_code: number | null;
}

interface FinishInput {
  status: DispatchStatus;
  wallMs: number;
  usage: NormalisedUsage;
  usageRaw: unknown;
  cost: { cost_usd: number; cost_unknown: boolean };
  diffStats: DiffStats | null;
  toolCalls: number | null;
  exitCode: number | null;
  sessionId: string | null;
  outputPath: string | null;
  /** False for pre-spawn failures such as a missing API key. */
  countsForCircuit: boolean;
}

function asUsageRaw(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (value === null || value === undefined) return {};
  return { value };
}

function missingApiKey(policy: TargetPolicy, env: RunDispatchOptions["env"]): boolean {
  const keyEnv = policy.api_key_env;
  if (typeof keyEnv !== "string" || keyEnv.length === 0) return false;
  const value = env[keyEnv];
  return value === undefined || value.trim().length === 0;
}

function resolveTimeoutMs(opts: RunDispatchOptions): number {
  const seconds = opts.timeoutS ?? opts.policy.limits.max_wall_per_round_s;
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new DispatchError("invalid_timeout", `invalid timeout: ${String(seconds)}`);
  }
  return Math.round(seconds * 1000);
}

/**
 * Execute one dispatch round and record `dispatch.started` /
 * `dispatch.finished` (plus `target.circuit` when the breaker opens).
 *
 * Pre-spawn failures (missing API key, budget exhausted) record only
 * `dispatch.finished`: no process was started, and a missing key explicitly
 * must not count towards the circuit breaker.
 */
export async function runDispatch(opts: RunDispatchOptions): Promise<DispatchResult> {
  const { store, policy, pricing, task, target } = opts;

  const targetPolicy = policy.targets[target];
  if (targetPolicy === undefined) {
    throw new DispatchError("unknown_target", `target "${target}" is not defined in policy.targets`);
  }
  if (!Array.isArray(targetPolicy.command) || targetPolicy.command.length === 0) {
    throw new DispatchError("host_not_dispatchable", `target "${target}" has no dispatch command`);
  }
  const adapter = adapterForTarget(target);
  if (adapter === null) {
    throw new DispatchError("unsupported_target", `no dispatch adapter for target "${target}"`);
  }

  const promptBuffer = readFileSync(resolve(opts.promptPath));
  const promptText = promptBuffer.toString("utf8");
  const timeoutMs = resolveTimeoutMs(opts);
  const home = opts.home ?? resolveHome({ env: opts.env });
  const runsDir = join(home, "runs", task.task_id);
  const outputFile = join(runsDir, `${task.current_round}.out.md`);
  const stderrFile = join(runsDir, `${task.current_round}.stderr`);
  const model = targetPolicy.model ?? null;

  const emitFinished = (input: FinishInput): DispatchResult => {
    const ts = opts.now();
    const payload: DispatchFinishedPayload & { cost_unknown: boolean } = {
      status: input.status,
      wall_ms: input.wallMs,
      usage: input.usage,
      usage_raw: asUsageRaw(input.usageRaw),
      cost_usd: input.cost.cost_usd,
      price_table_version: opts.pricingVersion,
      diff_stats: input.diffStats,
      tool_calls: input.toolCalls,
      exit_code: input.exitCode,
      target_session_id: input.sessionId,
      output_path: input.outputPath,
      cost_unknown: input.cost.cost_unknown,
    };
    store.appendEvent(makeEvent(task, "dispatch.finished", ts, payload));

    if (input.countsForCircuit) {
      const failures = consecutiveFailures(store, target);
      const threshold = policy.limits.circuit_breaker.failures;
      if (failures >= threshold) {
        store.appendEvent(
          makeEvent(task, "target.circuit", ts, {
            target,
            state: "open",
            until: untilIso(ts, policy.limits.circuit_breaker.open_minutes),
          }),
        );
      }
    }

    return {
      task_id: task.task_id,
      round: task.current_round,
      target,
      status: input.status,
      wall_ms: input.wallMs,
      usage: input.usage,
      cost_usd: input.cost.cost_usd,
      output_path: input.outputPath,
      target_session_id: input.sessionId,
      exit_code: input.exitCode,
    };
  };

  // Pre-checks run before any process is spawned (spec §7).
  const zeroCost = priceUsage(zeroUsage(), model, pricing);
  if (missingApiKey(targetPolicy, opts.env)) {
    return emitFinished({
      status: "error",
      wallMs: 0,
      usage: zeroUsage(),
      usageRaw: {},
      cost: zeroCost,
      diffStats: null,
      toolCalls: null,
      exitCode: null,
      sessionId: null,
      outputPath: null,
      countsForCircuit: false,
    });
  }
  if ((store.getTask(task.task_id) ?? task).total_cost_usd >= policy.limits.max_cost_per_task_usd) {
    return emitFinished({
      status: "budget_exceeded",
      wallMs: 0,
      usage: zeroUsage(),
      usageRaw: {},
      cost: zeroCost,
      diffStats: null,
      toolCalls: null,
      exitCode: null,
      sessionId: null,
      outputPath: null,
      countsForCircuit: false,
    });
  }

  const argv = adapter.buildArgv(targetPolicy.command, { outputFile });
  ensureDir(runsDir);

  store.appendEvent(
    makeEvent(task, "dispatch.started", opts.now(), {
      target,
      target_version: null,
      model,
      context_bytes: promptBuffer.length,
      command: argv.join(" "),
    }),
  );

  const parser = adapter.createParser();
  const before = await gitDiffStats(opts.cwd);
  const spawnStartedAt = Date.now();

  let processResult: JsonlProcessResult;
  try {
    processResult = await runJsonlProcess({
      argv,
      cwd: opts.cwd,
      stdinText: promptText,
      timeoutMs,
      env: opts.env,
      onLine: (obj, raw) => {
        parser.onLine(obj, raw);
      },
      ...(opts.spawnImpl === undefined ? {} : { spawnImpl: opts.spawnImpl }),
    });
  } catch (err) {
    // spawn() can reject synchronously (for example an inaccessible cwd).
    processResult = {
      exitCode: null,
      timedOut: false,
      stderr: err instanceof Error ? err.message : String(err),
      wallMs: Date.now() - spawnStartedAt,
    };
  }

  const after = await gitDiffStats(opts.cwd);
  const parsed = parser.result();

  const status: DispatchStatus = processResult.timedOut
    ? "timeout"
    : processResult.exitCode === 0 && parsed.completed
      ? "success"
      : "error";

  const usage = parsed.usage ?? zeroUsage();
  const cost = priceUsage(usage, parsed.model ?? model, pricing);
  const diffStats = before !== null && after !== null ? nonNegativeDifference(after, before) : null;

  let outputPath: string | null = null;
  if (parsed.final_text !== null) {
    writeFileSync(outputFile, parsed.final_text, "utf8");
    outputPath = outputFile;
  }
  writeFileSync(stderrFile, processResult.stderr, "utf8");

  return emitFinished({
    status,
    wallMs: processResult.wallMs,
    usage,
    usageRaw: parsed.usage_raw,
    cost,
    diffStats,
    toolCalls: parsed.tool_calls,
    exitCode: processResult.exitCode,
    sessionId: parsed.target_session_id,
    outputPath,
    countsForCircuit: status === "error" || status === "timeout",
  });
}
