import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { parseStdoutLine } from "../ui-parser.js";

/** Same mapping as the zero-import run-log parser (INTERFACES.md §12); one source of truth. */
export function parsePrimeStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parseStdoutLine(line, ts);
}
