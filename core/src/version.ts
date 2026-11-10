import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The version of the running `evener` package.
 *
 * The path is resolved relative to this module, so it works both from
 * `core/dist/src/` (published package) and from a compiled test importing
 * `../src/version.js`. The value is read once and cached for the process.
 */
let cachedVersion: string | undefined;

export function packageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;

  const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  let raw: string;
  try {
    raw = readFileSync(packageJsonPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read evener package.json at ${packageJsonPath}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot parse evener package.json at ${packageJsonPath}: ${message}`);
  }

  const version =
    typeof parsed === "object" && parsed !== null && "version" in parsed
      ? (parsed as { version?: unknown }).version
      : undefined;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`evener package.json at ${packageJsonPath} has no usable "version" field`);
  }

  cachedVersion = version;
  return version;
}
