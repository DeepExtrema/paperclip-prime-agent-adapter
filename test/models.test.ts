import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrimeCliError } from "../src/errors.js";
import { buildPrimeChildEnv, createEphemeralPrimeAgentDir, seedPrimeAgentDir } from "../src/server/runtime-config.js";
import * as models from "../src/server/models.js";
import type { PrimeAgentDirPlan } from "../src/types.js";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return { ...actual, runChildProcess: vi.fn(actual.runChildProcess) };
});
vi.mock("../src/server/runtime-config.js", () => ({ resolvePrimeRuntimeConfig: vi.fn(), seedPrimeAgentDir: vi.fn(), createEphemeralPrimeAgentDir: vi.fn(), buildPrimeChildEnv: vi.fn() }));

const fixturePath = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const fixture = (name: string) => readFileSync(fixturePath(name), "utf8");
const scratch: string[] = [];
async function makeScratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wp4-models-"));
  scratch.push(dir);
  return dir;
}
/** Writes an executable /bin/sh script `<dir>/<name>` and returns its absolute path. */
async function fakeCommand(dir: string, name: string, body: string): Promise<string> {
  await fs.writeFile(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path.join(dir, name);
}
afterEach(async () => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(scratch.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("model list parsing (INTERFACES §8)", () => {
  it("parses the host-auth table into 275 rows in output order", () => {
    const rows = models.parsePrimeModelList(fixture("model-list.txt"));
    expect(rows).toHaveLength(275);
    expect(rows[0]).toEqual({ provider: "anthropic", model: "claude-fable-5", id: "anthropic/claude-fable-5", context: "1M", maxOut: "128K", thinking: true, images: true });
    expect(rows.at(-1)).toEqual({ provider: "vercel-ai-gateway", model: "zai/glm-5v-turbo", id: "vercel-ai-gateway/zai/glm-5v-turbo", context: "200K", maxOut: "128K", thinking: true, images: true });
    expect(rows.find((row) => row.id === "vercel-ai-gateway/zai/glm-5.3")).toMatchObject({ thinking: true, images: false });
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.provider] = (counts[row.provider] ?? 0) + 1;
    expect(counts).toEqual({ anthropic: 16, "openai-codex": 17, "vercel-ai-gateway": 242 });
  });
  it("handles the narrower api-key table and the no-models message", () => {
    const rows = models.parsePrimeModelList(fixture("model-list-api-key-anthropic.txt"));
    expect(rows).toHaveLength(16);
    expect(rows.every((row) => row.provider === "anthropic")).toBe(true);
    expect(rows[2]?.id).toBe("anthropic/claude-haiku-4-5");
    expect(models.parsePrimeModelList(fixture("model-list-no-auth.txt"))).toEqual([]);
    expect(models.parsePrimeModelList("")).toEqual([]);
  });
});
