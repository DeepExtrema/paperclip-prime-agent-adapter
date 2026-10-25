// TAI-273 plan rev 7 §2.2 (G6): featureProfile "governed-v1", items 1-9 and the model-audit fix. Items 10-12 are separate.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "../src/server/execute.js";
import { resolvePrimeFeatureProfile } from "../src/server/feature-profile.js";

const FAKE = fileURLToPath(new URL("./fake-prime-daemon.mjs", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const MODEL = "anthropic/claude-haiku-4-5";
const KEY = "sk-ant-api03-FIXTURE-governed-not-real";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const savedEnv = { ...process.env };
let root = "";
type Rec = { kind: string; env?: Record<string, string>; command?: Record<string, unknown> & { type: string } };
const rec = () => path.join(root, "daemon.jsonl");
const records = (): Rec[] => (existsSync(rec()) ? readFileSync(rec(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Rec) : []);
const commands = () => records().filter((r) => r.kind === "command").map((r) => r.command!);
const types = () => commands().map((c) => c.type);
const ws = () => path.join(root, "ws");
const agentDir = () => path.join(root, "agents", "agent-1", "prime-agent-home");
const disabled = (...parts: string[]) => path.join(agentDir(), ".paperclip-disabled", "run-1", ...parts);
const settings = () => JSON.parse(readFileSync(path.join(agentDir(), "settings.json"), "utf8")) as Record<string, unknown>;
const write = (file: string, content: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); };
const GOVERNED = { featureProfile: "governed-v1", credentialMode: "api_key", apiKeyEnvVar: "ANTHROPIC_API_KEY", allowedModels: [MODEL] };
type Over = { config?: Record<string, unknown>; env?: Record<string, string>; sessionParams?: Record<string, unknown> | null; runId?: string };
async function run(over: Over = {}) {
  const logs: string[] = [];
  const ctx: AdapterExecutionContext = {
    runId: over.runId ?? "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Prime Tester", adapterType: "prime_agent_local", adapterConfig: {} },
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
  };
  const result = await execute(ctx);
  return { result, logs, log: logs.join(""), report: (result.resultJson as { featureProfile?: Record<string, any> } | undefined)?.featureProfile! };
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
  const input = { runtime: "daemon" as const, credentialMode: "api_key", allowedModels: [MODEL], rlmMaxDepth: null };
  it("is closed: one value, its three rules and maxSubagentsPerRun 1-8 (default 2), rlmMaxDepth default 1", () => {
    expect(resolvePrimeFeatureProfile({}, input)).toBeNull();
    expect(resolvePrimeFeatureProfile({ featureProfile: "governed-v1" }, input)).toEqual({ profile: "governed-v1", maxSubagentsPerRun: 2, rlmMaxDepth: 1 });
    expect(resolvePrimeFeatureProfile({ featureProfile: "governed-v1", maxSubagentsPerRun: "8" }, { ...input, rlmMaxDepth: 0 }))
      .toEqual({ profile: "governed-v1", maxSubagentsPerRun: 8, rlmMaxDepth: 0 });
    for (const [config, over] of [
      [{ maxSubagentsPerRun: 2 }, {}], [{ featureProfile: "governed-v2" }, {}], [{ featureProfile: "governed-v1" }, { allowedModels: null }],
      [{ featureProfile: "governed-v1" }, { runtime: "print" }], [{ featureProfile: "governed-v1" }, { credentialMode: "host_auth" }],
      [{ featureProfile: "governed-v1", maxSubagentsPerRun: 0 }, {}], [{ featureProfile: "governed-v1", maxSubagentsPerRun: 9 }, {}],
      [{ featureProfile: "governed-v1", maxSubagentsPerRun: 1.5 }, {}],
    ] as const) {
      expect(() => resolvePrimeFeatureProfile(config, { ...input, ...over } as typeof input)).toThrowError(expect.objectContaining({ code: "prime_feature_profile_invalid" }));
    }
  });
  it("fails before any file is written", async () => {
    const { result } = await run({ config: { credentialMode: undefined, apiKeyEnvVar: undefined } });
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
      allowedModels: [MODEL],
    });
    expect(commands()).toContainEqual(expect.objectContaining({ type: "set_rlm_max_depth", maxDepth: 1 }));
    const env = records().find((r) => r.kind === "start")!.env!;
    expect([env.DO_NOT_TRACK, env.PRIME_AGENT_TELEMETRY]).toEqual(["1", "0"]);
    expect(env).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(report).toMatchObject({ profile: "governed-v1", maxSubagentsPerRun: 2, sessions: 0, sessionsEnded: [], skillDiscovery: "on",
      settingsKeysRemoved: [], contextFilesDisabled: [], projectConfigDisabled: [], agentDirDisabled: [], foreignGoals: [],
      harnessEntriesDisabled: [], agentSkills: [], agentSkillsDisabled: [], scheduledJobsDisabled: 0, scheduledJobsCreated: 0,
      cachesCleared: [], modelCatalog: null, warnings: [] });
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
    expect(existsSync(path.join(ws(), ".prime", "agent"))).toBe(false);
    expect(existsSync(path.join(ws(), ".prime", "agent.disabled-run-1", "SYSTEM.md"))).toBe(true);
  });
  it("moves a .prime link as a link and never touches its target", async () => {
    const outside = path.join(root, "outside");
    write(path.join(outside, "agent", "SYSTEM.md"), "x");
    symlinkSync(outside, path.join(ws(), ".prime"));
    await run();
    expect(readlinkSync(path.join(ws(), ".prime.disabled-run-1"))).toBe(outside);
    expect(readFileSync(path.join(outside, "agent", "SYSTEM.md"), "utf8")).toBe("x");
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
    expect(report.sessionsEnded).toHaveLength(1);
    expect(log).toContain(`[paperclip] session limit 1 reached; ended session ${report.sessionsEnded[0]}`);
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
  it("leaves a goal that matches adapterConfig.goal alone", async () => {
    const first = await run({ config: { goal: "Ship it" } });
    appendFileSync(String(first.result.sessionParams!.sessionFile), goal("Ship it"));
    const second = await run({ runId: "run-2", config: { goal: "Ship it" }, sessionParams: first.result.sessionParams! });
    expect(second.report.foreignGoals).toEqual([]);
    expect(commands().some((c) => c.message === "/goal clear")).toBe(false);
  });
});

describe("result shape", () => {
  it("adds featureProfile only under governed-v1", async () => {
    const plain = await run({ config: { featureProfile: undefined } });
    expect(plain.result.resultJson).not.toHaveProperty("featureProfile");
    const governed: AdapterExecutionResult = (await run({ runId: "run-2" })).result;
    expect(Object.keys((governed.resultJson as { featureProfile: object }).featureProfile).sort()).toEqual([
      "agentDirDisabled", "agentSkills", "agentSkillsDisabled", "cachesCleared", "contextFilesCreated", "contextFilesDisabled", "foreignGoals",
      "harnessBytes", "harnessEntriesDisabled", "harnessFingerprint", "maxSubagentsPerRun", "modelCatalog", "profile", "projectConfigCreated",
      "projectConfigDisabled", "refinementEvents", "scheduledJobsCreated", "scheduledJobsDisabled", "sessions", "sessionsEnded", "settingsKeysRemoved",
      "skillDiscovery", "warnings", "workspaceContextFiles",
    ]);
    expect(lstatSync(path.join(agentDir(), ".paperclip-disabled")).isDirectory()).toBe(true);
  });
});
