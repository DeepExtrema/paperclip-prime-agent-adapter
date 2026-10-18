// Owner: WP3. Contract: INTERFACES.md §5 and §11. Replace the stub bodies; keep the typed exports.
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { notImplemented } from "../errors.js";
import type { BuildPrimeArgs } from "../types.js";

export const buildPrimeArgs: BuildPrimeArgs = (input) => {
  const args = ["--mode", "json", "-p", "--provider", input.provider, "--model", input.model];
  if (input.thinking !== null) args.push("--thinking", input.thinking);
  args.push("--cwd", input.cwd, "--session-dir", input.sessionDir);
  if (input.resumeSessionFile !== null) args.push("-r", input.resumeSessionFile);
  for (const dir of input.skillDirs) args.push("--skill", dir);
  for (const text of input.appendSystemPrompts) {
    if (text.trim().length > 0) args.push("--append-system-prompt", text);
  }
  if (input.noContextFiles) args.push("--no-context-files");
  args.push(...input.extraArgs, "--", input.prompt);
  return args;
};

export async function execute(_ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  return notImplemented("WP3", "execute");
}
