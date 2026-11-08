/**
 * JSONL child-process driver shared by the dispatch adapters.
 *
 * The child receives `stdinText` and EOF; every complete stdout line is handed
 * to `onLine` either as parsed JSON or, when the line is not valid JSON, as
 * `(null, raw)`. Stderr is captured up to 1 MiB. A timeout sends SIGTERM and
 * then SIGKILL five seconds later.
 */

import { spawn } from "node:child_process";

/** 1 MiB of captured stderr, per spec. */
export const STDERR_CAP_BYTES = 1024 * 1024;

/** Grace period between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 5_000;

/** Extra wait after SIGKILL before giving up on a close event. */
const POST_KILL_GIVE_UP_MS = 1_000;

export interface RunJsonlProcessOptions {
  argv: string[];
  cwd: string;
  stdinText: string;
  timeoutMs: number;
  env: Readonly<Record<string, string | undefined>>;
  onLine: (obj: unknown, raw: string) => void;
  /** Injectable for tests; defaults to `node:child_process.spawn`. */
  spawnImpl?: typeof spawn;
}

export interface JsonlProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
  wallMs: number;
}

function parseLine(onLine: RunJsonlProcessOptions["onLine"], raw: string): void {
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  if (line.length === 0) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    onLine(null, raw);
    return;
  }
  onLine(parsed, raw);
}

/**
 * Run a command that emits JSONL on stdout.
 *
 * Resolves when the child closes (or when the timeout kill sequence has run its
 * course). `wallMs` covers only the spawn, not caller-side setup/teardown.
 */
export function runJsonlProcess(opts: RunJsonlProcessOptions): Promise<JsonlProcessResult> {
  const [file, ...args] = opts.argv;
  if (file === undefined) {
    return Promise.reject(new Error("runJsonlProcess: argv must not be empty"));
  }

  const spawnImpl = opts.spawnImpl ?? spawn;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdoutBuffer = "";
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let giveUpTimer: NodeJS.Timeout | undefined;

    const child = spawnImpl(file, args, {
      cwd: opts.cwd,
      env: { ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const appendStderr = (chunk: Buffer | string): void => {
      if (stderrBytes >= STDERR_CAP_BYTES) return;
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const remaining = STDERR_CAP_BYTES - stderrBytes;
      const slice = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
      stderrChunks.push(slice);
      stderrBytes += slice.length;
    };

    const flushStdout = (): void => {
      if (stdoutBuffer.length === 0) return;
      const raw = stdoutBuffer;
      stdoutBuffer = "";
      parseLine(opts.onLine, raw);
    };

    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (giveUpTimer !== undefined) clearTimeout(giveUpTimer);
      flushStdout();
      resolve({
        exitCode,
        timedOut,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        wallMs: Date.now() - startedAt,
      });
    };

    const stdout = child.stdout;
    if (stdout !== null) {
      stdout.setEncoding("utf8");
      stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        let newline = stdoutBuffer.indexOf("\n");
        while (newline !== -1) {
          const raw = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          parseLine(opts.onLine, raw);
          newline = stdoutBuffer.indexOf("\n");
        }
      });
    }

    const stderr = child.stderr;
    if (stderr !== null) {
      stderr.on("data", (chunk: Buffer | string) => {
        appendStderr(chunk);
      });
    }

    child.on("error", (err: Error) => {
      appendStderr(`${err.message}\n`);
      settle(null);
    });
    child.on("close", (code: number | null) => {
      settle(code);
    });

    const stdin = child.stdin;
    if (stdin !== null) {
      stdin.on("error", () => {
        // A target that exits before reading stdin produces EPIPE; the exit
        // code and stdout are still meaningful.
      });
      stdin.end(opts.stdinText);
    }

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Fall through to the SIGKILL safety net.
      }
      if (settled) return;
      killTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // The child may already be gone.
        }
        if (settled) return;
        // A real process emits `close` after SIGKILL. A stub may not, so give
        // it a short grace period and then resolve with no exit code rather
        // than hanging forever.
        giveUpTimer = setTimeout(() => {
          settle(child.exitCode ?? null);
        }, POST_KILL_GIVE_UP_MS);
      }, KILL_GRACE_MS);
    }, opts.timeoutMs);
  });
}
