// TAI-273 plan rev 13 §2.2 (G6): featureProfile "governed-v1", items 1-13 and the model-audit fix; TAI-324 round 1 (F1-F3, T1-T5).
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "../src/server/execute.js";
import { resolvePrimeFeatureProfile } from "../src/server/feature-profile.js";
import { primeCatalogCheck, primeSupportedThinkingLevels } from "../src/server/model-catalog.js";

const FAKE = fileURLToPath(new URL("./fake-prime-daemon.mjs", import.meta.url));
/** The fake's "release" dir is its own dir, so the built-ins are <test>/skills/<name> (§2.2 item 10). */
const BUILTINS = ["agent-message", "agent-observe", "attach-image", "compact", "edit", "refine"].map((name) => path.join(path.dirname(FAKE), "skills", name));
const WORKSPACE_SETTINGS = '{"skills":["!**"]}';
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const MODEL = "anthropic/claude-haiku-4-5";
const KEY = "sk-ant-api03-FIXTURE-governed-not-real";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const savedEnv = { ...process.env };
let root = "";
type Rec = { kind: string; env?: Record<string, string>; command?: Record<string, unknown> & { type: string }; activeSessionId?: string; thinking?: string | null; settings?: string | null };
const rec = () => path.join(root, "daemon.jsonl");
const records = (): Rec[] => (existsSync(rec()) ? readFileSync(rec(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Rec) : []);
const commands = () => records().filter((r) => r.kind === "command").map((r) => r.command!);
const types = () => commands().map((c) => c.type);
/** The fake's record of each prompt that reaches a model: the session and the thinking level its request carries. */
const requests = () => records().filter((r) => r.kind === "request");
const ws = () => path.join(root, "ws");
const agentDir = () => path.join(root, "agents", "agent-1", "prime-agent-home");
const disabled = (...parts: string[]) => path.join(agentDir(), ".paperclip-disabled", "run-1", ...parts);
const settings = () => JSON.parse(readFileSync(path.join(agentDir(), "settings.json"), "utf8")) as Record<string, unknown>;
const write = (file: string, content: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); };
const GOVERNED = { featureProfile: "governed-v1", credentialMode: "api_key", apiKeyEnvVar: "ANTHROPIC_API_KEY", allowedModels: [MODEL], thinking: "high" };
/** The fake's catalog entry for MODEL, as set_model answers it: modelCatalog.liveModel. */
const LIVE = { provider: "anthropic", id: "claude-haiku-4-5", baseUrl: "https://api.anthropic.com", reasoning: true };
/** Rev 11 §6: each failure of item 12's step (set_model, its answer, then get_state), with the fake's env and the reason. */
const STEP_FAILURES: Array<[string, Record<string, string>, string]> = [
  ["set_model answers success: false", { FAKE_DAEMON_SET_MODEL_FAIL: "1" }, "set_model failed: set_model refused"],
  ["set_model answers another id", { FAKE_DAEMON_SET_MODEL_ENTRY: JSON.stringify({ ...LIVE, id: "claude-opus-4-7" }) }, `set_model answered "anthropic/claude-opus-4-7", not ${MODEL}`],
  ["set_model answers another provider", { FAKE_DAEMON_SET_MODEL_ENTRY: JSON.stringify({ ...LIVE, provider: "n0probe" }) }, `set_model answered "n0probe/claude-haiku-4-5", not ${MODEL}`],
  ["set_model answers another baseUrl", { FAKE_DAEMON_SET_MODEL_ENTRY: JSON.stringify({ ...LIVE, baseUrl: "https://elsewhere.invalid" }) }, `set_model answered ${MODEL} has baseUrl "https://elsewhere.invalid", not https://api.anthropic.com`],
  ["set_model answers reasoning: false", { FAKE_DAEMON_SET_MODEL_ENTRY: JSON.stringify({ ...LIVE, reasoning: false }) }, `set_model answered ${MODEL} has no reasoning (thinking is high)`],
  ["get_state then shows another level", { FAKE_DAEMON_THINKING_STUCK: "1" }, 'thinking level is "off", configured "high"'],
];
type Over = { config?: Record<string, unknown>; env?: Record<string, string>; sessionParams?: Record<string, unknown> | null; runId?: string; agentId?: string };
async function run(over: Over = {}) {
  const logs: string[] = [];
  const notes: string[] = [];
  const ctx: AdapterExecutionContext = {
    runId: over.runId ?? "run-1",
    agent: { id: over.agentId ?? "agent-1", companyId: "company-1", name: "Prime Tester", adapterType: "prime_agent_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: over.sessionParams ?? null, sessionDisplayId: null, taskKey: null },
    config: {
      runtime: "daemon", command: FAKE, model: MODEL, agentDirRoot: path.join(root, "agents"), paperclipRuntimeSkills: [], ...GOVERNED,
      env: { FAKE_DAEMON_RECORD: rec(), FAKE_DAEMON_EVENTS_FILE: fixture("prime-jsonl/run2.jsonl"), FAKE_PRIME_MODEL_LIST: fixture("model-list.txt"),
        ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: "http://127.0.0.1:9/elsewhere", ...over.env },
      ...over.config,
    },
    context: { paperclipWorkspace: { cwd: ws(), source: "project_primary" }, taskId: "task-1" },
    authToken: "run-jwt-token",
    onLog: async (_stream, chunk) => void logs.push(chunk),
    onMeta: async (meta) => void notes.push(...(meta.commandNotes ?? [])),
  };
  const result = await execute(ctx);
  return { result, logs, notes, log: logs.join(""), report: (result.resultJson as { featureProfile?: Record<string, any> } | undefined)?.featureProfile! };
}
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "prime-g6-"));
  for (const dir of ["home", "ws", "agents"]) mkdirSync(path.join(root, dir));
  process.env.HOME = path.join(root, "home");
  process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});

