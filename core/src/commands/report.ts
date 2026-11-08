/**
 * `evener report`, `evener apply`, `evener export` (spec §9, §11).
 *
 * Registered together because the three commands share report-file and
 * time-window handling.
 */

import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ApplyError, applySuggestion } from "../apply.js";
import {
  defaultPolicy,
  defaultPricing,
  loadEffectivePolicy,
  loadPricing,
} from "../config.js";
import { exportJsonl, exportOtel } from "../export.js";
import { buildReport, renderMarkdown, REPORT_DIMENSIONS } from "../report.js";
import type { ReportBy } from "../report.js";
import type { Pricing } from "../types.js";
import { ensureDir } from "../util.js";
import { CommandError } from "./types.js";
import type { CliSink, CommandContext, CommandRegistry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function writeText(sink: CliSink, text: string): void {
  if (typeof sink === "function") sink(text);
  else sink.write(text);
}

/** `14d`, `6h`, `30m`, an ISO timestamp, or `YYYY-MM-DD`. */
export function parseSince(value: string | undefined, now: Date): Date {
  if (value === undefined || value.length === 0) {
    return new Date(now.getTime() - 14 * DAY_MS);
  }
  const relative = /^(\d+)([dhm])$/.exec(value);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const multiplier = unit === "d" ? DAY_MS : unit === "h" ? HOUR_MS : MINUTE_MS;
    return new Date(now.getTime() - amount * multiplier);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new CommandError(
      "invalid_arguments",
      `--since must be a duration like 14d, an ISO timestamp, or YYYY-MM-DD (got "${value}")`,
    );
  }
  return new Date(parsed);
}

function loadReportPricing(ctx: CommandContext): Pricing {
  if (!existsSync(ctx.pricingPath)) return defaultPricing();
  return loadPricing(ctx.pricingPath);
}

function loadReportPolicy(ctx: CommandContext) {
  if (!existsSync(ctx.policyPath)) return defaultPolicy();
  return loadEffectivePolicy(ctx.home).policy;
}

function latestReportFile(home: string): string {
  const reportsDir = join(home, "reports");
  let names: string[];
  try {
    names = readdirSync(reportsDir).filter((name) => name.endsWith(".json"));
  } catch {
    throw new CommandError(
      "report_not_found",
      `no saved reports in ${reportsDir}; run evener report first`,
    );
  }
  if (names.length === 0) {
    throw new CommandError(
      "report_not_found",
      `no saved reports in ${reportsDir}; run evener report first`,
    );
  }

  const ranked = names
    .map((name) => {
      const file = join(reportsDir, name);
      let mtime = 0;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { file, name, mtime };
    })
    .sort((left, right) => {
      if (right.mtime !== left.mtime) return right.mtime - left.mtime;
      return right.name.localeCompare(left.name);
    });
  const best = ranked[0];
  if (best === undefined) {
    throw new CommandError("report_not_found", `no saved reports in ${reportsDir}`);
  }
  return best.file;
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

async function cmdReport(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      since: { type: "string" },
      by: { type: "string" },
      format: { type: "string" },
      out: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  const format = values["format"] ?? ctx.format ?? "json";
  if (format !== "json" && format !== "md") {
    throw new CommandError(
      "invalid_arguments",
      `report --format must be json or md (got "${format}")`,
    );
  }
  const byValue = values["by"] ?? "label";
  if (
    typeof byValue !== "string" ||
    !(REPORT_DIMENSIONS as readonly string[]).includes(byValue)
  ) {
    throw new CommandError(
      "invalid_arguments",
      `report --by must be one of: ${REPORT_DIMENSIONS.join(", ")}`,
    );
  }
  const by = byValue as ReportBy;

  const now = new Date();
  const since = parseSince(values["since"], now);
  const policy = loadReportPolicy(ctx);
  const pricing = loadReportPricing(ctx);
  const report = buildReport(ctx.store(), policy, pricing, {
    since,
    now,
    by,
  });

  const reportsDir = join(ctx.home, "reports");
  ensureDir(reportsDir);
  const savedTo = join(reportsDir, `${now.toISOString()}.json`);
  report.header.saved_to = savedTo;
  const jsonText = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(savedTo, jsonText, "utf8");

  if (values["out"] !== undefined) {
    const outPath = resolve(values["out"]);
    ensureDir(dirname(outPath));
    writeFileSync(outPath, format === "md" ? renderMarkdown(report) : jsonText, "utf8");
  }

  if (format === "md") {
    writeText(ctx.io.stdout, renderMarkdown(report));
    return undefined;
  }
  return report;
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

async function cmdApply(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      arm: { type: "string" },
      report: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  const raw = positionals[0];
  if (raw === undefined) {
    throw new CommandError("invalid_arguments", "apply requires a suggestion number");
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new CommandError("invalid_arguments", `invalid suggestion number "${raw}"`);
  }

  const reportFile =
    values["report"] !== undefined ? values["report"] : latestReportFile(ctx.home);
  try {
    return applySuggestion(ctx.home, reportFile, n, values["arm"]);
  } catch (err) {
    if (err instanceof ApplyError) {
      throw new CommandError(err.code, err.message);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

async function cmdExport(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      format: { type: "string" },
      since: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  const format = values["format"] ?? ctx.format ?? "jsonl";
  if (format !== "jsonl" && format !== "otel") {
    throw new CommandError(
      "invalid_arguments",
      `export --format must be jsonl or otel (got "${format}")`,
    );
  }

  const since =
    values["since"] !== undefined ? parseSince(values["since"], new Date()) : undefined;
  const store = ctx.store();

  if (format === "jsonl") {
    writeText(ctx.io.stdout, exportJsonl(store, since));
    return undefined;
  }
  writeText(ctx.io.stdout, `${JSON.stringify(exportOtel(store, since), null, 2)}\n`);
  return undefined;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(commands: CommandRegistry): void {
  commands["report"] = cmdReport;
  commands["apply"] = cmdApply;
  commands["export"] = cmdExport;
}
