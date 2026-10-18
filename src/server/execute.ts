// Owner: WP3. Contract: INTERFACES.md §5 and §11. Replace the stub bodies; keep the typed exports.
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { notImplemented } from "../errors.js";
import type { BuildPrimeArgs } from "../types.js";

export const buildPrimeArgs: BuildPrimeArgs = () => notImplemented("WP3", "buildPrimeArgs");

export async function execute(_ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  return notImplemented("WP3", "execute");
}
