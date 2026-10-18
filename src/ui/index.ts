// Owner: WP6. Contract: INTERFACES.md §12.
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { notImplemented } from "../errors.js";

export { parsePrimeStdoutLine } from "./parse-stdout.js";

export function buildPrimeLocalConfig(_values: CreateConfigValues): Record<string, unknown> {
  return notImplemented("WP6", "buildPrimeLocalConfig");
}
