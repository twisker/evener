/**
 * Read-only HTTP server for the web panel (spec §13).
 *
 * The server binds loopback only, has no mutating route, and keeps all
 * arithmetic in the pure projections of `views.ts`. The single HTML file is
 * served straight from the package; no bundler or external CDN is involved.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { open as openFile, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  defaultPolicy,
  defaultPricing,
  loadEffectivePolicy,
  loadPricing,
  pricingVersion,
} from "../config.js";
import type { Policy, Pricing } from "../types.js";
import { existsSync } from "node:fs";
import { parseSince } from "../commands/report.js";
import { CommandError } from "../commands/types.js";
import type { CliIO } from "../commands/types.js";
import { buildReport, REPORT_DIMENSIONS } from "../report.js";
import type { ReportBy } from "../report.js";
import { openStore } from "../store.js";
import type { Store } from "../store.js";
import type { EvenerEvent, TaskRow } from "../types.js";
import { openSeqReader } from "./seq.js";
import { overview, roundViews, sessionViews, taskSummaries } from "./views.js";

export interface UiServerOptions {
  home: string;
  port: number;
  openBrowser: boolean;
  io: CliIO;
}

export interface UiServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const TASK_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const LOOPBACK = "127.0.0.1";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function errorPayload(
  code: string,
  message: string,
): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = `${JSON.stringify(value)}\n`;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(body)));
  if (req.method === "HEAD") res.end();
  else res.end(body);
}

function sendError(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(req, res, status, errorPayload(code, message));
}

function sendBody(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", String(body.byteLength));
  if (req.method === "HEAD") res.end();
  else res.end(body);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new CommandError("invalid_arguments", "malformed URL segment");
  }
}

function isSafeTaskId(value: string): boolean {
  return TASK_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Config / query helpers
// ---------------------------------------------------------------------------

function loadPolicy(home: string): Policy {
  const path = join(home, "policy.yaml");
  return existsSync(path) ? loadEffectivePolicy(home).policy : defaultPolicy();
}

function loadPricingForHome(home: string): Pricing {
  const path = join(home, "pricing.yaml");
  return existsSync(path) ? loadPricing(path) : defaultPricing();
}

/** `since` accepts report forms plus the page's `all` shortcut. */
function sinceParam(
  value: string | null,
  now: Date,
  fallback: Date | undefined,
): Date | undefined {
  if (value === null || value.length === 0) return fallback;
  if (value === "all") return new Date(0);
  return parseSince(value, now);
}

function parseLimit(value: string | null): number {
  if (value === null || value.length === 0) return 50;
  if (!/^\d+$/.test(value)) {
    throw new CommandError("invalid_arguments", "--limit must be a non-negative integer");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit)) {
    throw new CommandError("invalid_arguments", "--limit must be a non-negative integer");
  }
  return limit;
}

function parseRound(value: string | null, fallback: number): number {
  if (value === null || value.length === 0) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new CommandError("invalid_arguments", "--round must be a positive integer");
  }
  const round = Number(value);
  if (!Number.isSafeInteger(round) || round < 1) {
    throw new CommandError("invalid_arguments", "--round must be a positive integer");
  }
  return round;
}

function parseTail(value: string | null): number | null {
  if (value === null || value.length === 0) return null;
  if (!/^\d+$/.test(value)) {
    throw new CommandError("invalid_arguments", "--tail must be a non-negative integer");
  }
  const tail = Number(value);
  if (!Number.isSafeInteger(tail)) {
    throw new CommandError("invalid_arguments", "--tail must be a non-negative integer");
  }
  return tail;
}

function eventsByTask(
  store: Store,
  tasks: readonly TaskRow[],
): Map<string, EvenerEvent[]> {
  const map = new Map<string, EvenerEvent[]>();
  for (const task of tasks) map.set(task.task_id, store.getEvents(task.task_id));
  return map;
}

