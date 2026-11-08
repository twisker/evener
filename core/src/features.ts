/**
 * Cheap pre-dispatch features and repository identity.
 *
 * Git commands are best-effort: outside a repository (or when git is missing)
 * they return null instead of throwing.
 */

import { execFileSync } from "node:child_process";
import { sha256 } from "./util.js";
import { TIME_BUCKET_HEURISTIC_KEYS } from "./types.js";
import type {
  Language,
  PreFeatures,
  TimeBucket,
  TimeBucketHeuristic,
} from "./types.js";

const GIT_TIMEOUT_MS = 2000;

/** Path-like tokens in prose, e.g. `src/store.ts` or `README.md`. */
const PATH_TOKEN = /[\w./-]+\.[a-z]{1,6}/gi;

/** Extension (lower-case, without the dot) to language table. */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, Language>> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  py: "py",
  go: "go",
  rs: "rs",
  java: "java",
  kt: "kt",
  kts: "kt",
  rb: "rb",
  php: "php",
  cs: "cs",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  c: "c",
  h: "c",
  swift: "swift",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  sql: "sql",
  md: "md",
  markdown: "md",
  mdx: "md",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  jsonc: "json",
};

/** Default heuristic thresholds; the policy template carries the same values. */
export const DEFAULT_TIME_BUCKET_HEURISTIC: TimeBucketHeuristic = {
  lt15m: { max_files: 1, max_chars: 400 },
  "15m_1h": { max_files: 3, max_chars: 1500 },
  "1h_4h": { max_files: 8, max_chars: 5000 },
};

/**
 * Case-insensitive signals that the description includes reproduction material
 * (a failing test, stack trace, explicit steps, or a pasted error block).
 */
export const HAS_REPRO_PATTERNS: readonly RegExp[] = [
  /reproduc/i,
  /repro/i,
  /failing test/i,
  /stack trace/i,
  /traceback/i,
  /steps to/i,
  /expected .* (?:but|got|actual)/i,
  /复现/,
  /报错/,
  /堆栈/,
  /```[\s\S]*?(?:error|exception)[\s\S]*?```/i,
];

/** Alias used by callers that prefer the shorter name. */
export const REPRO_PATTERNS = HAS_REPRO_PATTERNS;

function gitOutput(args: string[], cwd: string): string | null {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return String(output).trim();
  } catch {
    return null;
  }
}

/** Map a path to a language by its extension; unknown/extensionless = other. */
export function languageForPath(path: string): Language {
  const clean = path.trim().replace(/[?#].*$/, "");
  const base = clean.split(/[\\/]/).pop() ?? clean;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "other";
  const extension = base.slice(dot + 1).toLowerCase();
  return LANGUAGE_BY_EXTENSION[extension] ?? "other";
}

/**
 * Most frequent language among the explicit files and path-like tokens in the
 * description. Ties keep the language seen first. Returns null when there are
 * no candidate paths at all.
 */
export function detectLanguage(description: string, files: readonly string[]): Language | null {
  const pathTokens = description.match(PATH_TOKEN) ?? [];
  const candidates = [...files, ...new Set(pathTokens)];
  if (candidates.length === 0) return null;

  const counts = new Map<Language, number>();
  let best: Language | null = null;
  let bestCount = 0;
  for (const candidate of candidates) {
    const language = languageForPath(candidate);
    const count = (counts.get(language) ?? 0) + 1;
    counts.set(language, count);
    if (count > bestCount) {
      best = language;
      bestCount = count;
    }
  }
  return best;
}

/** True when the description contains any reproduction signal. */
export function hasRepro(description: string): boolean {
  return HAS_REPRO_PATTERNS.some((pattern) => pattern.test(description));
}

/**
 * Walk the bounded buckets in order and return the first whose file and
 * character limits both hold; anything larger is `gt4h`.
 */
export function timeBucketHeuristic(
  pre: Pick<PreFeatures, "files_mentioned" | "description_chars">,
  thresholds: TimeBucketHeuristic,
): TimeBucket {
  for (const bucket of TIME_BUCKET_HEURISTIC_KEYS) {
    const threshold = thresholds[bucket];
    if (
      pre.files_mentioned <= threshold.max_files &&
      pre.description_chars <= threshold.max_chars
    ) {
      return bucket;
    }
  }
  return "gt4h";
}

/**
 * Compute the no-cost features recorded on `task.created`.
 *
 * `files_mentioned` is the number of explicit `--files` entries plus the number
 * of distinct path-like tokens found in the description. `cross_file` follows
 * directly from it; `time_bucket` uses the policy heuristic when supplied.
 */
export function computePreFeatures(
  description: string,
  files: string[],
  cwd?: string,
  thresholds: TimeBucketHeuristic = DEFAULT_TIME_BUCKET_HEURISTIC,
): PreFeatures {
  const pathTokens = description.match(PATH_TOKEN) ?? [];
  const distinctTokens = new Set(pathTokens);

  const workdir = cwd ?? process.cwd();
  const listed = gitOutput(["ls-files"], workdir);
  const repoFiles =
    listed === null ? null : listed.length === 0 ? 0 : listed.split(/\r?\n/).filter(Boolean).length;

  const descriptionChars = description.length;
  const filesMentioned = files.length + distinctTokens.size;

  return {
    description_chars: descriptionChars,
    files_mentioned: filesMentioned,
    repo_files: repoFiles,
    language: detectLanguage(description, files),
    has_repro: hasRepro(description),
    cross_file: filesMentioned >= 2,
    time_bucket: timeBucketHeuristic(
      { description_chars: descriptionChars, files_mentioned: filesMentioned },
      thresholds,
    ),
  };
}

/**
 * Stable identity for a repository: sha256 of the origin URL concatenated with
 * the absolute repository root. Returns null outside a git work tree.
 *
 * A repository without an `origin` remote still gets a fingerprint based on its
 * root path alone.
 */
export function repoFingerprint(cwd?: string): string | null {
  const workdir = cwd ?? process.cwd();
  const root = gitOutput(["rev-parse", "--show-toplevel"], workdir);
  if (root === null) return null;
  const remote = gitOutput(["remote", "get-url", "origin"], workdir) ?? "";
  return sha256(`${remote}${root}`);
}

/**
 * The configured `origin` URL, used to match `privacy.never_delegate_repos`
 * substrings. Returns null outside a repository or when there is no origin.
 */
export function repoRemoteUrl(cwd?: string): string | null {
  return gitOutput(["remote", "get-url", "origin"], cwd ?? process.cwd());
}
