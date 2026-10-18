import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decidePrimeResume, primeSessionCodec, readPrimeSessionHeader } from "../src/server/session.js";
import type { PrimeSessionParams } from "../src/types.js";

const params: PrimeSessionParams = {
  sessionId: "01a14c2a-5965-7269-8920-97d0da73b791",
  sessionFile: "/agents/a1/prime-agent-home/sessions/01a14c2a-5965-7269-8920-97d0da73b791.jsonl",
  cwd: "/work/project",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  agentDir: "/agents/a1/prime-agent-home",
};
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function scratchFile(content: string | null): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wp4-session-"));
  dirs.push(dir);
  const file = path.join(dir, "s.jsonl");
  if (content !== null) await fs.writeFile(file, content);
  return file;
}

describe("session codec (INTERFACES §7)", () => {
  it("deserialize returns exactly the six fields and drops host metadata and unknown keys", () => {
    const raw = { ...params, paperclipAiCredentialIdentity: "c", __paperclipConfiguredModel: "m", __paperclipConfigFingerprintV2: "f", __paperclipConfigCategories: ["model"], session_id: "legacy", workdir: "/legacy" };
    expect(primeSessionCodec.deserialize(raw)).toEqual(params);
  });
  it("deserialize treats only-host-metadata, non-objects and incomplete params as a fresh session", () => {
    for (const raw of [{ paperclipAiCredentialIdentity: "c", __paperclipConfigFingerprint: "x" }, null, "01a14c2a", [params], { session_id: "s", cwd: "/w" }]) {
      expect(primeSessionCodec.deserialize(raw)).toBeNull();
    }
    for (const key of Object.keys(params)) {
      for (const bad of [undefined, "  ", 7]) expect(primeSessionCodec.deserialize({ ...params, [key]: bad })).toBeNull();
    }
  });
  it("serialize validates the same way and getDisplayId returns the session id", () => {
    expect(primeSessionCodec.serialize({ ...params, __paperclipConfiguredModel: "x" })).toEqual(params);
    expect(primeSessionCodec.serialize({ ...params, agentDir: "" })).toBeNull();
    expect(primeSessionCodec.serialize(null)).toBeNull();
    expect(primeSessionCodec.getDisplayId?.({ ...params })).toBe(params.sessionId);
    expect(primeSessionCodec.getDisplayId?.({ cwd: "/work/project" })).toBeNull();
    expect(primeSessionCodec.getDisplayId?.(null)).toBeNull();
  });
});
