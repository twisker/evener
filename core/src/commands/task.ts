/**
 * Task ingestion and query commands:
 * task create, status, tasks, event, rebuild.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  defaultPolicy,
  loadEffectivePolicy,
  loadPolicy,
  policyVersion,
} from "../config.js";
import { assignArm } from "../experiment.js";
import { computePreFeatures, repoFingerprint, repoRemoteUrl } from "../features.js";
import { labelTask } from "../labeler.js";
import { StoreError } from "../store.js";
import { EVENT_TYPES } from "../types.js";
import type {
  EvenerEvent,
  EventType,
  Policy,
  PreFeatures,
  TaskCreatedPayload,
} from "../types.js";
import { nowIso, sha256, uuid } from "../util.js";
import { CommandError } from "./types.js";
import type { CommandContext, CommandRegistry } from "./types.js";

// ---------------------------------------------------------------------------
// parseArgs helpers
// ---------------------------------------------------------------------------

type OptionValue = string | boolean | string[] | undefined;

function stringOption(value: OptionValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringOptions(value: OptionValue): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return [];
}

function requiredOption(values: Record<string, OptionValue>, key: string): string {
  const value = stringOption(values[key]);
  if (value === undefined || value.length === 0) {
    throw new CommandError("invalid_arguments", `--${key} is required`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Glob matching for privacy.private_paths (** and * only)
// ---------------------------------------------------------------------------

function globToRegExp(pattern: string): RegExp {
  const source = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let out = "^";
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    if (char === undefined) break;

    if (char === "*") {
      if (source[index + 1] === "*") {
        if (source[index + 2] === "/") {
          // `**/` matches zero or more directories.
          out += "(?:.*/)?";
          index += 3;
        } else {
          out += ".*";
          index += 2;
        }
      } else {
        out += "[^/]*";
        index += 1;
      }
      continue;
    }

    if ("\\^$+.()|{}[]?+".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
    index += 1;
  }

  return new RegExp(`${out}$`);
}

/** Match a file path against a glob supporting `**` and `*`. */
export function matchesGlob(file: string, pattern: string): boolean {
  const normalised = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return globToRegExp(pattern).test(normalised);
}

// ---------------------------------------------------------------------------
// Policy / feature helpers
// ---------------------------------------------------------------------------

function loadTopPolicy(ctx: CommandContext): Policy {
  return existsSync(ctx.policyPath) ? loadPolicy(ctx.policyPath) : defaultPolicy();
}

function currentPolicyVersion(ctx: CommandContext): string {
  if (!existsSync(ctx.policyPath)) return policyVersion(defaultPolicy());
  return loadEffectivePolicy(ctx.home).policy_version;
}

function addConstraint(constraints: string[], constraint: string): void {
  if (!constraints.includes(constraint)) constraints.push(constraint);
}

interface CreateOptions {
  description: string;
  files: string[];
  constraints: string[];
  host: string;
  hostSession: string | null;
  cwd: string;
}

async function createTask(
  ctx: CommandContext,
  options: CreateOptions,
): Promise<{
  task_id: string;
  analysis_label: string;
  pre_features: PreFeatures;
  policy_version: string;
  arm: string | null;
}> {
  const topPolicy = loadTopPolicy(ctx);
  const taskId = uuid();
  const preFeatures = computePreFeatures(
    options.description,
    options.files,
    options.cwd,
    topPolicy.labeler.time_bucket_heuristic,
  );
  const labelled = await labelTask(options.description, topPolicy, { env: ctx.io.env }, preFeatures);
  // The model may revise the heuristic estimate; both paths need the same field.
  preFeatures.time_bucket = labelled.time_bucket;
  const arm = assignArm(topPolicy, taskId, labelled.label);

  const effective =
    arm === null
      ? { policy: topPolicy, policy_version: policyVersion(topPolicy), arm: null }
      : loadEffectivePolicy(ctx.home, { arm });
  const policy = effective.policy;

  const fingerprint = repoFingerprint(options.cwd);
  const remoteUrl = repoRemoteUrl(options.cwd);

  const constraints = [...options.constraints];
  if (
    options.files.some((file) =>
      policy.privacy.private_paths.some((pattern) => matchesGlob(file, pattern)),
    )
  ) {
    addConstraint(constraints, "private_path");
  }
  if (
    policy.privacy.never_delegate_repos.some(
      (entry) =>
        entry.length > 0 &&
        (entry === fingerprint || (remoteUrl !== null && remoteUrl.includes(entry))),
    )
  ) {
    addConstraint(constraints, "never_delegate");
  }

  const data: TaskCreatedPayload & { arm: string | null } = {
    description_hash: sha256(options.description),
    description_excerpt: policy.privacy.store_description_excerpt
      ? options.description.slice(0, 200)
      : null,
    repo_fingerprint: fingerprint,
    pre_features: preFeatures,
    analysis_label: labelled.label,
    labeler_model: labelled.labeler_model,
    constraints,
    arm,
  };

  const event: EvenerEvent = {
    event_id: uuid(),
    task_id: taskId,
    round: 1,
    ts: nowIso(),
    type: "task.created",
    host: options.host,
    host_session_id: options.hostSession,
    policy_version: effective.policy_version,
    schema_version: 1,
    data,
  };
  ctx.store().appendEvent(event);

  return {
    task_id: taskId,
    analysis_label: labelled.label,
    pre_features: preFeatures,
    policy_version: effective.policy_version,
    arm,
  };
}

// ---------------------------------------------------------------------------
// task create
// ---------------------------------------------------------------------------

async function cmdTaskCreate(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "description-file": { type: "string" },
      files: { type: "string", multiple: true },
      constraint: { type: "string", multiple: true },
      host: { type: "string", default: "claude-code" },
      "host-session": { type: "string" },
      cwd: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  const descriptionFile = requiredOption(values, "description-file");
  let description: string;
  try {
    description = readFileSync(resolve(ctx.io.cwd, descriptionFile), "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError("file_not_found", `cannot read description file: ${message}`);
  }

  const files = stringOptions(values["files"])
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const constraints = stringOptions(values["constraint"])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const cwdOption = stringOption(values["cwd"]);
  const cwd = cwdOption === undefined ? ctx.io.cwd : resolve(ctx.io.cwd, cwdOption);
  const host = stringOption(values["host"]) ?? "claude-code";
  const hostSession = stringOption(values["host-session"]) ?? null;

  return createTask(ctx, { description, files, constraints, host, hostSession, cwd });
}

async function cmdTask(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "create") return cmdTaskCreate(ctx, rest);
  throw new CommandError(
    "unknown_command",
    subcommand === undefined ? "task requires a subcommand" : `unknown task command: ${subcommand}`,
  );
}

// ---------------------------------------------------------------------------
// status / tasks
// ---------------------------------------------------------------------------

async function cmdStatus(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: { task: { type: "string" } },
    allowPositionals: false,
    strict: true,
  });

  const taskId = requiredOption(values, "task");
  const store = ctx.store();
  const task = store.getTask(taskId);
  if (task === null) {
    throw new CommandError("task_not_found", `task not found: ${taskId}`);
  }
  return { task, events: store.getEvents(taskId) };
}

/** Convert `14d` / `2h` / `30m` or an ISO date to an ISO timestamp. */
function parseSince(value: string): string {
  const relative = /^(\d+)([dhm])$/.exec(value.trim());
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const factor = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000;
    return new Date(Date.now() - amount * factor).toISOString();
  }

  const millis = Date.parse(value);
  if (Number.isNaN(millis)) {
    throw new CommandError("invalid_arguments", `invalid --since value: ${value}`);
  }
  return new Date(millis).toISOString();
}

async function cmdTasks(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      open: { type: "boolean", default: false },
      since: { type: "string" },
      "host-session": { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  const since = stringOption(values["since"]);
  const hostSessionId = stringOption(values["host-session"]);

  const tasks = ctx.store().listTasks({
    open: values["open"] === true,
    ...(since === undefined ? {} : { since: parseSince(since) }),
    ...(hostSessionId === undefined ? {} : { hostSessionId }),
  });
  return { tasks };
}

// ---------------------------------------------------------------------------
// event / rebuild
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function cmdEvent(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      type: { type: "string" },
      task: { type: "string" },
      round: { type: "string" },
      data: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  const typeValue = requiredOption(values, "type");
  if (!(EVENT_TYPES as readonly string[]).includes(typeValue)) {
    throw new CommandError("invalid_event", `unknown event type: ${typeValue}`);
  }
  const type = typeValue as EventType;
  const taskId = requiredOption(values, "task");
  const rawData = requiredOption(values, "data");

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError("invalid_json", `--data is not valid JSON: ${message}`);
  }
  if (!isRecord(parsed)) {
    throw new CommandError("invalid_event", "--data must be a JSON object");
  }

  const store = ctx.store();
  const task = store.getTask(taskId);
  const roundValue = stringOption(values["round"]);
  let round = task?.current_round ?? 1;
  if (roundValue !== undefined) {
    round = Number(roundValue);
    if (!Number.isInteger(round) || round < 1) {
      throw new CommandError("invalid_arguments", "--round must be a positive integer");
    }
  }

  const eventId = uuid();
  const event = {
    event_id: eventId,
    task_id: taskId,
    round,
    ts: nowIso(),
    type,
    host: task?.host ?? "claude-code",
    host_session_id: task?.host_session_id ?? null,
    policy_version: task?.policy_version ?? currentPolicyVersion(ctx),
    schema_version: 1,
    data: parsed,
  } as unknown as EvenerEvent;

  try {
    store.appendEvent(event);
  } catch (err) {
    if (err instanceof StoreError) {
      throw new CommandError(err.code, err.message);
    }
    throw err;
  }

  return { event_id: eventId };
}

async function cmdRebuild(ctx: CommandContext): Promise<unknown> {
  return { tasks: ctx.store().rebuildTasks() };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(commands: CommandRegistry): void {
  commands["task"] = cmdTask;
  commands["status"] = cmdStatus;
  commands["tasks"] = cmdTasks;
  commands["event"] = cmdEvent;
  commands["rebuild"] = cmdRebuild;
}
