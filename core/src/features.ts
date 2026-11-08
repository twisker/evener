/**
 * Cheap pre-dispatch features and repository identity.
 *
 * Git commands are best-effort: outside a repository (or when git is missing)
 * they return null instead of throwing.
 */

import { execFileSync } from "node:child_process";
import { sha256 } from "./util.js";
import type { PreFeatures } from "./types.js";

const GIT_TIMEOUT_MS = 2000;

/** Path-like tokens in prose, e.g. `src/store.ts` or `README.md`. */
const PATH_TOKEN = /[\w./-]+\.[a-z]{1,6}/g;

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

/**
 * Compute the no-cost features recorded on `task.created`.
 *
 * `files_mentioned` is the number of explicit `--files` entries plus the number
 * of distinct path-like tokens found in the description.
 */
export function computePreFeatures(
  description: string,
  files: string[],
  cwd?: string,
): PreFeatures {
  const pathTokens = description.match(PATH_TOKEN) ?? [];
  const distinctTokens = new Set(pathTokens);

  const workdir = cwd ?? process.cwd();
  const listed = gitOutput(["ls-files"], workdir);
  const repoFiles =
    listed === null ? null : listed.length === 0 ? 0 : listed.split(/\r?\n/).filter(Boolean).length;

  return {
    description_chars: description.length,
    files_mentioned: files.length + distinctTokens.size,
    repo_files: repoFiles,
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
