import { describe, expect, it } from "vitest";
import { createServerAdapter } from "../src/index.js";
import { getPrimeConfigSchema } from "../src/server/config-schema.js";
import { PRIME_THINKING_LEVELS } from "../src/types.js";

const field = (key: string) => getPrimeConfigSchema().fields.find((f) => f.key === key);

describe("getPrimeConfigSchema", () => {
  it("lists the six Prime fields in order with their input types", () => {
    expect(getPrimeConfigSchema().fields.map((f) => [f.key, f.type])).toEqual([
      ["credentialMode", "select"], ["apiKeyEnvVar", "text"], ["thinking", "select"],
      ["appendSystemPrompt", "textarea"], ["noContextFiles", "toggle"], ["agentDirRoot", "text"],
    ]);
  });
  it("defaults credentialMode to host_auth and shows apiKeyEnvVar only for api_key", () => {
    expect(field("credentialMode")?.default).toBe("host_auth");
    expect(field("credentialMode")?.options?.map((o) => o.value)).toEqual(["host_auth", "api_key"]);
    expect(field("apiKeyEnvVar")?.meta).toEqual({ visibleWhen: { key: "credentialMode", values: ["api_key"] } });
  });
  it("offers Prime's default (empty) first, then every thinking level", () => {
    expect(field("thinking")?.default).toBe("");
    expect(field("thinking")?.options?.map((o) => o.value)).toEqual(["", ...PRIME_THINKING_LEVELS]);
    expect(field("noContextFiles")?.default).toBe(false);
  });
  it("is what the server adapter returns", async () => {
    expect(await createServerAdapter().getConfigSchema?.()).toEqual(getPrimeConfigSchema());
  });
});
