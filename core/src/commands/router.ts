import type { CommandRegistry } from "./types.js";

/** Implemented by a later task; registered now so cli.ts stays conflict-free. */
export function register(commands: CommandRegistry): void {}
