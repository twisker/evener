/**
 * Lightweight read-only reader for SSE change detection.
 *
 * `Store` intentionally exposes only the query surface the CLI needs, and the
 * UI must not pull whole event rows just to learn the current sequence number.
 * This wrapper opens a second read-only SQLite connection on the same WAL
 * database; concurrent readers are supported by SQLite.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SeqReader {
  /** Current `max(events.seq)`, or 0 when the database is unavailable. */
  maxSeq(): number;
  close(): void;
}

export function openSeqReader(dbPath: string): SeqReader {
  let db: DatabaseSync | null = null;
  try {
    if (existsSync(resolve(dbPath))) {
      db = new DatabaseSync(resolve(dbPath), { readOnly: true });
    }
  } catch {
    db = null;
  }

  let closed = false;
  return {
    maxSeq(): number {
      if (closed || db === null) return 0;
      try {
        const row = db.prepare("SELECT max(seq) AS seq FROM events").get();
        const value = row?.["seq"];
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
      } catch {
        return 0;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        db?.close();
      } catch {
        // The process is shutting down; a close failure is not actionable.
      }
      db = null;
    },
  };
}
