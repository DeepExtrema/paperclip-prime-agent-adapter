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


describe("session header (INTERFACES §7)", () => {
  it("reads id and cwd from the first non-empty line when it is a session event", async () => {
    const run2Header = '{"type":"session","version":3,"id":"01a14c2a-5965-7269-8920-97d0da73b791","timestamp":"2026-10-17T23:20:06.245Z","cwd":"/tmp/prime-local-check-we2ejug3/ws","rlmDepth":0}';
    await expect(readPrimeSessionHeader(await scratchFile(`\n${run2Header}\n{"type":"message"}\n`))).resolves.toEqual({
      id: "01a14c2a-5965-7269-8920-97d0da73b791",
      cwd: "/tmp/prime-local-check-we2ejug3/ws",
    });
    await expect(readPrimeSessionHeader(await scratchFile('{"type":"session","id":"s-1"}\n'))).resolves.toEqual({ id: "s-1", cwd: null });
  });
  it("returns null for a missing file, a directory, bad JSON, an empty file, a non-session first line or a missing id", async () => {
    const missing = await scratchFile(null);
    await expect(readPrimeSessionHeader(missing)).resolves.toBeNull();
    await expect(readPrimeSessionHeader(path.dirname(missing))).resolves.toBeNull();
    for (const content of ["{not json\n", "", "\n\n", '{"type":"message","id":"s-1"}\n', '{"type":"session","id":""}\n', "[1,2]\n"]) {
      await expect(readPrimeSessionHeader(await scratchFile(content))).resolves.toBeNull();
    }
  });
});


describe("resume decision (INTERFACES §7)", () => {
  const current = { cwd: params.cwd, provider: params.provider, model: params.model, agentDir: params.agentDir };
  const header = { id: params.sessionId, cwd: params.cwd };
  const decide = (input: Partial<Parameters<typeof decidePrimeResume>[0]>) => decidePrimeResume({ saved: params, current, header, ...input });
  it("resumes when cwd, provider, model, agent dir and header all match", () => {
    expect(decide({})).toEqual({ resume: true, sessionFile: params.sessionFile });
    expect(decide({ current: { ...current, cwd: "/work/project/" }, header: { ...header, cwd: null } })).toEqual({ resume: true, sessionFile: params.sessionFile });
  });
  it("returns the first failing reason in the contract order", () => {
    expect(decide({ saved: null, current: { ...current, cwd: "/elsewhere" } })).toEqual({ resume: false, reason: "no_saved_session" });
    expect(decide({ current: { ...current, cwd: "/elsewhere", model: "claude-opus-5" } })).toEqual({ resume: false, reason: "cwd_mismatch" });
    expect(decide({ current: { ...current, provider: "openai-codex", agentDir: "/other" } })).toEqual({ resume: false, reason: "model_mismatch" });
    expect(decide({ current: { ...current, model: "claude-opus-5" } })).toEqual({ resume: false, reason: "model_mismatch" });
    expect(decide({ current: { ...current, agentDir: "/agents/a2/prime-agent-home" }, header: null })).toEqual({ resume: false, reason: "agent_dir_mismatch" });
    expect(decide({ header: null })).toEqual({ resume: false, reason: "session_file_missing" });
    expect(decide({ header: { ...header, id: "other-session" } })).toEqual({ resume: false, reason: "session_header_mismatch" });
    expect(decide({ header: { ...header, cwd: "/elsewhere" } })).toEqual({ resume: false, reason: "session_header_mismatch" });
  });
});
