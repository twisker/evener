/**
 * SQLite event store.
 *
 * `events` is the append-only source of truth; `tasks` is a cache maintained by
 * the projection in {@link applyProjection}. The cache can be discarded and
 * rebuilt from events at any time (`rebuildTasks`).
 */

import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import {
  CHECK_NAMES,
  CHECK_RESULTS,
  CIRCUIT_STATES,
  CONTEXT_DELTAS,
  DECIDED_BY_VALUES,
  DISPATCH_STATUSES,
  EVENT_TYPES,
  LABELS,
  OUTCOMES,
  RATINGS,
  REDISPATCH_KINDS,
  REJECT_REASONS,
  REVIEW_VERDICTS,
  VERDICTS,
} from "./types.js";
import type {
  AcceptanceFinishedPayload,
  DispatchFinishedPayload,
  EventType,
  EvenerEvent,
  Label,
  Outcome,
  Rating,
  RouteDecidedPayload,
  TaskCreatedPayload,
  TaskRow,
  TaskState,
} from "./types.js";
import { ensureDir } from "./util.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error raised for invalid events or an unusable store. */
export class StoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TaskFilter {
  /** When true, only tasks that are not closed. */
  open?: boolean;
  /** ISO-8601 timestamp; only tasks created at or after it. */
  since?: string;
  hostSessionId?: string;
}

export interface EventFilter {
  /** ISO-8601 timestamp; only events at or after it. */
  since?: string;
  /** When provided, only these event types. */
  types?: EventType[];
}

export interface Store {
  appendEvent(ev: EvenerEvent): void;
  getTask(taskId: string): TaskRow | null;
  listTasks(filter?: TaskFilter): TaskRow[];
  getEvents(taskId: string): EvenerEvent[];
  listEvents(filter?: EventFilter): EvenerEvent[];
  rebuildTasks(): number;
  withTransaction<T>(fn: () => T): T;
  nextRound(taskId: string): number;
  close(): void;
}

// ---------------------------------------------------------------------------
// Schema migrations (spec §4)
// ---------------------------------------------------------------------------

const MIGRATION_1 = `
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL, round INTEGER NOT NULL,
  ts TEXT NOT NULL, type TEXT NOT NULL, host TEXT NOT NULL, host_session_id TEXT,
  policy_version TEXT NOT NULL, schema_version INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX events_task ON events(task_id, seq);
CREATE INDEX events_type_ts ON events(type, ts);
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY, created_ts TEXT NOT NULL, closed_ts TEXT,
  host TEXT NOT NULL, host_session_id TEXT, analysis_label TEXT NOT NULL,
  arm TEXT, policy_version TEXT NOT NULL,
  current_round INTEGER NOT NULL DEFAULT 1, current_target TEXT,
  state TEXT NOT NULL,            -- created|routed|dispatching|awaiting_acceptance|closed
  outcome TEXT,                   -- accepted|handed_to_human|abandoned
  first_pass INTEGER,             -- 1 if round 1 accepted
  total_cost_usd REAL NOT NULL DEFAULT 0, total_wall_ms INTEGER NOT NULL DEFAULT 0,
  rating TEXT, overridden INTEGER NOT NULL DEFAULT 0);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- schema_version, etc.
`;

const MIGRATIONS: Readonly<Record<number, string>> = { 1: MIGRATION_1 };

const SCHEMA_VERSION = 1;

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

function readSchemaVersion(db: DatabaseSync): number {
  if (!tableExists(db, "meta")) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (row === undefined) return 0;
  const value = Number(row["value"]);
  return Number.isInteger(value) ? value : 0;
}

function writeSchemaVersion(db: DatabaseSync, version: number): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(version));
}

function migrate(db: DatabaseSync): void {
  let version = readSchemaVersion(db);
  if (version >= SCHEMA_VERSION) return;

  while (version < SCHEMA_VERSION) {
    const next = version + 1;
    const ddl = MIGRATIONS[next];
    if (ddl === undefined) {
      throw new StoreError("schema_error", `no migration for schema version ${next}`);
    }

    // A partially initialised database may already have the tables while the
    // meta table is empty. Treat that as version 1 rather than re-running DDL.
    if (next === 1 && tableExists(db, "events") && tableExists(db, "tasks")) {
      writeSchemaVersion(db, next);
      version = next;
      continue;
    }

    db.exec("BEGIN");
    try {
      db.exec(ddl);
      writeSchemaVersion(db, next);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The original error is the useful one.
      }
      throw err;
    }
    version = next;
  }
}

