import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { exportJsonl, exportOtel } from "../src/export.js";
import { openStore } from "../src/store.js";
import type { Store } from "../src/store.js";
import type { EventType, EvenerEvent, PayloadByType } from "../src/types.js";

const T0 = Date.parse("2020-01-01T00:00:00.000Z");

interface Fixture {
  store: Store;
  dir: string;
}

function tempStore(t: TestContext): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "evener-export-"));
  const store = openStore(join(dir, "evener.sqlite"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir };
}

let eventSeq = 0;

function envelope<K extends EventType>(
  taskId: string,
  type: K,
  round: number,
  ts: string,
  data: PayloadByType[K],
): EvenerEvent {
  eventSeq += 1;
  return {
    event_id: `export-event-${eventSeq}`,
    task_id: taskId,
    round,
    ts,
    type,
    host: "claude-code",
    host_session_id: "session-1",
    policy_version: "policy000001",
    schema_version: 1,
    data,
  } as EvenerEvent;
}

function seedEvents(store: Store): EvenerEvent[] {
  const events: EvenerEvent[] = [];
  const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

  for (let index = 0; index < 3; index += 1) {
    const taskId = `task-${index}`;
    const created = envelope(taskId, "task.created", 1, at(index), {
      description_hash: `hash-${index}`,
      description_excerpt: null,
      repo_fingerprint: null,
      pre_features: { description_chars: 10, files_mentioned: 1, repo_files: null },
      analysis_label: "bugfix",
      labeler_model: "heuristic",
      constraints: [],
    });
    events.push(created);

    if (index < 2) {
      const route = envelope(taskId, "route.decided", 1, at(index), {
        target: "codex",
        candidates: [{ target: "codex", score: 1 }],
        rationale: "test",
        decided_by: "fallback",
        rule_id: null,
        classifier_model: null,
        classifier_latency_ms: 42,
        classifier_cost_usd: 0,
        arm: null,
        escalated_from: null,
      });
      events.push(route);
    }
  }

  events.push(
    envelope("task-0", "dispatch.finished", 1, at(10), {
      status: "success",
      wall_ms: 100,
      usage: { input: 1, cached_input: 0, output: 1, reasoning: 0 },
      usage_raw: {},
      cost_usd: 0.01,
      price_table_version: "price0000000",
      diff_stats: null,
      tool_calls: null,
      exit_code: 0,
      target_session_id: null,
      output_path: null,
    }),
  );
  events.push(
    envelope("task-0", "task.closed", 1, at(11), {
      outcome: "accepted",
      total_rounds: 1,
      total_cost_usd: 0.01,
      total_wall_ms: 100,
    }),
  );

  for (const event of events) store.appendEvent(event);
  return events;
}

test("exportJsonl emits one line per event and round-trips envelopes", (t) => {
  const { store } = tempStore(t);
  const events = seedEvents(store);

  const output = exportJsonl(store);
  const lines = output.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, events.length);
  assert.equal(lines.length, store.listEvents().length);

  const parsed = JSON.parse(lines[0] ?? "null") as EvenerEvent;
  assert.equal(parsed.event_id, events[0]?.event_id);
  assert.equal(parsed.type, "task.created");
});

test("exportJsonl honours the since filter", (t) => {
  const { store } = tempStore(t);
  seedEvents(store);
  const since = new Date(T0 + 5 * 60_000);
  const lines = exportJsonl(store, since).split("\n").filter((line) => line.length > 0);
  assert.ok(lines.length > 0);
  for (const line of lines) {
    const event = JSON.parse(line) as EvenerEvent;
    assert.ok(Date.parse(event.ts) >= since.getTime());
  }
});

test("exportOtel emits OTLP log records with body and envelope attributes", (t) => {
  const { store } = tempStore(t);
  const events = seedEvents(store);

  const document = exportOtel(store);
  assert.equal(document.resourceLogs.length, 1);
  const resourceLogs = document.resourceLogs[0];
  assert.ok(resourceLogs !== undefined);
  assert.equal(resourceLogs.resource.attributes[0]?.key, "service.name");
  const scopeLogs = resourceLogs.scopeLogs[0];
  assert.ok(scopeLogs !== undefined);
  assert.equal(scopeLogs.logRecords.length, events.length);

  const record = scopeLogs.logRecords[0];
  assert.ok(record !== undefined);
  const first = events[0];
  assert.ok(first !== undefined);
  assert.deepEqual(JSON.parse(record.body.stringValue ?? "null"), first.data);
  assert.equal(record.timeUnixNano, String(Date.parse(first.ts) * 1_000_000));

  const attributeKeys = record.attributes.map((attribute) => attribute.key);
  assert.deepEqual(attributeKeys, [
    "event_id",
    "task_id",
    "round",
    "ts",
    "type",
    "host",
    "host_session_id",
    "policy_version",
    "schema_version",
  ]);
  assert.equal(
    record.attributes.find((attribute) => attribute.key === "event_id")?.value.stringValue,
    first.event_id,
  );
});

test("exportOtel honours the since filter", (t) => {
  const { store } = tempStore(t);
  seedEvents(store);
  const since = new Date(T0 + 5 * 60_000);
  const document = exportOtel(store, since);
  const records = document.resourceLogs[0]?.scopeLogs[0]?.logRecords ?? [];
  assert.equal(records.length, store.listEvents({ since: since.toISOString() }).length);
  for (const record of records) {
    assert.ok(Number(record.timeUnixNano) >= since.getTime() * 1_000_000);
  }
});
