/**
 * Local export formats (spec §9 / CLI §11).
 *
 * JSONL is a stream of event envelopes; OTel is an OTLP-JSON document. Nothing
 * here performs network I/O — it only serialises events read from the store.
 */

import type { Store } from "./store.js";
import type { EvenerEvent } from "./types.js";

export type ExportSince = Date | string | undefined;

function sinceString(since: ExportSince): string | undefined {
  if (since === undefined) return undefined;
  return since instanceof Date ? since.toISOString() : since;
}

/** One JSON-encoded event envelope per line, oldest first. */
export function exportJsonl(store: Store, since?: ExportSince): string {
  const events = store.listEvents({ since: sinceString(since) });
  if (events.length === 0) return "";
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// OTLP-JSON types (only the subset we emit)
// ---------------------------------------------------------------------------

export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  observedTimeUnixNano?: string;
  severityNumber?: number;
  severityText?: string;
  body: OtlpAnyValue;
  attributes: OtlpKeyValue[];
}

export interface OtlpScopeLogs {
  scope: { name: string; version?: string };
  logRecords: OtlpLogRecord[];
}

export interface OtlpResourceLogs {
  resource: { attributes: OtlpKeyValue[] };
  scopeLogs: OtlpScopeLogs[];
}

export interface OtlpLogsDocument {
  resourceLogs: OtlpResourceLogs[];
}

function stringAttribute(key: string, value: string): OtlpKeyValue {
  return { key, value: { stringValue: value } };
}

function intAttribute(key: string, value: number): OtlpKeyValue {
  return { key, value: { intValue: String(value) } };
}

function envelopeAttributes(event: EvenerEvent): OtlpKeyValue[] {
  return [
    stringAttribute("event_id", event.event_id),
    stringAttribute("task_id", event.task_id),
    intAttribute("round", event.round),
    stringAttribute("ts", event.ts),
    stringAttribute("type", event.type),
    stringAttribute("host", event.host),
    stringAttribute("host_session_id", event.host_session_id ?? ""),
    stringAttribute("policy_version", event.policy_version),
    intAttribute("schema_version", event.schema_version),
  ];
}

function timeUnixNano(ts: string): string {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return "0";
  return String(Math.trunc(ms * 1_000_000));
}

/**
 * OTLP-JSON with one log record per event. `body` is the JSON string of the
 * event payload and `attributes` carries the envelope fields.
 */
export function exportOtel(store: Store, since?: ExportSince): OtlpLogsDocument {
  const events = store.listEvents({ since: sinceString(since) });
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            stringAttribute("service.name", "evener"),
            stringAttribute("service.version", "0.1.0"),
          ],
        },
        scopeLogs: [
          {
            scope: { name: "evener", version: "0.1.0" },
            logRecords: events.map((event) => ({
              timeUnixNano: timeUnixNano(event.ts),
              observedTimeUnixNano: timeUnixNano(event.ts),
              severityNumber: 9,
              severityText: "INFO",
              body: { stringValue: JSON.stringify(event.data) },
              attributes: envelopeAttributes(event),
            })),
          },
        ],
      },
    ],
  };
}