// ---------------------------------------------------------------------------
// Event validation
// ---------------------------------------------------------------------------

const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function errorAt(errors: string[], path: string, message: string): void {
  errors.push(`${path}: ${message}`);
}

function checkString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  nullable = false,
): void {
  const value = obj[key];
  if (value === null && nullable) return;
  if (typeof value !== "string") {
    errorAt(errors, path, nullable ? "must be a string or null" : "must be a string");
  }
}

interface NumberCheck {
  nullable?: boolean;
  integer?: boolean;
  min?: number;
}

function checkNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  opts: NumberCheck = {},
): void {
  const value = obj[key];
  if (value === null && opts.nullable === true) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errorAt(errors, path, opts.nullable === true ? "must be a number or null" : "must be a number");
    return;
  }
  if (opts.integer === true && !Number.isInteger(value)) {
    errorAt(errors, path, "must be an integer");
  }
  if (opts.min !== undefined && value < opts.min) {
    errorAt(errors, path, `must be >= ${opts.min}`);
  }
}

function checkEnum(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly string[],
  errors: string[],
  nullable = false,
): void {
  const value = obj[key];
  if (value === null && nullable) return;
  if (typeof value !== "string" || !allowed.includes(value)) {
    errorAt(errors, path, `must be one of: ${allowed.join(", ")}${nullable ? ", null" : ""}`);
  }
}

function checkObject(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  nullable = false,
): Record<string, unknown> | null {
  const value = obj[key];
  if (value === null && nullable) return null;
  if (!isRecord(value)) {
    errorAt(errors, path, nullable ? "must be an object or null" : "must be an object");
    return null;
  }
  return value;
}

function checkArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): unknown[] | null {
  const value = obj[key];
  if (!Array.isArray(value)) {
    errorAt(errors, path, "must be an array");
    return null;
  }
  return value;
}

function checkStringArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): void {
  const value = checkArray(obj, key, path, errors);
  if (value === null) return;
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      errorAt(errors, `${path}/${index}`, "must be a string");
    }
  });
}

function validateTaskCreated(data: Record<string, unknown>, errors: string[]): void {
  checkString(data, "description_hash", "/data/description_hash", errors);
  checkString(data, "description_excerpt", "/data/description_excerpt", errors, true);
  checkString(data, "repo_fingerprint", "/data/repo_fingerprint", errors, true);
  const features = checkObject(data, "pre_features", "/data/pre_features", errors);
  if (features !== null) {
    checkNumber(features, "description_chars", "/data/pre_features/description_chars", errors, {
      integer: true,
      min: 0,
    });
    checkNumber(features, "files_mentioned", "/data/pre_features/files_mentioned", errors, {
      integer: true,
      min: 0,
    });
    checkNumber(features, "repo_files", "/data/pre_features/repo_files", errors, {
      integer: true,
      min: 0,
      nullable: true,
    });
  }
  checkEnum(data, "analysis_label", "/data/analysis_label", LABELS, errors);
  checkString(data, "labeler_model", "/data/labeler_model", errors);
  checkStringArray(data, "constraints", "/data/constraints", errors);
  // `arm` is not part of the frozen payload, but the projection accepts it when
  // present so a task can be created already assigned to an experiment arm.
  if (hasOwn(data, "arm")) {
    checkString(data, "arm", "/data/arm", errors, true);
  }
}

function validateRouteDecided(data: Record<string, unknown>, errors: string[]): void {
  checkString(data, "target", "/data/target", errors);
  const candidates = checkArray(data, "candidates", "/data/candidates", errors);
  if (candidates !== null) {
    candidates.forEach((candidate, index) => {
      const path = `/data/candidates/${index}`;
      if (!isRecord(candidate)) {
        errorAt(errors, path, "must be an object");
        return;
      }
      checkString(candidate, "target", `${path}/target`, errors);
      checkNumber(candidate, "score", `${path}/score`, errors);
    });
  }
  checkString(data, "rationale", "/data/rationale", errors);
  checkEnum(data, "decided_by", "/data/decided_by", DECIDED_BY_VALUES, errors);
  checkString(data, "rule_id", "/data/rule_id", errors, true);
  checkString(data, "classifier_model", "/data/classifier_model", errors, true);
  checkNumber(data, "classifier_latency_ms", "/data/classifier_latency_ms", errors, {
    integer: true,
    min: 0,
    nullable: true,
  });
  checkNumber(data, "classifier_cost_usd", "/data/classifier_cost_usd", errors, {
    min: 0,
    nullable: true,
  });
  checkString(data, "arm", "/data/arm", errors, true);
  checkString(data, "escalated_from", "/data/escalated_from", errors, true);
}

