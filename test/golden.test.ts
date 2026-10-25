// TAI-273 plan rev 7 §5 step 2, rule (P0 golden test): with credentialMode unchanged and featureProfile and maxSubagentsPerRun
// absent, the env, the settings.json writes and the result keys equal 1f8f816's, except for the section 7 item 9 list.
// test/fixtures/golden-1f8f816.json was recorded from a 1f8f816 build with test/golden/record.mjs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { execute } from "../src/server/execute.js";
import { goldenRuns } from "./golden/golden-runs.mjs";

type Golden = Record<string, { env: Record<string, string>; [key: string]: unknown }>;
const recorded = JSON.parse(readFileSync(new URL("./fixtures/golden-1f8f816.json", import.meta.url), "utf8")) as Golden;

describe("golden: allowedModels unset, no featureProfile (§7 item 9)", () => {
  it("matches 1f8f816 except that CLAUDE_CODE_OAUTH_TOKEN leaves the child env", async () => {
    const current = (await goldenRuns(execute as never)) as Golden;
    // §7 item 9: CLAUDE_CODE_OAUTH_TOKEN is removed from the child env in every mode. Nothing else may differ.
    const expected = Object.fromEntries(Object.entries(recorded).map(([name, run]) => {
      const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...env } = run.env;
      return [name, { ...run, env }];
    }));
    expect(current).toEqual(expected);
    for (const run of Object.values(current)) {
      expect(run.env).toHaveProperty("ANTHROPIC_BASE_URL"); // only governed-v1 strips ANTHROPIC_* in api_key mode
      expect(run.env).not.toHaveProperty("DO_NOT_TRACK");
    }
  }, 60_000);
});