async function readTail(path: string, tail: number | null): Promise<Buffer | null> {
  let handle;
  try {
    handle = await openFile(path, "r");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }

  try {
    const { size } = await handle.stat();
    const length = tail === null ? size : Math.min(tail, size);
    const position = size - length;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        length - offset,
        position + offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

function openInBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", url] }
        : { file: "xdg-open", args: [url] };

  try {
    const child = spawn(command.file, command.args, {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {
      // A missing browser helper must never take down the panel.
    });
    child.unref();
  } catch {
    // Ignored for the same reason.
  }
}

// ---------------------------------------------------------------------------
// Static page
// ---------------------------------------------------------------------------

const UI_CANDIDATES = [
  // Packaged layout: dist/src/ui -> dist/ui (when the build copies the page).
  new URL("../../ui/index.html", import.meta.url),
  // Source layout: dist/src/ui -> core/ui.
  new URL("../../../ui/index.html", import.meta.url),
];

async function readUiPage(): Promise<Buffer | null> {
  for (const candidate of UI_CANDIDATES) {
    try {
      return await readFile(candidate);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return null;
}

function placeholderPage(): Buffer {
  return Buffer.from(
    [
      "<!doctype html>",
      '<html lang="en"><head><meta charset="utf-8">',
      "<title>Evener · UI file absent</title></head><body>",
      "<h1>Evener web panel</h1>",
      "<p>The UI file <code>core/ui/index.html</code> is absent from this install.</p>",
      "<p>API routes are still available under <code>/api/</code>.</p>",
      "</body></html>",
      "",
    ].join("\n"),
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startUiServer(opts: UiServerOptions): Promise<UiServer> {
  const dbPath = join(opts.home, "evener.sqlite");
  const store = openStore(dbPath);
  const seqReader = openSeqReader(dbPath);
  const clients = new Set<SseClient>();

  const httpServer: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          // The socket is already gone.
        }
        return;
      }
      if (error instanceof CommandError) {
        sendError(req, res, 400, error.code, error.message);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      sendError(req, res, 500, "internal", message);
    });
  });

  // -------------------------------------------------------------------------
  // Route handlers
  // -------------------------------------------------------------------------

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      sendError(req, res, 405, "method_not_allowed", "only GET and HEAD are supported");
      return;
    }

    const parsed = new URL(req.url ?? "/", `http://${LOOPBACK}`);
    const pathname = parsed.pathname;

    if (pathname === "/") {
      const page = (await readUiPage()) ?? placeholderPage();
      sendBody(req, res, 200, "text/html; charset=utf-8", page);
      return;
    }

    const parts = pathname.split("/").filter((part) => part.length > 0);
    if (parts[0] !== "api") {
      sendError(req, res, 404, "not_found", `unknown route: ${pathname}`);
      return;
    }

    const now = new Date();

    if (parts.length === 2 && parts[1] === "overview") {
      const tasks = store.listTasks();
      const policy = loadPolicy(opts.home);
      const pricing = loadPricingForHome(opts.home);
      sendJson(
        req,
        res,
        200,
        overview(tasks, [], policy, pricingVersion(pricing), now, opts.home),
      );
      return;
    }

    if (parts.length === 2 && parts[1] === "tasks") {
      const state = parsed.searchParams.get("state") ?? "open";
      if (state !== "open" && state !== "closed" && state !== "all") {
        throw new CommandError(
          "invalid_arguments",
          `state must be open, closed or all (got "${state}")`,
        );
      }
      const since = sinceParam(parsed.searchParams.get("since"), now, undefined);
      const hostSession = parsed.searchParams.get("host_session");
      const limit = parseLimit(parsed.searchParams.get("limit"));

      const tasks = store
        .listTasks({
          ...(since === undefined ? {} : { since: since.toISOString() }),
          ...(hostSession === null || hostSession.length === 0
            ? {}
            : { hostSessionId: hostSession }),
        })
        .filter((task) =>
          state === "all"
            ? true
            : state === "closed"
              ? task.state === "closed"
              : task.state !== "closed",
        )
        .slice(0, limit);

      sendJson(req, res, 200, {
        tasks: taskSummaries(tasks, eventsByTask(store, tasks), now),
      });
      return;
    }

    if (parts.length === 2 && parts[1] === "report") {
      const since =
        sinceParam(parsed.searchParams.get("since"), now, undefined) ??
        parseSince(undefined, now);
      const byValue = parsed.searchParams.get("by") ?? "label";
      if (!(REPORT_DIMENSIONS as readonly string[]).includes(byValue)) {
        throw new CommandError(
          "invalid_arguments",
          `by must be one of: ${REPORT_DIMENSIONS.join(", ")}`,
        );
      }
      const report = buildReport(
        store,
        loadPolicy(opts.home),
        loadPricingForHome(opts.home),
        { since, now, by: byValue as ReportBy },
      );
      sendJson(req, res, 200, report);
      return;
    }

    if (parts.length === 2 && parts[1] === "sessions") {
      const since =
        sinceParam(parsed.searchParams.get("since"), now, undefined) ??
        parseSince(undefined, now);
      const tasks = store.listTasks({ since: since.toISOString() });
      sendJson(req, res, 200, {
        sessions: sessionViews(tasks, eventsByTask(store, tasks), since),
      });
      return;
    }

    if (parts.length === 2 && parts[1] === "stream") {
      handleStream(req, res);
      return;
    }

    if (parts.length >= 3 && parts[1] === "task") {
      const idPart = parts[2];
      if (idPart === undefined) {
        sendError(req, res, 404, "not_found", `unknown route: ${pathname}`);
        return;
      }
      const taskId = decodeSegment(idPart);
      if (!isSafeTaskId(taskId)) {
        sendError(req, res, 404, "not_found", `task not found: ${taskId}`);
        return;
      }

      if (parts.length === 3) {
        const task = store.getTask(taskId);
        if (task === null) {
          sendError(req, res, 404, "not_found", `task not found: ${taskId}`);
          return;
        }
        const events = store.getEvents(taskId);
        sendJson(req, res, 200, {
          task,
          rounds: roundViews(events),
          events,
        });
        return;
      }

      if (parts.length === 4 && parts[3] === "output") {
        await handleOutput(req, res, parsed, taskId);
        return;
      }
    }

    sendError(req, res, 404, "not_found", `unknown route: ${pathname}`);
  }

  async function handleOutput(
    req: IncomingMessage,
    res: ServerResponse,
    parsed: URL,
    taskId: string,
  ): Promise<void> {
    const task = store.getTask(taskId);
    if (task === null) {
      sendError(req, res, 404, "not_found", `task not found: ${taskId}`);
      return;
    }

    const round = parseRound(parsed.searchParams.get("round"), task.current_round);
    const stream = parsed.searchParams.get("stream") ?? "out";
    if (stream !== "out" && stream !== "stderr") {
      throw new CommandError(
        "invalid_arguments",
        `stream must be out or stderr (got "${stream}")`,
      );
    }
    const tail = parseTail(parsed.searchParams.get("tail"));

    const suffix = stream === "stderr" ? ".stderr" : ".out.md";
    const runsRoot = resolve(opts.home, "runs");
    const filePath = resolve(runsRoot, taskId, `${round}${suffix}`);
    if (filePath !== runsRoot && !filePath.startsWith(`${runsRoot}${sep}`)) {
      sendError(req, res, 404, "not_found", "output not found");
      return;
    }

    const body = await readTail(filePath, tail);
    if (body === null) {
      sendError(req, res, 404, "not_found", "output not found");
      return;
    }
    sendBody(req, res, 200, "text/plain; charset=utf-8", body);
  }

  interface SseClient {
    res: ServerResponse;
    poll: ReturnType<typeof setInterval> | null;
    ping: ReturnType<typeof setInterval> | null;
  }

  function cleanupClient(client: SseClient): void {
    if (client.poll !== null) {
      clearInterval(client.poll);
      client.poll = null;
    }
    if (client.ping !== null) {
      clearInterval(client.ping);
      client.ping = null;
    }
    clients.delete(client);
  }

  function handleStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const client: SseClient = { res, poll: null, ping: null };
    let lastSeq = seqReader.maxSeq();

    client.poll = setInterval(() => {
      try {
        const next = seqReader.maxSeq();
        if (next > lastSeq) {
          lastSeq = next;
          res.write(`event: change\ndata: ${JSON.stringify({ seq: next })}\n\n`);
        }
      } catch {
        // A transient read failure should not end an otherwise healthy stream.
      }
    }, 1000);

    client.ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        cleanupClient(client);
      }
    }, 15_000);

    const cleanup = (): void => cleanupClient(client);
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
    clients.add(client);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  let closing: Promise<void> | null = null;

  function close(): Promise<void> {
    if (closing !== null) return closing;
    closing = (async () => {
      for (const client of [...clients]) {
        cleanupClient(client);
        try {
          client.res.end();
        } catch {
          // The client may already have disconnected.
        }
      }
      await new Promise<void>((resolveClose) => {
        httpServer.close(() => resolveClose());
        httpServer.closeIdleConnections();
      });
      seqReader.close();
      store.close();
    })();
    return closing;
  }

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      httpServer.once("error", rejectListen);
      httpServer.listen(opts.port, LOOPBACK, () => {
        httpServer.off("error", rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    seqReader.close();
    store.close();
    throw error;
  }

  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    await close();
    throw new Error("UI server did not bind to a TCP port");
  }
  const port = address.port;
  const url = `http://${LOOPBACK}:${port}/`;

  if (opts.openBrowser) openInBrowser(url);

  return { url, port, close };
}