function validateDispatchStarted(data: Record<string, unknown>, errors: string[]): void {
  checkString(data, "target", "/data/target", errors);
  checkString(data, "target_version", "/data/target_version", errors, true);
  checkString(data, "model", "/data/model", errors, true);
  checkNumber(data, "context_bytes", "/data/context_bytes", errors, { integer: true, min: 0 });
  checkString(data, "command", "/data/command", errors);
}

function validateDispatchFinished(data: Record<string, unknown>, errors: string[]): void {
  checkEnum(data, "status", "/data/status", DISPATCH_STATUSES, errors);
  checkNumber(data, "wall_ms", "/data/wall_ms", errors, { integer: true, min: 0 });
  const usage = checkObject(data, "usage", "/data/usage", errors);
  if (usage !== null) {
    for (const key of ["input", "cached_input", "output", "reasoning"]) {
      checkNumber(usage, key, `/data/usage/${key}`, errors, { integer: true, min: 0 });
    }
  }
  checkObject(data, "usage_raw", "/data/usage_raw", errors);
  checkNumber(data, "cost_usd", "/data/cost_usd", errors, { min: 0 });
  checkString(data, "price_table_version", "/data/price_table_version", errors);
  const diff = checkObject(data, "diff_stats", "/data/diff_stats", errors, true);
  if (diff !== null) {
    for (const key of ["files", "insertions", "deletions"]) {
      checkNumber(diff, key, `/data/diff_stats/${key}`, errors, { integer: true, min: 0 });
    }
  }
  checkNumber(data, "tool_calls", "/data/tool_calls", errors, {
    integer: true,
    min: 0,
    nullable: true,
  });
  checkNumber(data, "exit_code", "/data/exit_code", errors, { integer: true, nullable: true });
  checkString(data, "target_session_id", "/data/target_session_id", errors, true);
  checkString(data, "output_path", "/data/output_path", errors, true);
}

function validateAcceptanceFinished(data: Record<string, unknown>, errors: string[]): void {
  checkEnum(data, "verdict", "/data/verdict", VERDICTS, errors);
  const checks = checkArray(data, "checks", "/data/checks", errors);
  if (checks !== null) {
    checks.forEach((check, index) => {
      const path = `/data/checks/${index}`;
      if (!isRecord(check)) {
        errorAt(errors, path, "must be an object");
        return;
      }
      checkEnum(check, "name", `${path}/name`, CHECK_NAMES, errors);
      checkEnum(check, "result", `${path}/result`, CHECK_RESULTS, errors);
    });
  }
  checkEnum(data, "review_verdict", "/data/review_verdict", REVIEW_VERDICTS, errors);
  checkEnum(data, "reject_reason", "/data/reject_reason", REJECT_REASONS, errors, true);
  checkNumber(data, "reviewer_cost_usd", "/data/reviewer_cost_usd", errors, { min: 0 });
  checkNumber(data, "reviewer_wall_ms", "/data/reviewer_wall_ms", errors, {
    integer: true,
    min: 0,
  });
}

function validateTaskRedispatch(data: Record<string, unknown>, errors: string[]): void {
  checkString(data, "reason", "/data/reason", errors);
  checkEnum(data, "context_delta", "/data/context_delta", CONTEXT_DELTAS, errors);
  checkString(data, "next_target", "/data/next_target", errors);
  checkEnum(data, "kind", "/data/kind", REDISPATCH_KINDS, errors);
}

function validateTaskClosed(data: Record<string, unknown>, errors: string[]): void {
  checkEnum(data, "outcome", "/data/outcome", OUTCOMES, errors);
  checkNumber(data, "total_rounds", "/data/total_rounds", errors, { integer: true, min: 0 });
  checkNumber(data, "total_cost_usd", "/data/total_cost_usd", errors, { min: 0 });
  checkNumber(data, "total_wall_ms", "/data/total_wall_ms", errors, { integer: true, min: 0 });
}

