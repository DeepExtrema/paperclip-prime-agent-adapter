// Owner: WP5. Contract: INTERFACES.md §10. Replace the stub body; keep the export.
import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { notImplemented } from "../errors.js";

export async function testEnvironment(_ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  return notImplemented("WP5", "testEnvironment");
}
