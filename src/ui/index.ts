// Owner: WP6. Contract: INTERFACES.md §12.
import type { CreateConfigValues, TranscriptEntry } from "@paperclipai/adapter-utils";
import { notImplemented } from "../errors.js";

export function parsePrimeStdoutLine(_line: string, _ts: string): TranscriptEntry[] {
  return notImplemented("WP6", "parsePrimeStdoutLine");
}

export function buildPrimeLocalConfig(_values: CreateConfigValues): Record<string, unknown> {
  return notImplemented("WP6", "buildPrimeLocalConfig");
}