function validateUserFeedback(data: Record<string, unknown>, errors: string[]): void {
  checkEnum(data, "rating", "/data/rating", RATINGS, errors);
  checkString(data, "comment", "/data/comment", errors, true);
}

function validateUserOverride(data: Record<string, unknown>, errors: string[]): void {
  checkString(data, "from", "/data/from", errors);
  checkString(data, "to", "/data/to", errors);
}

function validatePostRevert(data: Record<string, unknown>, errors: string[]): void {
  checkNumber(data, "days_after", "/data/days_after", errors, { integer: true, min: 0 });
  checkNumber(data, "reverted_ratio", "/data/reverted_ratio", errors, { min: 0 });
}

function validateTargetCircuit(data: Record<string, unknown>, errors: string[]): void {
  checkString(data, "target", "/data/target", errors);
  checkEnum(data, "state", "/data/state", CIRCUIT_STATES, errors);
  checkString(data, "until", "/data/until", errors, true);
}

function validatePayload(type: EventType, value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errorAt(errors, "/data", "must be an object");
    return;
  }
  switch (type) {
    case "task.created":
      validateTaskCreated(value, errors);
      return;
    case "route.decided":
      validateRouteDecided(value, errors);
      return;
    case "dispatch.started":
      validateDispatchStarted(value, errors);
      return;
    case "dispatch.finished":
      validateDispatchFinished(value, errors);
      return;
    case "acceptance.finished":
      validateAcceptanceFinished(value, errors);
      return;
    case "task.redispatch":
      validateTaskRedispatch(value, errors);
      return;
    case "task.closed":
      validateTaskClosed(value, errors);
      return;
    case "user.feedback":
      validateUserFeedback(value, errors);
      return;
    case "user.override":
      validateUserOverride(value, errors);
      return;
    case "post.revert":
      validatePostRevert(value, errors);
      return;
    case "target.circuit":
      validateTargetCircuit(value, errors);
      return;
  }
}

function validateEvent(input: unknown): EvenerEvent {
  if (!isRecord(input)) {
    throw new StoreError("invalid_event", "invalid event: envelope must be an object");
  }
  const errors: string[] = [];
  checkString(input, "event_id", "/event_id", errors);
  checkString(input, "task_id", "/task_id", errors);
  checkNumber(input, "round", "/round", errors, { integer: true, min: 1 });
  checkString(input, "ts", "/ts", errors);
  checkString(input, "host", "/host", errors);
  checkString(input, "host_session_id", "/host_session_id", errors, true);
  checkString(input, "policy_version", "/policy_version", errors);
  checkNumber(input, "schema_version", "/schema_version", errors, { integer: true });
  if (input["schema_version"] !== 1) {
    errorAt(errors, "/schema_version", "must be 1");
  }

  const type = input["type"];
  if (typeof type !== "string" || !EVENT_TYPE_SET.has(type)) {
    errorAt(errors, "/type", `must be one of: ${EVENT_TYPES.join(", ")}`);
  } else {
    validatePayload(type as EventType, input["data"], errors);
  }

  if (errors.length > 0) {
    throw new StoreError("invalid_event", `invalid event: ${errors.join("; ")}`);
  }
  return input as unknown as EvenerEvent;
}

// ---------------------------------------------------------------------------
// Projection (pure)
// ---------------------------------------------------------------------------

type CreatedData = TaskCreatedPayload & { arm?: string | null };

/**
 * Apply one event to a task row. Returns a new row (inputs are never mutated)
 * or null when the event cannot be projected because the task is unknown.
 */