describe("governed-v1 config (§2.2)", () => {
  const input = { runtime: "daemon" as const, credentialMode: "api_key", allowedModels: [MODEL], rlmMaxDepth: null, thinking: "high" as string | null };
  it("is closed: one value, its four rules and maxSubagentsPerRun 1-8 (default 2), rlmMaxDepth default 1", () => {
    expect(resolvePrimeFeatureProfile({}, input)).toBeNull();
    expect(resolvePrimeFeatureProfile({ featureProfile: "governed-v1" }, input)).toEqual({ profile: "governed-v1", maxSubagentsPerRun: 2, rlmMaxDepth: 1, thinking: "high" });
    expect(resolvePrimeFeatureProfile({ featureProfile: "governed-v1", maxSubagentsPerRun: "8" }, { ...input, rlmMaxDepth: 0, thinking: "off" }))
      .toEqual({ profile: "governed-v1", maxSubagentsPerRun: 8, rlmMaxDepth: 0, thinking: "off" });
    for (const [config, over] of [
      [{ maxSubagentsPerRun: 2 }, {}], [{ featureProfile: "governed-v2" }, {}], [{ featureProfile: "governed-v1" }, { allowedModels: null }],
      [{ featureProfile: "governed-v1" }, { thinking: null }],
      [{ featureProfile: "governed-v1" }, { runtime: "print" }], [{ featureProfile: "governed-v1" }, { credentialMode: "host_auth" }],
      [{ featureProfile: "governed-v1", maxSubagentsPerRun: 0 }, {}], [{ featureProfile: "governed-v1", maxSubagentsPerRun: 9 }, {}],
      [{ featureProfile: "governed-v1", maxSubagentsPerRun: 1.5 }, {}],
    ] as const) {
      expect(() => resolvePrimeFeatureProfile(config, { ...input, ...over } as typeof input)).toThrowError(expect.objectContaining({ code: "prime_feature_profile_invalid" }));
    }
  });
  it.each([
    ["no credentialMode", { credentialMode: undefined, apiKeyEnvVar: undefined }],
    ["no thinking (rev 11)", { thinking: undefined }],
  ])("fails before any file is written: %s", async (_name, config) => {
    const { result } = await run({ config });
    expect(result).toMatchObject({ errorCode: "prime_feature_profile_invalid", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    expect(existsSync(path.join(root, "agents", "agent-1"))).toBe(false);
    expect(records()).toEqual([]);
  });
});

describe("item 1: managed keys, env and depth", () => {
  it("writes the managed keys, sends depth 1, sets DO_NOT_TRACK and strips ANTHROPIC_* in api_key mode", async () => {
    const { result, report } = await run();
    expect(result).toMatchObject({ exitCode: 0, errorCode: null });
    expect(settings()).toMatchObject({
      harnessRefinements: true, autoRefine: { enabled: false }, factory: { enabled: false }, rlmMaxDepth: 1,
      retry: { provider: { waitForUsage: { enabled: false, pauseUntilReset: false } } }, agentTraces: { enabled: false }, telemetry: { enabled: false },
      allowedModels: [MODEL], skills: ["!**"], enableBuiltinSkills: false, defaultThinkingLevel: "high",
    });
    // Rev 11: settings.json holds defaultThinkingLevel = thinking before the daemon starts.
    expect(JSON.parse(records().find((r) => r.kind === "start")!.settings!)).toMatchObject({ defaultThinkingLevel: "high" });
    expect(commands().find((c) => c.type === "create")).toMatchObject({ config: { skills: BUILTINS } });
    expect(commands()).toContainEqual(expect.objectContaining({ type: "set_rlm_max_depth", maxDepth: 1 }));
    const env = records().find((r) => r.kind === "start")!.env!;
    expect([env.DO_NOT_TRACK, env.PRIME_AGENT_TELEMETRY]).toEqual(["1", "0"]);
    expect(env).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(report).toMatchObject({ profile: "governed-v1", maxSubagentsPerRun: 2, sessions: 0, sessionsEnded: [], skillDiscovery: "off", sessionSkillChecks: 0,
      settingsKeysRemoved: [], contextFilesDisabled: [], projectConfigDisabled: [], agentDirDisabled: [], foreignGoals: [],
      harnessEntriesDisabled: [], agentSkills: [], agentSkillsDisabled: [], scheduledJobsDisabled: 0, scheduledJobsCreated: 0,
      cachesCleared: [], modelCatalog: { ok: true, checks: 1, refreshesSeen: 0, liveModel: LIVE, thinkingLevel: "high", failure: null }, warnings: [] });
  });
  it("fails a run that changes a managed key with prime_settings_tampered and clears nothing else", async () => {
    const { result } = await run({ env: { FAKE_DAEMON_EDIT_SETTINGS: JSON.stringify({ autoRefine: { enabled: true } }) } });
    expect(result).toMatchObject({ errorCode: "prime_settings_tampered", resultJson: { settings: { tamperedKeys: ["autoRefine"] } } });
  });
});

describe("item 5: settings.json allowlist", () => {
  it("removes keys that are not allowed at run start and keeps display-only keys", async () => {
    write(path.join(agentDir(), "settings.json"), JSON.stringify({ theme: "dark", shellPath: "/bin/evil", chatDetail: "full" }));
    const { result, report, log } = await run();
    expect(result.errorCode).toBeNull();
    expect(settings()).toMatchObject({ theme: "dark" });
    expect(settings()).not.toHaveProperty("shellPath");
    expect(report.settingsKeysRemoved).toEqual(["shellPath", "chatDetail"]);
    expect(log).toContain("[paperclip] settings.json: removed keys that are not allowed: shellPath, chatDetail");
  });
  it("fails a run that adds a dangerous key, removes it, and only reports any other key", async () => {
    const added = await run({ env: { FAKE_DAEMON_EDIT_SETTINGS: JSON.stringify({ mcpServers: { x: {} }, treeFilterMode: "all", recentModels: [MODEL] }) } });
    expect(added.result).toMatchObject({ errorCode: "prime_settings_tampered", resultJson: { settings: { dangerousKeys: ["mcpServers"] } } });
    expect(added.result.errorMessage).toContain("mcpServers");
    expect(settings()).not.toHaveProperty("mcpServers");
    expect(settings()).not.toHaveProperty("treeFilterMode");
    expect(settings()).toHaveProperty("recentModels");
    expect(added.report.settingsKeysRemoved).toEqual(["mcpServers", "treeFilterMode"]);
    const other = await run({ runId: "run-2", env: { FAKE_DAEMON_EDIT_SETTINGS: JSON.stringify({ treeFilterMode: "all" }) } });
    expect(other.result.errorCode).toBeNull();
    expect(other.report.settingsKeysRemoved).toEqual(["treeFilterMode"]);
  });
});

describe("item 6: context files and the workspace's .prime/agent/", () => {
  it("moves agent-dir context files and the workspace config aside, with their sha256", async () => {
    for (const name of ["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"]) write(path.join(agentDir(), name), `# ${name}`);
    write(path.join(ws(), ".prime", "agent", "settings.json"), '{"packages":["x"]}');
    write(path.join(ws(), ".prime", "agent", "SYSTEM.md"), "replace");
    const { result, report } = await run();
    expect(result.errorCode).toBeNull();
    expect(report.contextFilesDisabled).toEqual(["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"].map((name) => ({ name, sha256: sha(`# ${name}`) })));
    for (const name of ["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"]) expect(readFileSync(disabled(name), "utf8")).toBe(`# ${name}`);
    expect(report.projectConfigDisabled).toEqual([
      { path: ".prime/agent/SYSTEM.md", sha256: sha("replace") }, { path: ".prime/agent/settings.json", sha256: sha('{"packages":["x"]}') },
    ]);
    // Rev 8: the dir stays; every entry but the managed settings.json moves, and a different settings.json is copied aside, then replaced.
    expect(readFileSync(path.join(ws(), ".prime", "agent", "settings.json"), "utf8")).toBe(WORKSPACE_SETTINGS);
    expect(existsSync(path.join(ws(), ".prime", "agent", "SYSTEM.md"))).toBe(false);
    expect(readFileSync(path.join(ws(), ".prime", "agent.disabled-run-1", "SYSTEM.md"), "utf8")).toBe("replace");
    expect(readFileSync(path.join(ws(), ".prime", "agent.disabled-run-1", "settings.json"), "utf8")).toBe('{"packages":["x"]}');
    expect(report.warnings).toContain("workspace settings.json had other content; replaced: .prime/agent/settings.json");
  });
  it("moves a .prime link as a link and never touches its target", async () => {
    const outside = path.join(root, "outside");
    write(path.join(outside, "agent", "SYSTEM.md"), "x");
    symlinkSync(outside, path.join(ws(), ".prime"));
    const { report } = await run();
    expect(readlinkSync(path.join(ws(), ".prime.disabled-run-1"))).toBe(outside);
    expect(readFileSync(path.join(outside, "agent", "SYSTEM.md"), "utf8")).toBe("x");
    expect(existsSync(path.join(outside, "agent", "settings.json"))).toBe(false);
    expect(readFileSync(path.join(ws(), ".prime", "agent", "settings.json"), "utf8")).toBe(WORKSPACE_SETTINGS);
    expect(report.projectConfigDisabled).toEqual([{ path: ".prime", sha256: null }]);
    expect(report.warnings).toContain("workspace .prime was a symlink; moved aside");
  });
  it("reports files the run creates, and warns on a changed workspace AGENTS.md and on every parent-dir context file", async () => {
    write(path.join(ws(), "AGENTS.md"), "v1");
    write(path.join(root, "CLAUDE.md"), "above");
    const files = { [path.join(ws(), "AGENTS.md")]: "v2", [path.join(agentDir(), "SYSTEM.md")]: "s", [path.join(ws(), ".prime", "agent", "APPEND_SYSTEM.md")]: "a" };
    const { report, log } = await run({ env: { FAKE_DAEMON_WRITE_FILES: JSON.stringify(files) } });
    expect(report.workspaceContextFiles).toMatchObject({
      [path.join(ws(), "AGENTS.md")]: { before: sha("v1"), after: sha("v2") }, [path.join(root, "CLAUDE.md")]: { before: sha("above"), after: sha("above") },
    });
    expect(report.contextFilesCreated).toEqual([{ name: "SYSTEM.md", sha256: sha("s") }]);
    expect(report.projectConfigCreated).toEqual([{ path: ".prime/agent/APPEND_SYSTEM.md", sha256: sha("a") }]);
    expect(report.warnings).toEqual(expect.arrayContaining([
      "new agent-dir context file: SYSTEM.md", "new workspace Prime config file: .prime/agent/APPEND_SYSTEM.md",
      `workspace context file changed: ${path.join(ws(), "AGENTS.md")}`, `context file above cwd is loaded on every run: ${path.join(root, "CLAUDE.md")}`,
    ]));
    expect(log).toContain(`[paperclip] warning: context file above cwd is loaded on every run: ${path.join(root, "CLAUDE.md")}`);
    const second = await run({ runId: "run-2" });
    expect(second.report.warnings).toContain(`context file above cwd is loaded on every run: ${path.join(root, "CLAUDE.md")}`);
    expect(second.report.warnings).not.toContain(`workspace context file changed: ${path.join(ws(), "AGENTS.md")}`);
  });
});

describe("item 4: saved Prime schedules", () => {
  it("renames every scheduled-jobs.json and counts new ones", async () => {
    const jobs = path.join(agentDir(), "session-artifacts", "s1", "scheduled-jobs.json");
    write(jobs, "[]");
    const created = path.join(agentDir(), "session-artifacts", "s2", "scheduled-jobs.json");
    const { report } = await run({ env: { FAKE_DAEMON_WRITE_FILES: JSON.stringify({ [created]: "[]" }) } });
    expect(report).toMatchObject({ scheduledJobsDisabled: 1, scheduledJobsCreated: 1 });
    expect([existsSync(jobs), existsSync(`${jobs}.disabled-run-1`)]).toEqual([false, true]);
  });
});

describe("item 8: global harness keeps only memory; refine stores move", () => {
  it("strips non-memory kernel entries, reports them, and moves both refine stores", async () => {
    const store = { schema: 2, refinements: [{ id: "r1" }], entries: { prompt: { p1: { content: "obey" } }, memory: { m1: { content: "fact" } }, skill: { s1: {} }, subagent: {}, factory: {} } };
    write(path.join(agentDir(), "harness", "harness_state.json"), JSON.stringify(store));
    write(path.join(agentDir(), "harness_state.json"), "{}");
    write(path.join(agentDir(), "sessions", "harness", "harness_state.json"), "{}");
    write(path.join(agentDir(), "refinement_history.jsonl"), '{"a":1}\n{"a":2}\n');
    const added = { ...store, entries: { ...store.entries, prompt: { p2: {} } } };
    const { report, result } = await run({ env: { FAKE_DAEMON_WRITE_FILES: JSON.stringify({ [path.join(agentDir(), "harness", "harness_state.json")]: JSON.stringify(added) }) } });
    expect(result.errorCode).toBeNull();
    expect(report.harnessEntriesDisabled).toEqual([{ kind: "prompt", id: "p1" }, { kind: "skill", id: "s1" }]);
    expect(JSON.parse(readFileSync(disabled("harness", "harness_state.json"), "utf8"))).toEqual(store);
    expect(report.agentDirDisabled).toEqual([
      { name: "harness_state.json", kind: "file", sha256: sha("{}") }, { name: path.join("sessions", "harness"), kind: "dir", sha256: null },
    ]);
    expect(existsSync(disabled("sessions", "harness", "harness_state.json"))).toBe(true);
    expect(report.refinementEvents).toEqual({ before: 2, after: 2 });
    expect(report.harnessFingerprint.before).not.toBeNull();
    expect(report.harnessFingerprint.after).not.toBe(report.harnessFingerprint.before);
    expect(report.harnessBytes).toBeGreaterThan(0);
    expect(report.warnings).toEqual(expect.arrayContaining(["new global harness prompt entries: 1", "agent-dir refine store moved aside: harness_state.json"]));
  });
  it("leaves a memory-only store byte-identical", async () => {
    const text = JSON.stringify({ schema: 2, refinements: [], entries: { prompt: {}, memory: { m1: { content: "fact" } }, skill: {} } });
    write(path.join(agentDir(), "harness", "harness_state.json"), text);
    const { report } = await run();
    expect(report.harnessEntriesDisabled).toEqual([]);
    expect(readFileSync(path.join(agentDir(), "harness", "harness_state.json"), "utf8")).toBe(text);
    expect(report.harnessFingerprint).toEqual({ before: sha(text), after: sha(text) });
  });
});

describe("item 9: agent-installed skills", () => {
  it("moves every entry under <agentDir>/skills/, files too, and reports new ones", async () => {
    write(path.join(agentDir(), "skills", "foo", "SKILL.md"), "---\nname: foo\n---\n");
    write(path.join(agentDir(), "skills", "x.md"), "loose");
    const created = path.join(agentDir(), "skills", "bar", "SKILL.md");
    const { report } = await run({ env: { FAKE_DAEMON_WRITE_FILES: JSON.stringify({ [created]: "---\nname: bar\n---\n" }) } });
    expect(report.agentSkillsDisabled).toEqual([{ name: "foo", sha256: sha("---\nname: foo\n---\n") }, { name: "x.md", sha256: sha("loose") }]);
    expect([existsSync(disabled("skills", "foo", "SKILL.md")), existsSync(disabled("skills", "x.md"))]).toEqual([true, true]);
    expect(report.agentSkills).toEqual(["bar"]);
    expect(report.warnings).toContain("new agent-installed skill: bar");
  });
});

describe("item 2: sessions per run, keyed by sessionId", () => {
  const spawn = (depths: number[], extra: Record<string, string> = {}) =>
    run({ config: { maxSubagentsPerRun: 1 }, env: { FAKE_DAEMON_SPAWN: JSON.stringify(depths), FAKE_DAEMON_PROMPT_DELAY_MS: "800", ...extra } });
  it("ends a depth-0 session over the cap with kill, and audits it", async () => {
    const { result, report, log } = await spawn([1, 0]);
    expect(result).toMatchObject({ exitCode: 0, errorCode: null });
    expect(types()).toContain("roster_subscribe");
    expect(commands().filter((c) => c.type === "kill")).toHaveLength(1);
    expect(report.sessions).toBe(2);
    expect(report.sessionsEnded).toEqual([{ sessionId: expect.any(String), depth: 0, reason: "limit" }]);
    expect(log).toContain(`[paperclip] session limit 1 reached; ended session ${report.sessionsEnded[0].sessionId}`);
    const audit = (result.resultJson as { modelAudit: { actors: Array<{ depth: number | null }> } }).modelAudit;
    expect(audit.actors.map((actor) => actor.depth).sort()).toEqual([0, 0, 1]);
  });
  it("ends a depth-1 session over the cap with cancel_rlm_child then delete_rlm_subagent", async () => {
    const { result, report } = await spawn([0, 1]);
    expect(result.errorCode).toBeNull();
    const ends = commands().filter((c) => ["cancel_rlm_child", "delete_rlm_subagent", "kill"].includes(c.type));
    expect(ends.map((c) => c.type)).toEqual(["cancel_rlm_child", "delete_rlm_subagent"]);
    expect(ends[0]).toMatchObject({ childId: expect.stringMatching(/^sub-/), activeSessionId: expect.any(String) });
    expect(report.sessionsEnded).toHaveLength(1);
  });
  it("fails the run when an ended session is woken under a new activeSessionId", async () => {
    const { result, log } = await spawn([1, 1], { FAKE_DAEMON_WAKE_ENDED_MS: "100" });
    expect(result).toMatchObject({ errorCode: "prime_subagent_limit_exceeded", clearSession: false });
    expect(result.sessionParams).toBeUndefined();
    expect(log).toContain("was seen running again");
  });
  it.each(["list", "rlm_child_update"])("fails the run when only a %s shows the ended session running (TAI-324 T5)", async (via) => {
    const { result, log } = await spawn([1, 1], { FAKE_DAEMON_WAKE_ENDED_MS: "100", FAKE_DAEMON_WAKE_VIA: via, FAKE_DAEMON_PROMPT_DELAY_MS: "1500" });
    expect(result).toMatchObject({ errorCode: "prime_subagent_limit_exceeded", clearSession: false });
    expect(log).toContain("was seen running again");
  });
  it("fails the run when an end does not work", async () => {
    const { result } = await spawn([0, 0], { FAKE_DAEMON_END_FAILS: "1" });
    expect(result).toMatchObject({ errorCode: "prime_subagent_limit_exceeded" });
    expect(result.errorMessage).toContain("the roster still lists it");
  });
  it("falls back to list when roster_subscribe is refused, and still ends the extra session", async () => {
    const { result, report, log } = await spawn([1, 1], { FAKE_DAEMON_REFUSE: "roster_subscribe" });
    expect(result.errorCode).toBeNull();
    expect(log).toContain("Prime roster subscription failed");
    expect(report.sessionsEnded).toHaveLength(1);
  });
  // TAI-324 F2: a resumed parent's roster_subscribe lists its old child as an inactive ledger item whose id is its sessionId.
  const resumeAfter = async (depths: number[], over: Over = {}) => {
    const first = await run({ env: { FAKE_DAEMON_SPAWN: JSON.stringify(depths), FAKE_DAEMON_PROMPT_DELAY_MS: "800" } });
    expect(first.report.sessions).toBe(depths.length);
    const from = commands().length;
    const second = await run({ runId: "run-2", sessionParams: first.result.sessionParams!, ...over });
    return { first, second, commands: commands().slice(from), parent: commands().slice(from).find((c) => c.type === "attach")!.activeSessionId };
  };
  it("does not count, check or end a resumed parent's old child that is not woken (TAI-324 F2)", async () => {
    const { second, commands: ran, parent } = await resumeAfter([1]);
    expect(second.result).toMatchObject({ exitCode: 0, errorCode: null });
    expect(second.report).toMatchObject({ sessions: 0, sessionSkillChecks: 0, sessionsEnded: [], warnings: [] });
    expect(second.log).not.toContain("[paperclip] warning:");
    expect(ran.filter((c) => ["get_system_prompt", "get_resource_snapshot", "get_session_stats"].includes(c.type)).every((c) => c.activeSessionId === parent)).toBe(true);
    expect(ran.some((c) => ["cancel_rlm_child", "delete_rlm_subagent", "kill"].includes(c.type))).toBe(false);
  });
  it("counts a woken old child by its sessionId and checks it under its new activeSessionId (N0 item 4)", async () => {
    const { first, second, commands: ran, parent } = await resumeAfter([1], { env: { FAKE_DAEMON_WAKE_OLD_MS: "100", FAKE_DAEMON_PROMPT_DELAY_MS: "800" } });
    const oldChild = (first.result.resultJson as { modelAudit: { actors: Array<{ depth: number; sessionId: string }> } }).modelAudit.actors.find((a) => a.depth === 1)!.sessionId;
    expect(second.result.errorCode).toBeNull();
    expect(second.report).toMatchObject({ sessions: 1, sessionSkillChecks: 1, sessionsEnded: [] });
    const checked = ran.filter((c) => c.type === "get_resource_snapshot" && c.activeSessionId !== parent).map((c) => c.activeSessionId);
    expect(checked).toHaveLength(1);
    expect(checked[0]).not.toBe(oldChild);
  });
  it("ends a woken old session over the cap, and fails when it is woken again (§6 rev 6 line 8, fake daemon)", async () => {
    const capped = await resumeAfter([1, 0], { config: { maxSubagentsPerRun: 1 }, env: { FAKE_DAEMON_WAKE_OLD_MS: "100", FAKE_DAEMON_PROMPT_DELAY_MS: "800" } });
    expect(capped.second.result.errorCode).toBeNull();
    expect(capped.second.report.sessions).toBe(2);
    expect(capped.second.report.sessionsEnded).toEqual([{ sessionId: expect.any(String), depth: 0, reason: "limit" }]);
    const again = await run({ runId: "run-3", sessionParams: capped.second.result.sessionParams!, config: { maxSubagentsPerRun: 1 },
      env: { FAKE_DAEMON_WAKE_OLD_MS: "100", FAKE_DAEMON_WAKE_ENDED_MS: "100", FAKE_DAEMON_PROMPT_DELAY_MS: "1500" } });
    expect(again.result).toMatchObject({ errorCode: "prime_subagent_limit_exceeded", clearSession: false });
    expect(again.log).toContain("was seen running again");
  });
  // TAI-324 F4: on 0.10.1, deleting a woken old child sends one rlm_child_update that names it by its sessionId, with no file.
  const wokenOverCap = (env: Record<string, string> = {}) =>
    resumeAfter([1, 1], { config: { maxSubagentsPerRun: 1 }, env: { FAKE_DAEMON_WAKE_OLD_MS: "100", FAKE_DAEMON_PROMPT_DELAY_MS: "800", FAKE_DAEMON_DELETE_UPDATE: "1", ...env } });
  it("ends a woken old child over the cap, and its sessionId-named update on delete is the audited file, not a missing one (TAI-324 F4)", async () => {
    const { second, commands: ran } = await wokenOverCap();
    expect(records().filter((r) => r.kind === "delete_update")).toHaveLength(1);
    expect(second.result).toMatchObject({ exitCode: 0, errorCode: null, clearSession: false, sessionParams: expect.any(Object) });
    expect(second.report.sessionsEnded).toEqual([{ sessionId: expect.any(String), depth: 1, reason: "limit" }]);
    expect(ran.filter((c) => c.type === "delete_rlm_subagent")).toHaveLength(1);
    const ended = second.report.sessionsEnded[0].sessionId;
    const audit = (second.result.resultJson as { modelAudit: { ok: boolean; unreadable: unknown[]; actors: Array<{ sessionId: string; depth: number; file: string }> } }).modelAudit;
    expect(audit).toMatchObject({ ok: true, unreadable: [] });
    expect(audit.actors.filter((a) => a.sessionId === ended)).toEqual([expect.objectContaining({ depth: 1, file: expect.stringMatching(new RegExp(`${ended}\\.jsonl$`)) })]);
    expect(second.log).not.toContain("no session file");
    // The run-end stats loop asks about that id too. The ended child's live id is not asked, so its usage is missing (as on 0.10.1).
    expect(ran.filter((c) => c.type === "get_session_stats" && c.activeSessionId === ended)).toHaveLength(1);
    expect((second.result.resultJson as { usageNote?: string }).usageNote).toBe("child usage not reported");
  });
  it("does not ask get_session_stats about a sessionId whose live activeSessionId it asks too (TAI-347)", async () => {
    const { second, commands: ran } = await wokenOverCap({ FAKE_DAEMON_DELETE_UPDATE_ID: "live-sibling" });
    const named = records().find((r) => r.kind === "delete_update") as unknown as { child: { activeSessionId: string } };
    expect(second.result).toMatchObject({ exitCode: 0, errorCode: null, clearSession: false });
    const audit = (second.result.resultJson as { modelAudit: { ok: boolean; actors: Array<{ sessionId: string }> } }).modelAudit;
    expect(audit.ok).toBe(true);
    expect(audit.actors.map((a) => a.sessionId)).toContain(named.child.activeSessionId);
    const asked = ran.filter((c) => c.type === "get_session_stats").map((c) => c.activeSessionId);
    expect(asked).not.toContain(named.child.activeSessionId);
    expect(asked.length).toBeGreaterThanOrEqual(3); // before, after and the live sibling
    expect((second.result.resultJson as { usageNote?: string }).usageNote).toBeUndefined();
  });
  it("still fails the model audit for a child update with no file whose id matches no audited file (TAI-324 F4 control)", async () => {
    const { second } = await wokenOverCap({ FAKE_DAEMON_DELETE_UPDATE_ID: "no-such-session" });
    expect(records().filter((r) => r.kind === "delete_update")).toHaveLength(1);
    expect(second.result).toMatchObject({ errorCode: "prime_model_audit_failed", clearSession: true });
    expect(second.result.errorMessage).toContain("actor no-such-session: the daemon reported this child but no session file for it");
  });
  it("audits depth-0 sessions with allowedModels set, without governed-v1 too (§7 item 9)", async () => {
    writeFileSync(path.join(root, "host-auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: 0 } }), { mode: 0o600 });
    const { result } = await run({ config: { featureProfile: undefined, credentialMode: undefined, apiKeyEnvVar: undefined,
      hostAuthFile: path.join(root, "host-auth.json") }, env: { FAKE_DAEMON_SPAWN: "[0]", FAKE_DAEMON_SPAWN_MODEL: "claude-opus-4-7" } });
    expect(result).toMatchObject({ errorCode: "prime_model_audit_failed" });
    expect(result.errorMessage).toContain("depth 0");
  });
});

describe("item 1 backstop: isQuotaParked", () => {
  it("aborts the turn and fails with prime_provider_quota, keeping the session", async () => {
    const { result } = await run({ config: { graceSec: 0.2 }, env: { FAKE_DAEMON_QUOTA_PARKED: "1", FAKE_DAEMON_PROMPT_MODE: "hang" } });
    expect(result).toMatchObject({ errorCode: "prime_provider_quota", clearSession: false });
    expect(types()).toContain("abort");
  });
});

describe("item 7: goals not set by Paperclip", () => {
  const goal = (objective: string, status = "active") =>
    `${JSON.stringify({ type: "custom", customType: "thread_goal_state", data: { active: status === "active", status, goalId: "g1", objective } })}\n`;
  async function resumeWithGoal(objective: string, extra: Over = {}) {
    const first = await run();
    appendFileSync(String(first.result.sessionParams!.sessionFile), goal(objective));
    return { first, second: await run({ runId: "run-2", sessionParams: first.result.sessionParams!, ...extra }) };
  }
  it("clears a foreign goal with /goal clear before the first prompt and keeps the session", async () => {
    const { first, second } = await resumeWithGoal("Keep polling forever");
    expect(second.result.errorCode).toBeNull();
    expect(second.report.foreignGoals).toEqual([{ goalId: "g1", objective: "Keep polling forever", status: "active", action: "cleared" }]);
    const creates = commands().flatMap((c, index) => (c.type === "create" ? [index] : []));
    const secondRun = commands().slice(creates[1]);
    const clear = secondRun.findIndex((c) => c.type === "prompt_and_wait" && c.message === "/goal clear");
    expect(clear).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(secondRun.findIndex((c) => c.type === "attach"));
    expect(second.result.sessionId).toBe(first.result.sessionId);
  });
  it("starts a fresh session when the goal does not clear, and returns it without clearSession", async () => {
    const { first, second } = await resumeWithGoal("Keep polling forever", { env: { FAKE_DAEMON_GOAL_CLEAR: "ignore" } });
    expect(second.result).toMatchObject({ errorCode: null, clearSession: false });
    expect(second.result.sessionId).not.toBe(first.result.sessionId);
    expect(second.report.foreignGoals).toMatchObject([{ action: "fresh_session" }]);
    expect(second.log).toContain(`Prime session ${String(first.result.sessionId)} holds a goal not set by Paperclip; starting a fresh session.`);
  });
  const freshCommands = () => {
    const secondRun = commands().slice(commands().flatMap((c, index) => (c.type === "create" ? [index] : []))[1]);
    expect(secondRun.filter((c) => c.type === "create" && !("sessionPath" in c))).toHaveLength(1);
    return secondRun.slice(secondRun.findIndex((c) => c.type === "kill") + 1);
  };
  it("runs item 10's check and item 12's thinking-level step on the fresh session too", async () => {
    const { second } = await resumeWithGoal("Keep polling forever", { config: { thinking: "high" }, env: { FAKE_DAEMON_GOAL_CLEAR: "ignore" } });
    expect(second.result).toMatchObject({ exitCode: 0, errorCode: null, clearSession: false });
    const after = freshCommands();
    expect(after.map((c) => c.type).filter((t) => ["get_resource_snapshot", "set_model", "get_state", "attach"].includes(t))).toEqual(["get_resource_snapshot", "set_model", "get_state", "attach"]);
    const fresh = after.find((c) => c.type === "attach")!.activeSessionId;
    expect(after.filter((c) => ["get_resource_snapshot", "set_model", "get_state"].includes(c.type)).every((c) => c.activeSessionId === fresh)).toBe(true);
    expect(second.report.modelCatalog).toMatchObject({ ok: true, thinkingLevel: "high" });
  });
  it("reloads a stale model in the fresh session too, so its first request has thinking (TAI-324 F3)", async () => {
    const { second } = await resumeWithGoal("Keep polling forever", { config: { thinking: "high" }, env: { FAKE_DAEMON_GOAL_CLEAR: "ignore", FAKE_DAEMON_STALE_AT_CREATE: "1" } });
    expect(second.result).toMatchObject({ exitCode: 0, errorCode: null, clearSession: false });
    const fresh = freshCommands().find((c) => c.type === "attach")!.activeSessionId;
    expect(requests().filter((r) => r.activeSessionId === fresh).map((r) => r.thinking)).toEqual(["high"]);
    expect(settings()).toMatchObject({ defaultThinkingLevel: "high" });
    expect(second.report.modelCatalog).toMatchObject({ ok: true, liveModel: LIVE, thinkingLevel: "high" });
  });
  it.each(STEP_FAILURES.map(([name, env, failure]) => [name, { ...env, FAKE_DAEMON_SET_MODEL_SCOPE: "new", ...(env.FAKE_DAEMON_THINKING_STUCK ? { FAKE_DAEMON_THINKING_STUCK: "new" } : {}) }, failure] as const))(
    "fails before the first prompt when, in the fresh session, %s, with no clearSession (TAI-324 F3)", async (_name, env, failure) => {
    const { second } = await resumeWithGoal("Keep polling forever", { env: { FAKE_DAEMON_GOAL_CLEAR: "ignore", ...env } });
    expect(second.result).toMatchObject({ errorCode: "prime_model_catalog_invalid", clearSession: false, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    expect(second.result.sessionParams).toBeUndefined();
    expect(second.report.modelCatalog).toMatchObject({ ok: false, failure });
    const after = freshCommands();
    expect(after.map((c) => c.type)).toContain("set_model");
    expect(after.map((c) => c.type)).not.toContain("prompt_and_wait");
  });
  it("leaves a goal that matches adapterConfig.goal alone", async () => {
    const first = await run({ config: { goal: "Ship it" } });
    appendFileSync(String(first.result.sessionParams!.sessionFile), goal("Ship it"));
    const second = await run({ runId: "run-2", config: { goal: "Ship it" }, sessionParams: first.result.sessionParams! });
    expect(second.report.foreignGoals).toEqual([]);
    expect(commands().some((c) => c.message === "/goal clear")).toBe(false);
  });
});

describe("item 12: the model catalog and the parent's thinking level", () => {
  const entry = (over: Record<string, unknown> = {}) => ({ provider: "anthropic", id: "claude-haiku-4-5", baseUrl: "https://api.anthropic.com", reasoning: true, ...over });
  const bootstrap = { errorCode: "prime_model_catalog_invalid", clearSession: false, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } };
  it("checks after the parent's skill check and before /goal clear, with the parent's activeSessionId", async () => {
    await run({ config: { thinking: "high" } });
    const order = types().filter((t) => ["create", "get_resource_snapshot", "get_model_catalog", "set_model", "get_state", "attach", "prompt_and_wait"].includes(t));
    expect(order).toEqual(["create", "get_resource_snapshot", "get_model_catalog", "set_model", "get_state", "attach", "prompt_and_wait"]);
    expect(commands().find((c) => c.type === "set_model")).toMatchObject({ provider: "anthropic", modelId: "claude-haiku-4-5" });
    const created = commands().find((c) => c.type === "get_resource_snapshot")!.activeSessionId;
    expect(commands().find((c) => c.type === "get_model_catalog")!.activeSessionId).toBe(created);
  });
  it("waits for a catalog that lands after create, then reloads the model with set_model, so the first request has thinking (TAI-324 F1)", async () => {
    const { result, report } = await run({ config: { thinking: "high" }, env: { FAKE_DAEMON_CATALOG_READY_MS: "1200", FAKE_DAEMON_THINKING_RACE: "1" } });
    expect(result).toMatchObject({ exitCode: 0, errorCode: null });
    expect(report.modelCatalog).toMatchObject({ ok: true, refreshesSeen: 0, thinkingLevel: "high", failure: null });
    expect(report.modelCatalog.checks).toBeGreaterThan(1);
    expect(requests().map((r) => r.thinking)).toEqual(["high"]);
    // Rev 15: the one set_thinking_level is deferred until the catalog check passes, then set_model (the race in change 1).
    expect(types().filter((t) => t === "set_thinking_level")).toHaveLength(1);
    expect(types().lastIndexOf("get_model_catalog")).toBeLessThan(types().indexOf("set_thinking_level"));
    expect(types().indexOf("set_thinking_level")).toBeLessThan(types().indexOf("set_model"));
    expect(report.modelCatalog.liveModel).toEqual(LIVE);
    // settings.json after the run equals the managed keys plus recentModels (rev 11).
    expect(settings()).toEqual({ ...JSON.parse(records().find((r) => r.kind === "start")!.settings!), recentModels: [MODEL] });
    expect(report.settingsKeysRemoved).toEqual([]);
  });
  it("models 0.10.1: set_thinking_level alone after the catalog shows the level in get_state, sends no thinking and writes defaultThinkingLevel", async () => {
    const { PrimeDaemonClient } = await import("../src/server/execute-daemon.js");
    const agent = path.join(root, "probe-agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(path.join(agent, "settings.json"), "{}");
    const socket = path.join(root, "probe.sock");
    const child = spawn(process.execPath, [FAKE, "--mode", "daemon", "--daemon-socket", socket],
      { env: { ...process.env, FAKE_DAEMON_RECORD: rec(), FAKE_DAEMON_CATALOG_READY_MS: "300", FAKE_DAEMON_THINKING_RACE: "1" }, stdio: "ignore" });
    try {
      let client: Awaited<ReturnType<typeof PrimeDaemonClient.connect>> | null = null;
      for (let i = 0; i < 100 && !client; i += 1) client = await PrimeDaemonClient.connect(socket, 500).catch(async () => { await new Promise((r) => setTimeout(r, 30)); return null; });
      const ask = async (command: Record<string, unknown> & { type: string }) => (await client!.request(command, 5000)) as { success: boolean; data?: any };
      const id = (await ask({ type: "create", config: { cwd: ws(), agentDir: agent, sessionDir: path.join(agent, "sessions"), provider: "anthropic", model: "claude-haiku-4-5", thinking: "high" } })).data.activeSessionId;
      await ask({ type: "set_thinking_level", activeSessionId: id, level: "high" });
      expect((await ask({ type: "get_state", activeSessionId: id })).data.thinkingLevel).toBe("off");
      await new Promise((r) => setTimeout(r, 400));
      await ask({ type: "set_thinking_level", activeSessionId: id, level: "high" });
      expect((await ask({ type: "get_state", activeSessionId: id })).data.thinkingLevel).toBe("high");
      await ask({ type: "prompt_and_wait", activeSessionId: id, message: "one" });
      expect(JSON.parse(readFileSync(path.join(agent, "settings.json"), "utf8"))).toEqual({ defaultThinkingLevel: "high" });
      const reloaded = await ask({ type: "set_model", activeSessionId: id, provider: "anthropic", modelId: "claude-haiku-4-5" });
      expect(reloaded.data).toMatchObject({ provider: "anthropic", id: "claude-haiku-4-5", baseUrl: "https://api.anthropic.com", reasoning: true });
      await new Promise((r) => setTimeout(r, 50));
      await ask({ type: "prompt_and_wait", activeSessionId: id, message: "two" });
      expect(requests().map((r) => r.thinking)).toEqual([null, "high"]);
      client!.close();
    } finally { child.kill("SIGKILL"); }
  });
  it("fails before any prompt when the catalog never shows the model with reasoning in 15 s", async () => {
    const { result, report, log } = await run({ config: { thinking: "high" }, env: { FAKE_DAEMON_CATALOG_READY_MS: "60000" } });
    expect(result).toMatchObject(bootstrap);
    expect(result.sessionParams).toBeUndefined();
    expect(report.modelCatalog).toMatchObject({ ok: false, failure: `${MODEL} has no reasoning (thinking is high)` });
    expect(report.modelCatalog.checks).toBeGreaterThanOrEqual(25);
    expect(log).toContain(`[paperclip] Prime model catalog check failed: ${MODEL} has no reasoning (thinking is high)`);
    expect(types()).not.toContain("prompt_and_wait");
  }, 30_000);
  it("fails on an allowed anthropic model at another address, and on an allowed model that is not listed", async () => {
    const moved = await run({ env: { FAKE_DAEMON_CATALOG: JSON.stringify([entry({ baseUrl: "https://n0-redirect.invalid" })]) } });
    expect(moved.result).toMatchObject(bootstrap);
    expect(moved.log).toContain(`${MODEL} has baseUrl "https://n0-redirect.invalid", not https://api.anthropic.com`);
    const missing = await run({ runId: "run-2", env: { FAKE_DAEMON_CATALOG: JSON.stringify([entry({ id: "claude-opus-5-5" })]), FAKE_DAEMON_CATALOG_READY_MS: "0" } });
    expect(missing.result.errorMessage).toContain(`${MODEL} is not listed`);
  }, 40_000);
  it("ignores an anthropic entry outside allowedModels (rev 9 narrowed rule)", async () => {
    const { result } = await run({ env: { FAKE_DAEMON_CATALOG: JSON.stringify([entry(), entry({ id: "n0-probe", baseUrl: "http://127.0.0.1:9" })]) } });
    expect(result.errorCode).toBeNull();
  });
  it.each(STEP_FAILURES)("fails before the first prompt when %s, with no clearSession (rev 11)", async (_name, env, failure) => {
    const { result, report, log } = await run({ env });
    expect(result).toMatchObject(bootstrap);
    expect(result.sessionParams).toBeUndefined();
    expect(report.modelCatalog).toMatchObject({ ok: false, failure });
    expect(log).toContain(`[paperclip] Prime model catalog check failed: ${failure}`);
    expect(types()).not.toContain("prompt_and_wait");
    // No second set_thinking_level: the deferred first one (rev 15) comes before set_model, none after it.
    expect(types().slice(types().indexOf("set_model"))).not.toContain("set_thinking_level");
  });
  it("sends no set_thinking_level when the catalog check fails (rev 15: deferred until it passes)", async () => {
    const { result } = await run({ config: { thinking: "high" }, env: { FAKE_DAEMON_CATALOG_READY_MS: "60000", FAKE_DAEMON_THINKING_RACE: "1" } });
    expect(result).toMatchObject(bootstrap);
    expect(types()).not.toContain("set_thinking_level");
  }, 30_000);
  it("fails prime_settings_tampered with clearSession when set_model writes another defaultThinkingLevel and item 12 then fails (rev 13)", async () => {
    const { result, report, log } = await run({ env: { FAKE_DAEMON_SET_MODEL_CLAMP: "medium" } });
    expect(result).toMatchObject({ errorCode: "prime_settings_tampered", clearSession: true,
      errorMeta: { policyFailures: ["prime_settings_tampered"], runErrorCode: "prime_model_catalog_invalid" } });
    expect(result.executionRecovery).toBeUndefined();
    expect(result.sessionParams).toBeUndefined();
    expect(report.modelCatalog).toMatchObject({ ok: false, thinkingLevel: "medium", failure: 'thinking level is "medium", configured "high"' });
    expect(log).toContain('[paperclip] Prime model catalog check failed: thinking level is "medium", configured "high"');
    expect(log).toContain("[paperclip] settings.json managed keys changed during the run: defaultThinkingLevel.");
    expect((result.resultJson as { settings: Record<string, unknown> }).settings).not.toHaveProperty("restoredBeforePrompt");
    expect(report.warnings).toEqual([]);
    // The next run start writes the managed value back before Prime starts (item 1), as for any tamper.
    expect(settings()).toMatchObject({ defaultThinkingLevel: "medium" });
    const next = await run({ runId: "run-2" });
    expect(next.result.errorCode).toBeNull();
    // A run-start note, so it is in commandNotes (onMeta), not on the log stream (Sentry, TAI-324 rev 14 line).
    expect(next.notes).toContain("settings.json: restored managed keys changed since the last run: defaultThinkingLevel.");
    expect((next.result.resultJson as { settings: { restoredKeys: string[] } }).settings.restoredKeys).toEqual(["defaultThinkingLevel"]);
    expect(JSON.parse(records().filter((r) => r.kind === "start")[1]!.settings!)).toMatchObject({ defaultThinkingLevel: "high" });
    expect(settings()).toMatchObject({ defaultThinkingLevel: "high" });
  });
  it("sends no set_model without governed-v1 when create already shows the configured model (as on 1f8f816)", async () => {
    const { result } = await run({ config: { featureProfile: undefined } });
    expect(result.errorCode).toBeNull();
    expect(types()).toContain("create");
    expect(types()).not.toContain("set_model");
  });
  it("re-checks after model_catalog_changed during the run, and fails the run with no clearSession", async () => {
    const { result, report, log } = await run({ env: { FAKE_DAEMON_PROMPT_DELAY_MS: "800",
      FAKE_DAEMON_CATALOG_REFRESH: JSON.stringify([entry({ baseUrl: "https://elsewhere.invalid" })]) } });
    expect(result).toMatchObject({ errorCode: "prime_model_catalog_invalid", clearSession: false });
    expect(result.executionRecovery).toBeUndefined();
    expect(report.modelCatalog).toMatchObject({ ok: false, refreshesSeen: 1, checks: 2 });
    expect(log).toContain(`[paperclip] Prime model catalog check failed: ${MODEL} has baseUrl "https://elsewhere.invalid"`);
    expect(types()).toContain("abort");
  });
  it("reads the catalog every 60 s and after the last turn when roster_subscribe is refused", async () => {
    const { result, report } = await run({ env: { FAKE_DAEMON_REFUSE: "roster_subscribe" } });
    expect(result.errorCode).toBeNull();
    expect(report.modelCatalog).toMatchObject({ ok: true, checks: 2, refreshesSeen: 0 });
  });
});

describe("item 12: the thinking level is one that every allowed model supports (rev 13, TAI-343 change 2)", () => {
  const OPUS = "anthropic/claude-opus-5-5";
  /** Opus 5.5's real catalog entry (0.10.1 catalog copy from Sentry's TAI-324 rig; the same as set_model's answer in n02). */
  const OPUS_ENTRY = { id: "claude-opus-5-5", name: "Claude Opus 5.5", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://api.anthropic.com", reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    input: ["text", "image"], cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, contextWindow: 1000000, maxTokens: 128000 };
  const opus = (thinking: string, env: Record<string, string> = {}) =>
    run({ config: { model: OPUS, allowedModels: [OPUS], thinking }, env: { FAKE_DAEMON_CATALOG: JSON.stringify([OPUS_ENTRY]), ...env } });
  const haiku = (over: Record<string, unknown>) => ({ provider: "anthropic", id: "claude-haiku-4-5", baseUrl: "https://api.anthropic.com", reasoning: true, ...over });
  const failedBeforeSetModel = { errorCode: "prime_model_catalog_invalid", clearSession: false, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } };
  it("follows Prime's getSupportedThinkingLevels (0.7.1 models.ts:66-75)", () => {
    expect(primeSupportedThinkingLevels(OPUS_ENTRY)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(primeSupportedThinkingLevels(haiku({}))).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(primeSupportedThinkingLevels(haiku({ thinkingLevelMap: { low: "low", xhigh: "xhigh" } }))).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    expect(primeSupportedThinkingLevels(haiku({ thinkingLevelMap: { high: null, max: null } }))).toEqual(["off", "minimal", "low", "medium"]);
    expect(primeSupportedThinkingLevels(haiku({ reasoning: false, thinkingLevelMap: OPUS_ENTRY.thinkingLevelMap }))).toEqual(["off"]);
    // An allowed model with reasoning: false never passes, at any level, off included; the wait goes on for it.
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(primeCatalogCheck({ models: [haiku({ reasoning: false })] }, [MODEL], level)).toEqual({ problem: `${MODEL} has no reasoning (thinking is ${level})`, wait: true });
    }
  });
  it.each(["off", "minimal"])("fails thinking %s on Opus 5.5's real entry before the first prompt, with no set_model", async (level) => {
    const { result, report, log } = await opus(level);
    expect(result).toMatchObject(failedBeforeSetModel);
    const failure = `thinking level ${level} is not supported by ${OPUS}; supported: low, medium, high, xhigh, max`;
    expect(report.modelCatalog).toMatchObject({ ok: false, checks: 1, liveModel: null, failure });
    expect(log).toContain(`[paperclip] Prime model catalog check failed: ${failure}\n`);
    expect(types()).not.toContain("set_model");
    expect(types()).not.toContain("prompt_and_wait");
    expect(requests()).toEqual([]);
  });
  it.each(["low", "max"])("passes thinking %s on Opus 5.5's real entry", async (level) => {
    const { result, report } = await opus(level);
    expect(result).toMatchObject({ exitCode: 0, errorCode: null });
    expect(report.modelCatalog).toMatchObject({ ok: true, thinkingLevel: level, liveModel: { provider: "anthropic", id: "claude-opus-5-5", baseUrl: "https://api.anthropic.com", reasoning: true } });
    expect(requests().map((r) => r.thinking)).toEqual([level]);
  });
  it("passes high for a map without a high key and for an entry with no map; fails xhigh for a map without xhigh", async () => {
    const noHigh = { off: null, minimal: null, low: "low", medium: "medium", xhigh: "xhigh", max: "max" };
    const keyless = await run({ env: { FAKE_DAEMON_CATALOG: JSON.stringify([haiku({ thinkingLevelMap: noHigh })]) } });
    expect(keyless.result.errorCode).toBeNull();
    const mapless = await run({ runId: "run-2", env: { FAKE_DAEMON_CATALOG: JSON.stringify([haiku({})]) } });
    expect(mapless.result.errorCode).toBeNull();
    const noXhigh = await run({ runId: "run-3", config: { thinking: "xhigh" }, env: { FAKE_DAEMON_CATALOG: JSON.stringify([haiku({ thinkingLevelMap: { low: "low", high: "high", max: "max" } })]) } });
    expect(noXhigh.result).toMatchObject(failedBeforeSetModel);
    expect(noXhigh.report.modelCatalog.failure).toBe(`thinking level xhigh is not supported by ${MODEL}; supported: off, minimal, low, medium, high, max`);
  });
  it("never passes an allowed model with reasoning: false under thinking off", async () => {
    const { result, report } = await run({ config: { thinking: "off" }, env: { FAKE_DAEMON_CATALOG: JSON.stringify([haiku({ reasoning: false })]) } });
    expect(result).toMatchObject(failedBeforeSetModel);
    expect(report.modelCatalog).toMatchObject({ ok: false, failure: `${MODEL} has no reasoning (thinking is off)` });
    expect(report.modelCatalog.checks).toBeGreaterThanOrEqual(25);
    expect(types()).not.toContain("set_model");
  }, 30_000);
  it("does not pass thinking off on the entry from before the fetch, and fails once the real entry lands", async () => {
    const { result, report } = await opus("off", { FAKE_DAEMON_CATALOG_READY_MS: "1200" });
    expect(result).toMatchObject(failedBeforeSetModel);
    expect(report.modelCatalog.checks).toBeGreaterThan(1);
    expect(report.modelCatalog.failure).toBe(`thinking level off is not supported by ${OPUS}; supported: low, medium, high, xhigh, max`);
    expect(types()).not.toContain("set_model");
  });
  it("fails a set_model answer with reasoning: false under thinking off (no exception for off)", async () => {
    const { result, report } = await run({ config: { thinking: "off" }, env: { FAKE_DAEMON_SET_MODEL_ENTRY: JSON.stringify(haiku({ reasoning: false })) } });
    expect(result).toMatchObject(failedBeforeSetModel);
    expect(report.modelCatalog.failure).toBe(`set_model answered ${MODEL} has no reasoning (thinking is off)`);
    expect(types()).toContain("set_model");
  });
});

describe("item 11: the agent dir is an allowlist; the catalog caches are deleted", () => {
  it("moves models.json and every other entry off the keep-list, with a warning each, and keeps the keep-list", async () => {
    write(path.join(agentDir(), "models.json"), '{"providers":{}}');
    write(path.join(agentDir(), "extensions", "x.ts"), "x");
    write(path.join(agentDir(), "persistent-shells", "s.json"), "{}");
    for (const name of ["session-leases", "rlm-ledger", "logs"]) write(path.join(agentDir(), name, "kept.json"), "{}");
    write(path.join(agentDir(), "telemetry.json"), "{}");
    const { result, report, log } = await run();
    expect(result.errorCode).toBeNull();
    expect(report.agentDirDisabled).toEqual([
      { name: "extensions", kind: "dir", sha256: null }, { name: "models.json", kind: "file", sha256: sha('{"providers":{}}') },
      { name: "persistent-shells", kind: "dir", sha256: null },
    ]);
    expect(readFileSync(disabled("models.json"), "utf8")).toBe('{"providers":{}}');
    expect(existsSync(path.join(agentDir(), "models.json"))).toBe(false);
    for (const name of ["session-leases", "rlm-ledger", "logs", "telemetry.json"]) expect(existsSync(path.join(agentDir(), name))).toBe(true);
    expect(report.warnings).toEqual(expect.arrayContaining(["extensions", "models.json", "persistent-shells"].map((n) => `agent-dir entry off the keep-list moved aside: ${n}`)));
    expect(log).toContain("[paperclip] warning: agent-dir entry off the keep-list moved aside: models.json");
  });
  it("deletes both caches with the sha256 of each regular file and no warning; a cache link goes, its target stays", async () => {
    write(path.join(agentDir(), "models", "provider-model-catalog.v1.json"), "catalog");
    write(path.join(agentDir(), "mcp-service-catalog.v2.json"), "mcp");
    const { report } = await run();
    expect(report.cachesCleared).toEqual([{ name: "models", sha256: sha("catalog") }, { name: "mcp-service-catalog.v2.json", sha256: sha("mcp") }]);
    expect([existsSync(path.join(agentDir(), "models")), existsSync(path.join(agentDir(), "mcp-service-catalog.v2.json"))]).toEqual([false, false]);
    expect(report.warnings).toEqual([]);
    const target = path.join(root, "elsewhere.json");
    write(target, "keep me");
    symlinkSync(target, path.join(agentDir(), "mcp-service-catalog.v2.json"));
    const second = await run({ runId: "run-2" });
    expect(second.report.cachesCleared).toEqual([{ name: "mcp-service-catalog.v2.json", sha256: null }]);
    expect(readFileSync(target, "utf8")).toBe("keep me");
  });
});

describe("G3 item 6: recovery journals are deleted at run start, and item 12's get_state is the backstop (rev 15)", () => {
  /** A 0.10.1 recovery journal as N7 (TAI-346) found it: state records and a queue snapshot holding the cut prompt. */
  const journal = (busy: boolean, sessionId = "01a174fc-old", operation = busy ? "prompt_accepted" : "turn_end") => [
    { activeSessionId: "dae63767296d", sessionId, sessionFile: "/old.jsonl", busy: true, operation: "create", recordedAt: "t0" },
    { version: 2, type: "queue_snapshot", active_session_id: "dae63767296d", steering: [{ message: "the cut prompt" }], follow_up: [], recorded_at: "t1" },
    { activeSessionId: "dae63767296d", sessionId, sessionFile: "/old.jsonl", busy, operation, recordedAt: "t2" },
  ].map((record) => `${JSON.stringify(record)}\n`).join("");
  const workers = (...parts: string[]) => path.join(agentDir(), "daemon-workers", ...parts);
  const workersAtCreate = () => records().filter((r) => r.kind === "daemon_workers_at_create").map((r) => (r as unknown as { exists: boolean }).exists);
  const secondRunCommands = () => commands().slice(commands().flatMap((c, index) => (c.type === "create" ? [index] : []))[1]);
  async function resume(env: Record<string, string> = {}, before: (sessionFile: string) => void = () => undefined) {
    const first = await run();
    before(String(first.result.sessionParams!.sessionFile));
    return { first, second: await run({ runId: "run-2", sessionParams: first.result.sessionParams!, env }) };
  }

  it("logs a busy journal, sets interruptedSession, deletes daemon-workers/ and resumes the same sessionId with sessionPath", async () => {
    const { first, second } = await resume({}, () => {
      write(workers("509bc496826a", "dae63767296d.recovery.jsonl"), journal(true));
      write(workers("509bc496826a", "supervisor-config"), "{}");
    });
    expect(second.result).toMatchObject({ exitCode: 0, errorCode: null, clearSession: false, sessionId: first.result.sessionId });
    expect(second.report.interruptedSession).toEqual({ sessionId: "01a174fc-old", operation: "prompt_accepted" });
    const line = "Prime session 01a174fc-old was interrupted mid-turn (prompt_accepted); dropping the recovery journal.";
    expect(second.log.split("\n").filter((l) => l === `[paperclip] warning: ${line}`)).toHaveLength(1);
    expect(second.report.warnings).toEqual([line]);
    expect(secondRunCommands()[0]).toMatchObject({ type: "create", sessionPath: first.result.sessionParams!.sessionFile });
  });
  it("deletes daemon-workers/ before the daemon starts, and does not move it to .paperclip-disabled/", async () => {
    write(workers("w1", "a.recovery.jsonl"), journal(true));
    const { result, report } = await run();
    expect(result.errorCode).toBeNull();
    expect(workersAtCreate()).toEqual([false]);
    expect(existsSync(disabled("daemon-workers"))).toBe(false);
    expect(report.agentDirDisabled).toEqual([]);
  });
  it("deletes a dir with no busy tail silently: no warning and no interruptedSession", async () => {
    write(workers("w1", "a.recovery.jsonl"), journal(false));
    write(workers("w1", "b.recovery.jsonl"), "{\"busy\":tr"); // a line cut by a crash
    write(workers("w1", "a.recovery.jsonl.writer-lock"), "");
    const { result, report, log } = await run();
    expect(result.errorCode).toBeNull();
    expect(existsSync(workers())).toBe(false);
    expect(report).not.toHaveProperty("interruptedSession");
    expect(report.warnings).toEqual([]);
    expect(log).not.toContain("interrupted mid-turn");
  });
  it("removes a daemon-workers link without reading through it; its target stays", async () => {
    const target = path.join(root, "elsewhere-workers");
    write(path.join(target, "w1", "a.recovery.jsonl"), journal(true));
    mkdirSync(agentDir(), { recursive: true });
    symlinkSync(target, workers());
    const { result, report } = await run();
    expect(result.errorCode).toBeNull();
    expect(existsSync(workers())).toBe(false);
    expect(readFileSync(path.join(target, "w1", "a.recovery.jsonl"), "utf8")).toBe(journal(true));
    expect(report).not.toHaveProperty("interruptedSession");
  });
  it("leaves daemon-workers/ untouched without governed-v1 (as on 1f8f816)", async () => {
    write(workers("w1", "a.recovery.jsonl"), journal(true));
    const { result, log } = await run({ config: { featureProfile: undefined } });
    expect(result.errorCode).toBeNull();
    expect(readFileSync(workers("w1", "a.recovery.jsonl"), "utf8")).toBe(journal(true));
    expect(log).not.toContain("interrupted mid-turn");
  });
  it("does not fire the backstop when messageCount equals the file's message entries", async () => {
    const message = (role: string) => `${JSON.stringify({ type: "message", id: role, message: { role, content: [{ type: "text", text: role }] } })}\n`;
    const { first, second } = await resume({}, (file) => appendFileSync(file, message("user") + message("assistant")));
    expect(second.result).toMatchObject({ errorCode: null, sessionId: first.result.sessionId });
    expect(second.report).not.toHaveProperty("interruptedSession");
    expect(secondRunCommands().map((c) => c.type)).not.toContain("kill");
  });
  it.each([["isStreaming", "streaming"], ["messageCount", "messages"]] as const)(
    "on %s at item 12's get_state, kills the session and runs item 10's check and item 12's steps on a fresh one", async (via, replay) => {
    const { first, second } = await resume({ FAKE_DAEMON_REPLAY: replay });
    expect(second.result).toMatchObject({ exitCode: 0, errorCode: null, clearSession: false });
    expect(second.result.sessionId).not.toBe(first.result.sessionId);
    expect(second.report.interruptedSession).toEqual({ sessionId: first.result.sessionId, detectedVia: via });
    const line = `Prime session ${String(first.result.sessionId)} ran a turn the adapter did not start (${via}); starting a fresh session.`;
    expect(second.log).toContain(`[paperclip] warning: ${line}`);
    expect(second.report.warnings).toEqual([line]);
    const run2 = secondRunCommands();
    const kill = run2.findIndex((c) => c.type === "kill");
    expect(kill).toBeGreaterThan(run2.findIndex((c) => c.type === "get_state"));
    expect(run2[kill]!.activeSessionId).toBe(run2.find((c) => c.type === "get_state")!.activeSessionId);
    const after = run2.slice(kill + 1);
    expect(after.filter((c) => c.type === "create")).toEqual([expect.not.objectContaining({ sessionPath: expect.anything() })]);
    expect(after.map((c) => c.type).filter((t) => ["get_resource_snapshot", "set_model", "get_state", "attach", "prompt_and_wait"].includes(t)))
      .toEqual(["get_resource_snapshot", "set_model", "get_state", "attach", "prompt_and_wait"]);
    expect(second.report.modelCatalog).toMatchObject({ ok: true, thinkingLevel: "high" });
  });
  it.each(STEP_FAILURES.map(([name, env]) => [name, { ...env, FAKE_DAEMON_SET_MODEL_SCOPE: "new", ...(env.FAKE_DAEMON_THINKING_STUCK ? { FAKE_DAEMON_THINKING_STUCK: "new" } : {}) }] as const))(
    "once the backstop fired, a failure in the fresh session (%s) does not claim providerWorkStarted: false", async (_name, env) => {
    const { second } = await resume({ FAKE_DAEMON_REPLAY: "messages", ...env });
    expect(second.result).toMatchObject({ errorCode: "prime_model_catalog_invalid", clearSession: false });
    expect(second.result).not.toHaveProperty("executionRecovery");
    expect(second.result.sessionParams).toBeUndefined();
    expect(second.report.interruptedSession).toMatchObject({ detectedVia: "messageCount" });
  });
  it("a skill-list failure in the fresh session does not claim providerWorkStarted: false either", async () => {
    const { second } = await resume({ FAKE_DAEMON_REPLAY: "streaming", FAKE_DAEMON_FOUND_SKILLS_SCOPE: "new",
      FAKE_DAEMON_FOUND_SKILLS: JSON.stringify([path.join(root, "home", ".agents", "skills", "rogue")]) });
    expect(second.result).toMatchObject({ errorCode: "prime_skill_list_invalid" });
    expect(second.result).not.toHaveProperty("executionRecovery");
    expect(second.report.interruptedSession).toMatchObject({ detectedVia: "isStreaming" });
  });
});

describe("G3 item 5: persistent shells end with the run (TAI-340 change 1)", () => {
  const started: number[] = [];
  const procStat = (pid: number) => { try { const st = readFileSync(`/proc/${pid}/stat`, "utf8"); return st.slice(st.lastIndexOf(")") + 2).split(" "); } catch { return null; } };
  const alive = (pid: number) => { const f = procStat(pid); return f !== null && f[0] !== "Z"; };
  const members = (session: number) => readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number).filter((p) => { const f = procStat(p); return f !== null && f[0] !== "Z" && Number(f[3]) === session; });
  /** A real shell in its own session, as bash(..., persistent=True) starts it, and its record. */
  function shell(command: string, record: Record<string, unknown> = {}, file?: string) {
    const child = spawn("sh", ["-c", command], { detached: true, stdio: "ignore" });
    child.unref();
    started.push(child.pid!);
    const startId = `proc:${procStat(child.pid!)![19]}`;
    write(file ?? path.join(agentDir(), "persistent-shells", `s${child.pid}.json`), JSON.stringify({ id: `s${child.pid}`, pid: child.pid, startId, sessionId: "old-session", ...record }));
    return child.pid!;
  }
  const fromRecords = () => records().filter((r) => r.kind === "persistent_shell") as unknown as Array<{ pid: number; sessionId: string }>;
  afterEach(() => {
    for (const pid of [...started, ...fromRecords().map((r) => r.pid)]) { try { process.kill(-pid, "SIGKILL"); } catch {} for (const m of members(pid)) { try { process.kill(m, "SIGKILL"); } catch {} } }
    started.length = 0;
  });
  it("ends a shell the run started, with its whole session (timeout moves its child to another group), before the run-end checks", async () => {
    const marker = path.join(root, "late-writes");
    const { result, report, log } = await run({ env: { FAKE_DAEMON_PROMPT_DELAY_MS: "500",
      FAKE_DAEMON_PERSISTENT_SHELL: `timeout 600 sh -c 'while true; do echo x >> ${marker}; sleep 0.05; done'` } });
    const [rec] = fromRecords();
    expect(result.errorCode).toBeNull();
    expect(report.persistentShellsKilled).toEqual([{ shellId: `fakeshell${rec!.pid}`, sessionId: rec!.sessionId, pid: rec!.pid, when: "run_end", stopped: true }]);
    expect(members(rec!.pid)).toEqual([]);
    expect(log).toContain(`[paperclip] ended persistent shell fakeshell${rec!.pid} (pid ${rec!.pid}, session ${rec!.sessionId})`);
    expect(existsSync(marker)).toBe(true); // the loop ran during the turn
    const size = statSync(marker).size;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(statSync(marker).size).toBe(size);
  });
  it("a shell that rewrites settings.json in a loop cannot change it after the run-end check (4.3 bullet 7, TAI-324 T3)", async () => {
    const file = path.join(agentDir(), "settings.json");
    const script = path.join(root, "rewrite-settings.sh");
    writeFileSync(script, `while true; do printf '%s' '{"shellPath":"/bin/evil"}' > '${file}.x'; mv '${file}.x' '${file}'; sleep 0.05; done\n`);
    const { result, report } = await run({ env: { FAKE_DAEMON_PROMPT_DELAY_MS: "500", FAKE_DAEMON_PERSISTENT_SHELL: `timeout 600 sh ${script}` } });
    const [rec] = fromRecords();
    expect(result).toMatchObject({ errorCode: "prime_settings_tampered", resultJson: { settings: { dangerousKeys: ["shellPath"] } } });
    expect(report.persistentShellsKilled).toMatchObject([{ pid: rec!.pid, when: "run_end", stopped: true }]);
    expect(members(rec!.pid)).toEqual([]);
    const after = readFileSync(file, "utf8");
    expect(JSON.parse(after)).not.toHaveProperty("shellPath");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readFileSync(file, "utf8")).toBe(after);
  });
  it("ends a shell left by an earlier run at run start, before item 11 moves persistent-shells/", async () => {
    const pid = shell("sleep 600");
    const { report } = await run();
    expect(alive(pid)).toBe(false);
    expect(report.persistentShellsKilled).toEqual([{ shellId: `s${pid}`, sessionId: "old-session", pid, when: "run_start", stopped: true }]);
    expect(report.agentDirDisabled).toContainEqual({ name: "persistent-shells", kind: "dir", sha256: null });
  });
  it("ends set -m and Popen(process_group=0) children in another group of the shell's session, leader still running (rev 10)", async () => {
    const shells = [shell("set -m; sleep 9204 & wait"), shell(`python3 -c "import subprocess; subprocess.Popen(['sleep', '9205'], process_group=0).wait()"`)];
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const pid of shells) expect(members(pid).length).toBe(2); // the leader and a child in its own group
    const { report } = await run();
    for (const pid of shells) expect(members(pid)).toEqual([]);
    expect(report.persistentShellsKilled.map((k: { stopped: boolean }) => k.stopped)).toEqual([true, true]);
  });
  it("sends no signal for another startId, a gone pid, a symlinked record or a bad pid", async () => {
    const other = shell("sleep 600", { startId: "proc:1" });
    const linked = shell("sleep 600", {}, path.join(root, "elsewhere.json"));
    symlinkSync(path.join(root, "elsewhere.json"), path.join(agentDir(), "persistent-shells", "linked.json"));
    write(path.join(agentDir(), "persistent-shells", "gone.json"), JSON.stringify({ id: "gone", pid: 4_000_000, startId: "proc:1" }));
    write(path.join(agentDir(), "persistent-shells", "bad.json"), JSON.stringify({ id: "bad", pid: "1", startId: "proc:1" }));
    const { report } = await run();
    expect([alive(other), alive(linked)]).toEqual([true, true]);
    expect(report.persistentShellsKilled).toEqual([]);
  });
  it("skips a persistent-shells dir that is a link, with a warning", async () => {
    mkdirSync(path.join(root, "shells"));
    mkdirSync(agentDir(), { recursive: true });
    symlinkSync(path.join(root, "shells"), path.join(agentDir(), "persistent-shells"));
    const { report, log } = await run();
    expect(log).toContain("[paperclip] warning: persistent-shells is not a dir; not read");
    expect(report.persistentShellsKilled).toEqual([]);
  });
  it("without governed-v1: ends only shells of this run's sessions, and has no run-start reap", async () => {
    const config = { featureProfile: undefined };
    const theirs = shell("sleep 600");
    const { result, log } = await run({ config, env: { FAKE_DAEMON_PERSISTENT_SHELL: "sleep 600" } });
    const [ours] = fromRecords();
    expect(result.resultJson).not.toHaveProperty("featureProfile");
    expect(alive(ours!.pid)).toBe(false);
    expect(alive(theirs)).toBe(true);
    expect(log).toContain(`[paperclip] ended persistent shell fakeshell${ours!.pid}`);
  });
});

describe("item 13: one governed run per agent dir; no marked process outlives the run", () => {
  const started: number[] = [];
  const procStat = (pid: number) => { try { const st = readFileSync(`/proc/${pid}/stat`, "utf8"); return st.slice(st.lastIndexOf(")") + 2).split(" "); } catch { return null; } };
  const alive = (pid: number) => { const f = procStat(pid); return f !== null && f[0] !== "Z"; };
  const marked = (dir: string, command = "sleep 600") => {
    const child = spawn("sh", ["-c", command], { detached: true, stdio: "ignore", env: { ...process.env, PRIME_AGENT_CODING_AGENT_DIR: dir } });
    child.unref();
    started.push(child.pid!);
    return child.pid!;
  };
  const left = () => records().filter((r) => r.kind === "left_process") as unknown as Array<{ pid: number }>;
  afterEach(() => {
    for (const pid of [...started, ...left().map((r) => r.pid)]) { try { process.kill(-pid, "SIGKILL"); } catch {} try { process.kill(pid, "SIGKILL"); } catch {} }
    started.length = 0;
  });
  const bootstrap = { clearSession: false, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } };
  it("fails a second overlapping run with prime_concurrent_run, which writes and starts nothing; the first succeeds; the next starts", async () => {
    const first = run({ env: { FAKE_DAEMON_PROMPT_DELAY_MS: "800" } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = await run({ runId: "run-2" });
    expect(second.result).toMatchObject({ errorCode: "prime_concurrent_run", ...bootstrap });
    expect(second.result.sessionParams).toBeUndefined();
    expect(second.log).toBe(`[paperclip] another run of this agent is in progress (${agentDir()}); not starting. Set runtimeConfig.heartbeat.maxConcurrentRuns to 1.\n`);
    expect(existsSync(path.join(agentDir(), ".paperclip-disabled", "run-2"))).toBe(false);
    expect((await first).result.errorCode).toBeNull();
    expect(records().filter((r) => r.kind === "start")).toHaveLength(1);
    expect((await run({ runId: "run-3" })).result.errorCode).toBeNull();
  });
  it("releases the guard after a failed run, and the guard holds across two copies of the module", async () => {
    expect((await run({ env: { FAKE_DAEMON_SNAPSHOT_FAILS: "1" } })).result.errorCode).toBe("prime_skill_list_invalid");
    expect((await run({ runId: "run-2" })).result.errorCode).toBeNull();
    const a = await import("../src/server/governed-guard.js");
    vi.resetModules();
    const b = await import("../src/server/governed-guard.js");
    expect(a).not.toBe(b);
    expect(a.acquireGovernedRun("/x/agent")).toBe(true);
    expect(b.acquireGovernedRun("/x/agent")).toBe(false);
    b.releaseGovernedRun("/x/agent");
    expect(a.acquireGovernedRun("/x/agent")).toBe(true);
    a.releaseGovernedRun("/x/agent");
  });
  it("fails with prime_leftover_processes before auth.json is written when a process carries this agent's marker; another agent's marker passes", async () => {
    const pid = marked(agentDir());
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { result, log } = await run();
    expect(result).toMatchObject({ errorCode: "prime_leftover_processes", ...bootstrap });
    expect(result.errorMessage).toContain(`pid ${pid} (session ${pid}): sleep 600`);
    expect(log).toContain(`End them with: kill -9 ${pid}`);
    expect(existsSync(path.join(agentDir(), "auth.json"))).toBe(false);
    expect(records()).toEqual([]);
    process.kill(pid, "SIGKILL");
    marked(path.join(root, "agents", "agent-2", "prime-agent-home"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await run({ runId: "run-2" })).result.errorCode).toBeNull();
  });
  it("sweeps a setsid job and a double fork at run end, with warnings; another agent's process and an env -i process stay", async () => {
    const theirs = marked(path.join(root, "agents", "agent-2", "prime-agent-home"));
    const { result, report, log } = await run({ env: { FAKE_DAEMON_LEAVE_PROCESSES: JSON.stringify(["setsid sleep 9206", "(sleep 9207 &)", "env -i sleep 9208"]) } });
    expect(result.errorCode).toBeNull();
    const commands = report.processesSwept.map((p: { command: string }) => p.command).sort();
    expect(commands).toEqual(expect.arrayContaining(["sleep 9206", "sleep 9207"]));
    expect(commands.some((c: string) => c.includes("9208"))).toBe(false);
    expect(report.processesSwept.every((p: { stopped: boolean }) => p.stopped)).toBe(true);
    for (const p of report.processesSwept) expect(alive(p.pid)).toBe(false);
    expect(report.warnings).toContain(`ended leftover process ${report.processesSwept[0].pid} (${report.processesSwept[0].command})`);
    expect(log).toContain(`[paperclip] warning: ended leftover process ${report.processesSwept[0].pid}`);
    expect(alive(theirs)).toBe(true);
    const envI = readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number)
      .filter((p) => { try { return readFileSync(`/proc/${p}/cmdline`, "utf8").startsWith("sleep\u00009208"); } catch { return false; } });
    expect(envI.length).toBe(1); // the named residual
    for (const p of envI) process.kill(p, "SIGKILL");
  });
  it("finds nothing to sweep in a normal run", async () => {
    expect((await run()).report.processesSwept).toEqual([]);
  });
});

describe("result shape", () => {
  it("adds featureProfile only under governed-v1", async () => {
    const plain = await run({ config: { featureProfile: undefined } });
    expect(plain.result.resultJson).not.toHaveProperty("featureProfile");
    const governed: AdapterExecutionResult = (await run({ runId: "run-2" })).result;
    expect(Object.keys((governed.resultJson as { featureProfile: object }).featureProfile).sort()).toEqual([
      "agentDirDisabled", "agentSkills", "agentSkillsDisabled", "cachesCleared", "contextFilesCreated", "contextFilesDisabled", "foreignGoals",
      "harnessBytes", "harnessEntriesDisabled", "harnessFingerprint", "maxSubagentsPerRun", "modelCatalog", "persistentShellsKilled", "processesSwept", "profile", "projectConfigCreated",
      "projectConfigDisabled", "refinementEvents", "scheduledJobsCreated", "scheduledJobsDisabled", "sessionSkillChecks", "sessions", "sessionsEnded",
      "settingsKeysRemoved", "skillDiscovery", "warnings", "workspaceContextFiles",
    ]);
    expect(lstatSync(path.join(agentDir(), ".paperclip-disabled")).isDirectory()).toBe(true);
  });
});

describe("item 10: the skill list, in the parent and in every other session", () => {
  const workspaceFile = () => path.join(ws(), ".prime", "agent", "settings.json");
  it("writes the workspace file with exact bytes and keeps it, untouched, between runs", async () => {
    await run();
    expect(readFileSync(workspaceFile(), "utf8")).toBe(WORKSPACE_SETTINGS);
    const before = lstatSync(workspaceFile());
    const second = await run({ runId: "run-2" });
    expect(second.result.errorCode).toBeNull();
    expect(lstatSync(workspaceFile()).ino).toBe(before.ino);
    expect(second.report.projectConfigCreated).toEqual([]);
  });
  it("passes goal by path only when adapterConfig.goal is set", async () => {
    await run({ config: { goal: "Ship it" } });
    expect(commands().find((c) => c.type === "create")).toMatchObject({ config: { skills: [...BUILTINS, path.join(path.dirname(FAKE), "skills", "goal")] } });
  });
  it("fails the run before any prompt when the parent lists a skill that is not on the list (a daemon that ignores the settings)", async () => {
    const found = path.join(agentDir(), "skills", "found");
    const { result, log } = await run({ env: { FAKE_DAEMON_FOUND_SKILLS: JSON.stringify([found]) } });
    expect(result).toMatchObject({ errorCode: "prime_skill_list_invalid", clearSession: false, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    expect(result.sessionParams).toBeUndefined();
    expect(result.errorMessage).toContain(found);
    expect(types()).not.toContain("prompt_and_wait");
    expect(log).toContain("skill list check failed");
  });
  it("fails the parent check when the snapshot cannot be read, or an explicit skill is missing", async () => {
    expect((await run({ env: { FAKE_DAEMON_SNAPSHOT_FAILS: "1" } })).result.errorCode).toBe("prime_skill_list_invalid");
  });
  it("TAI-365: loads all 12 of Vega's skills, summarize-status with its description quoted, and the parent check passes", async () => {
    const names = readdirSync(fixture("vega-skills")).sort();
    const skills = names.map((name) => ({ key: `vega/${name}`, runtimeName: name, source: path.join(fixture("vega-skills"), name) }));
    const { result, log } = await run({ config: { paperclipRuntimeSkills: skills, paperclipSkillSync: { desiredSkills: skills.map((skill) => skill.key) } } });
    expect(names).toHaveLength(12);
    expect(result).toMatchObject({ exitCode: 0, errorCode: null });
    const created = commands().find((c) => c.type === "create") as unknown as { config: { skills: string[] } };
    expect(created.config.skills.filter((dir) => !BUILTINS.includes(dir)).map((dir) => path.basename(dir)).sort()).toEqual([
      "agent-browser", "issue-triage", "paperclip", "paperclip-board", "paperclip-capsules", "qa-acceptance", "reflection-coach",
      "simplified-english", "status-card-query", "summarize-status", "task-planning", "wireframe",
    ]);
    expect(log).toContain('[paperclip] Skill "summarize-status--61a9e96dc6" is staged with its frontmatter "description" quoted');
    expect(log).not.toContain("skill list check failed");
  });
  it("checks every other session and ends one that found a skill; the run goes on", async () => {
    const found = "/home/someone/.agents/skills/omarchy";
    const { result, report, log } = await run({ env: { FAKE_DAEMON_SPAWN: "[0, 1]", FAKE_DAEMON_PROMPT_DELAY_MS: "800", FAKE_DAEMON_CHILD_SKILLS: JSON.stringify([found]) } });
    expect(result).toMatchObject({ exitCode: 0, errorCode: null });
    expect(report.sessionSkillChecks).toBe(2);
    expect(report.sessionsEnded).toEqual([
      { sessionId: expect.any(String), depth: 0, reason: "skill_list", skills: [found] },
      { sessionId: expect.any(String), depth: 1, reason: "skill_list", skills: [found] },
    ]);
    expect(commands().filter((c) => c.type === "get_resource_snapshot").map((c) => c.activeSessionId)).toHaveLength(3);
    expect(log).toContain(`[paperclip] warning: session ${report.sessionsEnded[0].sessionId} (depth 0) loaded skills not on the list: ${found}; ended`);
    expect(report.warnings).toContain(`session ${report.sessionsEnded[0].sessionId} (depth 0) loaded skills not on the list: ${found}; ended`);
    expect(log.split(`loaded skills not on the list: ${found}`).length - 1).toBe(2); // logged once each, not again at run end
  });
  it("lets a session with no skills run, and counts its check", async () => {
    const { result, report } = await run({ env: { FAKE_DAEMON_SPAWN: "[1]", FAKE_DAEMON_PROMPT_DELAY_MS: "500" } });
    expect([result.errorCode, report.sessionSkillChecks, report.sessionsEnded]).toEqual([null, 1, []]);
  });
  it("fails with prime_skill_list_invalid when a session ended for its skills runs again", async () => {
    const { result } = await run({ env: { FAKE_DAEMON_SPAWN: "[1]", FAKE_DAEMON_PROMPT_DELAY_MS: "800", FAKE_DAEMON_CHILD_SKILLS: '["/x/skills/found"]', FAKE_DAEMON_WAKE_ENDED_MS: "100" } });
    expect(result).toMatchObject({ errorCode: "prime_skill_list_invalid", clearSession: false });
  });
  it("restores a workspace file the run deleted, and fails with prime_settings_tampered without clearSession", async () => {
    const { result, log, report } = await run({ env: { FAKE_DAEMON_REMOVE_FILES: JSON.stringify([path.join(ws(), ".prime")]) } });
    expect(result).toMatchObject({ errorCode: "prime_settings_tampered", clearSession: false, errorMeta: { runErrorCode: null } });
    expect(result.sessionParams).toBeUndefined();
    expect(readFileSync(workspaceFile(), "utf8")).toBe(WORKSPACE_SETTINGS);
    expect(log).toContain(`The workspace file ${workspaceFile()} was missing at run end; it was restored.`);
    expect(report.warnings).toContain(`workspace settings.json was missing at run end; restored: ${workspaceFile()}`);
  });
  it("restores through no symlink: a .prime link put back during the run is moved aside first (TAI-339 change 2)", async () => {
    const shared = path.join(root, "shared");
    mkdirSync(path.join(shared, "agent"), { recursive: true });
    const links = JSON.stringify({ [path.join(ws(), ".prime")]: shared });
    const { result, report } = await run({ env: { FAKE_DAEMON_REMOVE_FILES: JSON.stringify([path.join(ws(), ".prime")]), FAKE_DAEMON_LINKS: links } });
    expect(result).toMatchObject({ errorCode: "prime_settings_tampered", clearSession: false });
    expect(existsSync(path.join(shared, "agent", "settings.json"))).toBe(false);
    expect(lstatSync(path.join(ws(), ".prime")).isDirectory()).toBe(true);
    expect(readlinkSync(path.join(ws(), ".prime.disabled-run-1-end"))).toBe(shared);
    expect(report.projectConfigCreated).toEqual([{ path: ".prime", sha256: null }]);
    expect(report.warnings).toContain("workspace .prime was a symlink; moved aside");
    expect(readFileSync(workspaceFile(), "utf8")).toBe(WORKSPACE_SETTINGS);
  });
  it("restores through no symlink: a .prime/agent link put back during the run is moved aside first (TAI-324 T2)", async () => {
    const shared = path.join(root, "shared");
    mkdirSync(shared, { recursive: true });
    const agentLink = path.join(ws(), ".prime", "agent");
    const { result, report } = await run({ env: { FAKE_DAEMON_REMOVE_FILES: JSON.stringify([agentLink]), FAKE_DAEMON_LINKS: JSON.stringify({ [agentLink]: shared }) } });
    expect(result).toMatchObject({ errorCode: "prime_settings_tampered", clearSession: false });
    expect(readdirSync(shared)).toEqual([]);
    expect(readlinkSync(path.join(ws(), ".prime", "agent.disabled-run-1-end"))).toBe(shared);
    expect(lstatSync(agentLink).isDirectory()).toBe(true);
    expect(readFileSync(workspaceFile(), "utf8")).toBe(WORKSPACE_SETTINGS);
    expect(report.projectConfigCreated).toEqual([{ path: path.join(".prime", "agent"), sha256: null }]);
    expect(report.warnings).toContain("workspace .prime/agent was a symlink; moved aside");
  });
  it("two agents' runs that overlap in one cwd keep the file: neither start replaces it, neither end deletes it (TAI-324 T1)", async () => {
    await run({ runId: "run-0" }); // the file exists, as after any earlier run in this cwd
    const ino = lstatSync(workspaceFile()).ino;
    const seen = new Set<number>();
    const watch = setInterval(() => { try { const st = lstatSync(workspaceFile()); if (readFileSync(workspaceFile(), "utf8") === WORKSPACE_SETTINGS) seen.add(st.ino); else seen.add(-1); } catch { seen.add(-2); } }, 10);
    try {
      const a = run({ runId: "run-a", env: { FAKE_DAEMON_PROMPT_DELAY_MS: "1200" } });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const b = await run({ runId: "run-b", agentId: "agent-2", env: { FAKE_DAEMON_PROMPT_DELAY_MS: "300" } });
      const first = await a;
      expect([first.result.errorCode, b.result.errorCode]).toEqual([null, null]);
      expect([first.report.projectConfigDisabled, b.report.projectConfigDisabled, first.report.projectConfigCreated, b.report.projectConfigCreated]).toEqual([[], [], [], []]);
    } finally { clearInterval(watch); }
    expect([...seen]).toEqual([ino]);
    expect(lstatSync(workspaceFile()).ino).toBe(ino);
    expect(records().filter((r) => r.kind === "start")).toHaveLength(3);
  });
  it("keeps clearSession: true when the agent-dir settings also failed", async () => {
    const { result } = await run({ env: { FAKE_DAEMON_REMOVE_FILES: JSON.stringify([path.join(ws(), ".prime")]),
      FAKE_DAEMON_EDIT_SETTINGS: JSON.stringify({ autoRefine: { enabled: true } }) } });
    expect(result).toMatchObject({ errorCode: "prime_settings_tampered", clearSession: true,
      errorMeta: { policyFailures: ["prime_settings_tampered", "prime_settings_tampered"] } });
  });
});
