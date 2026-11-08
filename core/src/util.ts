import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

/** RFC 4122 version 4 UUID. */
export function uuid(): string {
  return randomUUID();
}

/** Full lowercase hex SHA-256 digest of a UTF-8 string. */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Current time as an ISO-8601 UTC string. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Create a directory (and parents) if it does not exist. */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