export function applyProjection(row: TaskRow | null, ev: EvenerEvent): TaskRow | null {
  if (ev.type === "task.created") {
    const data = ev.data as CreatedData;
    return {
      task_id: ev.task_id,
      created_ts: ev.ts,
      closed_ts: null,
      host: ev.host,
      host_session_id: ev.host_session_id,
      analysis_label: data.analysis_label,
      arm: data.arm ?? null,
      policy_version: ev.policy_version,
      current_round: 1,
      current_target: null,
      state: "created",
      outcome: null,
      first_pass: null,
      total_cost_usd: 0,
      total_wall_ms: 0,
      rating: null,
      overridden: 0,
    };
  }

  if (row === null) return null;

  switch (ev.type) {
    case "route.decided": {
      const data: RouteDecidedPayload = ev.data;
      const classifierCost = data.classifier_cost_usd ?? 0;
      return {
        ...row,
        current_target: data.target,
        arm: data.arm ?? row.arm,
        state: "routed",
        total_cost_usd: row.total_cost_usd + classifierCost,
      };
    }
    case "dispatch.started":
      return { ...row, state: "dispatching" };
    case "dispatch.finished": {
      const data: DispatchFinishedPayload = ev.data;
      return {
        ...row,
        total_cost_usd: row.total_cost_usd + data.cost_usd,
        total_wall_ms: row.total_wall_ms + data.wall_ms,
        state: "awaiting_acceptance",
      };
    }
    case "acceptance.finished": {
      const data: AcceptanceFinishedPayload = ev.data;
      return {
        ...row,
        total_cost_usd: row.total_cost_usd + data.reviewer_cost_usd,
        total_wall_ms: row.total_wall_ms + data.reviewer_wall_ms,
        first_pass:
          ev.round === 1 ? (data.verdict === "accepted" ? 1 : 0) : row.first_pass,
      };
    }
    case "task.redispatch":
      return {
        ...row,
        current_round: ev.round,
        current_target: ev.data.next_target,
        state: "routed",
      };
    case "task.closed":
      return {
        ...row,
        closed_ts: ev.ts,
        outcome: ev.data.outcome,
        state: "closed",
      };
    case "user.feedback":
      return { ...row, rating: ev.data.rating };
    case "user.override":
      return {
        ...row,
        overridden: 1,
        current_target: ev.data.to,
      };
    case "target.circuit":
    case "post.revert":
      return row;
  }
}

// ---------------------------------------------------------------------------
// Row conversion
// ---------------------------------------------------------------------------

const TASK_COLUMNS =
  "task_id, created_ts, closed_ts, host, host_session_id, analysis_label, arm, " +
  "policy_version, current_round, current_target, state, outcome, first_pass, " +
  "total_cost_usd, total_wall_ms, rating, overridden";

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function mapTaskRow(row: Record<string, unknown>): TaskRow {
  return {
    task_id: String(row["task_id"]),
    created_ts: String(row["created_ts"]),
    closed_ts: nullableString(row["closed_ts"]),
    host: String(row["host"]),
    host_session_id: nullableString(row["host_session_id"]),
    analysis_label: String(row["analysis_label"]) as Label,
    arm: nullableString(row["arm"]),
    policy_version: String(row["policy_version"]),
    current_round: Number(row["current_round"]),
    current_target: nullableString(row["current_target"]),
    state: String(row["state"]) as TaskState,
    outcome: nullableString(row["outcome"]) as Outcome | null,
    first_pass: nullableNumber(row["first_pass"]),
    total_cost_usd: Number(row["total_cost_usd"]),
    total_wall_ms: Number(row["total_wall_ms"]),
    rating: nullableString(row["rating"]) as Rating | null,
    overridden: Number(row["overridden"]),
  };
}

