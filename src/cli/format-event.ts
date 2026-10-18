import pc from "picocolors";
import { parseStdoutLine } from "../ui-parser.js";

/** Prints one Prime stdout line using the run-log mapping of src/ui-parser.ts (INTERFACES.md §12). */
export function printPrimeStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;
  const entries = parseStdoutLine(line, "");
  if (entries.length === 0 && debug) console.log(pc.gray(line));
  for (const e of entries) {
    if (e.kind === "init") console.log(pc.blue(`Prime session ${e.sessionId}`));
    else if (e.kind === "system") console.log(pc.blue(e.text));
    else if (e.kind === "user") console.log(pc.cyan(`user: ${e.text}`));
    else if (e.kind === "thinking") console.log(pc.gray(`thinking: ${e.text}`));
    else if (e.kind === "assistant") console.log(pc.green(`assistant: ${e.text}`));
    else if (e.kind === "tool_call") {
      console.log(pc.yellow(`tool_call: ${e.name}`));
      console.log(pc.gray(JSON.stringify(e.input, null, 2)));
    } else if (e.kind === "tool_result") console.log((e.isError ? pc.red : pc.gray)(`tool_result ${e.toolName}: ${e.content.trimEnd()}`));
    else if (e.kind === "stderr") console.log(pc.red(`error: ${e.text}`));
    else if (e.kind === "result") {
      const usage = `input ${e.inputTokens}, output ${e.outputTokens}, cached ${e.cachedTokens} tokens`;
      console.log((e.isError ? pc.red : pc.blue)(`${e.text}: ${usage}`));
    } else console.log(e.text);
  }
}