function mapEventRow(row: Record<string, unknown>): EvenerEvent {
  let data: unknown;
  try {
    data = JSON.parse(String(row["data"]));
  } catch (err) {
    throw new StoreError(
      "invalid_event",
      `stored event ${String(row["event_id"])} has invalid JSON: ${String(err)}`,
    );
  }
  return validateEvent({
    event_id: row["event_id"],
    task_id: row["task_id"],
    round: Number(row["round"]),
    ts: row["ts"],
    type: row["type"],
    host: row["host"],
    host_session_id: row["host_session_id"],
    policy_version: row["policy_version"],
    schema_version: Number(row["schema_version"]),
    data,
  });
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

class SqliteStore implements Store {
  readonly #db: DatabaseSync;
  #transactionDepth = 0;
  #closed = false;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  appendEvent(ev: EvenerEvent): void {
    const valid = validateEvent(ev);
    this.withTransaction(() => {
      this.#db
        .prepare(
          "INSERT INTO events (event_id, task_id, round, ts, type, host, " +
            "host_session_id, policy_version, schema_version, data) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          valid.event_id,
          valid.task_id,
          valid.round,
          valid.ts,
          valid.type,
          valid.host,
          valid.host_session_id,
          valid.policy_version,
          valid.schema_version,
          JSON.stringify(valid.data),
        );

      const next = applyProjection(this.getTask(valid.task_id), valid);
      if (next !== null) this.#putTask(next);
    });
  }

  getTask(taskId: string): TaskRow | null {
    const row = this.#db
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE task_id = ?`)
      .get(taskId);
    return row === undefined ? null : mapTaskRow(row);
  }

  listTasks(filter: TaskFilter = {}): TaskRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (filter.open === true) {
      where.push("state <> 'closed'");
    }
    if (filter.since !== undefined) {
      where.push("created_ts >= ?");
      params.push(filter.since);
    }
    if (filter.hostSessionId !== undefined) {
      where.push("host_session_id = ?");
      params.push(filter.hostSessionId);
    }

    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const rows = this.#db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks${clause} ORDER BY created_ts DESC, task_id ASC`,
      )
      .all(...params);
    return rows.map(mapTaskRow);
  }

  getEvents(taskId: string): EvenerEvent[] {
    const rows = this.#db
      .prepare(
        "SELECT event_id, task_id, round, ts, type, host, host_session_id, " +
          "policy_version, schema_version, data FROM events " +
          "WHERE task_id = ? ORDER BY seq ASC",
      )
      .all(taskId);
    return rows.map(mapEventRow);
  }

  listEvents(filter: EventFilter = {}): EvenerEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (filter.since !== undefined) {
      where.push("ts >= ?");
      params.push(filter.since);
    }
    if (filter.types !== undefined) {
      if (filter.types.length === 0) return [];
      where.push(`type IN (${filter.types.map(() => "?").join(", ")})`);
      for (const type of filter.types) params.push(type);
    }

    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const rows = this.#db
      .prepare(
        "SELECT event_id, task_id, round, ts, type, host, host_session_id, " +
          `policy_version, schema_version, data FROM events${clause} ORDER BY seq ASC`,
      )
      .all(...params);
    return rows.map(mapEventRow);
  }

  rebuildTasks(): number {
    return this.withTransaction(() => {
      this.#db.exec("DELETE FROM tasks");
      const rows = this.#db
        .prepare(
          "SELECT event_id, task_id, round, ts, type, host, host_session_id, " +
            "policy_version, schema_version, data FROM events ORDER BY seq ASC",
        )
        .all();

      const rebuilt = new Map<string, TaskRow>();
      for (const row of rows) {
        const ev = mapEventRow(row);
        const next = applyProjection(rebuilt.get(ev.task_id) ?? null, ev);
        if (next !== null) rebuilt.set(ev.task_id, next);
      }
      for (const task of rebuilt.values()) this.#putTask(task);
      return rebuilt.size;
    });
  }

  withTransaction<T>(fn: () => T): T {
    if (this.#transactionDepth > 0) return fn();

    this.#db.exec("BEGIN");
    this.#transactionDepth += 1;
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      throw err;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  nextRound(taskId: string): number {
    const row = this.#db
      .prepare("SELECT current_round FROM tasks WHERE task_id = ?")
      .get(taskId);
    if (row === undefined) return 1;
    return Number(row["current_round"]) + 1;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #putTask(task: TaskRow): void {
    this.#db
      .prepare(
        "INSERT INTO tasks (" +
          TASK_COLUMNS +
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(task_id) DO UPDATE SET " +
          "created_ts = excluded.created_ts, closed_ts = excluded.closed_ts, " +
          "host = excluded.host, host_session_id = excluded.host_session_id, " +
          "analysis_label = excluded.analysis_label, arm = excluded.arm, " +
          "policy_version = excluded.policy_version, " +
          "current_round = excluded.current_round, " +
          "current_target = excluded.current_target, state = excluded.state, " +
          "outcome = excluded.outcome, first_pass = excluded.first_pass, " +
          "total_cost_usd = excluded.total_cost_usd, " +
          "total_wall_ms = excluded.total_wall_ms, rating = excluded.rating, " +
          "overridden = excluded.overridden",
      )
      .run(
        task.task_id,
        task.created_ts,
        task.closed_ts,
        task.host,
        task.host_session_id,
        task.analysis_label,
        task.arm,
        task.policy_version,
        task.current_round,
        task.current_target,
        task.state,
        task.outcome,
        task.first_pass,
        task.total_cost_usd,
        task.total_wall_ms,
        task.rating,
        task.overridden,
      );
  }
}

/**
 * Open (or create) the SQLite store. Parent directories are created, WAL and
 * foreign keys are enabled, and pending migrations are applied.
 */
export function openStore(dbPath: string): Store {
  if (dbPath !== ":memory:") {
    ensureDir(dirname(resolve(dbPath)));
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return new SqliteStore(db);
}
