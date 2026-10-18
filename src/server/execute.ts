// Owner: WP3. Contract: INTERFACES.md §5 and §11. Reference: pi-local src/server/execute.ts.
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { adapterExecutionTargetIsRemote, describeAdapterExecutionTarget, readAdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  asString, buildInvocationEnvForLogs, buildPaperclipEnv, buildRuntimeToolsEnv, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE, ensureAbsoluteDirectory, isPaperclipRecoveryWakePayload, joinPromptSections,
  parseObject, readPaperclipIssueWorkModeFromContext, refreshPaperclipWorkspaceEnvForExecution, renderTemplate, resolveCommandForLogs,
  resolvePaperclipInstanceRootForAdapter, runChildProcess, selectInitialCommunicationGuidance, selectPaperclipPromptSections,
  type RunProcessResult,
} from "@paperclipai/adapter-utils/server-utils";
import { PrimeCliError } from "../errors.js";
import {
  PRIME_ADAPTER_TYPE, PRIME_SUPPORTED_VERSION_RANGE, type BuildPrimeArgs, type ParsedPrimeOutput, type PrimeRuntimeConfig,
  type PrimeSessionParams, type SeededPrimeAgentDir, type StagedPrimeSkills,
} from "../types.js";
import { assertPrimeModelListed, listPrimeModels } from "./models.js";
import { isPrimeUnknownSessionError, parsePrimeJsonl } from "./parse.js";
import { buildPrimeChildEnv, resolvePrimeRuntimeConfig, seedPrimeAgentDir } from "./runtime-config.js";
import { decidePrimeResume, primeSessionCodec, readPrimeSessionHeader } from "./session.js";
import { stagePrimeSkills } from "./skills.js";
import { isSupportedPrimeVersion, readPrimeVersion } from "./version.js";
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
/** childEnv: §16 A8, stripped inherited keys are present as undefined; it reaches runChildProcess unchanged. paperclipEnv: A18 onMeta keys. */
type PreparedRun = {
  runtime: PrimeRuntimeConfig; cwd: string; paperclipEnv: Record<string, string>; childEnv: Record<string, string | undefined>;
  seeded: SeededPrimeAgentDir; skills: StagedPrimeSkills; deadlineMs: number | null;
};
type Attempt = { proc: RunProcessResult; parsed: ParsedPrimeOutput };
type SystemPrompt = { text: string; notes: string[]; ownsDefaultPolicy: boolean };
const firstNonEmptyLine = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
const nonEmpty = (value: unknown) => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);
/** pi-local execute.ts 247-331: cwd and the Paperclip run env. */
async function buildPaperclipRunEnv(ctx: AdapterExecutionContext, runtime: PrimeRuntimeConfig) {
  const { agent, context, runId } = ctx;
  const workspace = parseObject(context.paperclipWorkspace);
  const [workspaceCwd, workspaceSource, configuredCwd] = [asString(workspace.cwd, ""), asString(workspace.source, ""), runtime.cwd ?? ""];
  const effectiveWorkspaceCwd = workspaceSource === "agent_home" && configuredCwd ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const env: Record<string, string> = { ...buildPaperclipEnv(agent), ...buildRuntimeToolsEnv(ctx.runtimeTools), PAPERCLIP_RUN_ID: runId };
  const linkedIssueIds = Array.isArray(context.issueIds) ? context.issueIds.filter((id): id is string => nonEmpty(id) !== null) : [];
  const runVars: Array<[string, string | null]> = [
    ["PAPERCLIP_TASK_ID", nonEmpty(context.taskId) ?? nonEmpty(context.issueId)], ["PAPERCLIP_ISSUE_WORK_MODE", readPaperclipIssueWorkModeFromContext(context)],
    ["PAPERCLIP_WAKE_REASON", nonEmpty(context.wakeReason)], ["PAPERCLIP_WAKE_COMMENT_ID", nonEmpty(context.wakeCommentId) ?? nonEmpty(context.commentId)],
    ["PAPERCLIP_APPROVAL_ID", nonEmpty(context.approvalId)], ["PAPERCLIP_APPROVAL_STATUS", nonEmpty(context.approvalStatus)],
    ["PAPERCLIP_LINKED_ISSUE_IDS", linkedIssueIds.length > 0 ? linkedIssueIds.join(",") : null],
  ];
  for (const [key, value] of runVars) if (value) env[key] = value;
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter((hint): hint is Record<string, unknown> => typeof hint === "object" && hint !== null)
    : [];
  refreshPaperclipWorkspaceEnvForExecution({
    env, envConfig: parseObject(ctx.config.env), workspaceCwd: effectiveWorkspaceCwd, workspaceSource,
    workspaceId: asString(workspace.workspaceId, ""), workspaceRepoUrl: asString(workspace.repoUrl, ""),
    workspaceRepoRef: asString(workspace.repoRef, ""), workspaceHints, agentHome: asString(workspace.agentHome, ""),
    executionTargetIsRemote: false, executionCwd: cwd,
  });
  if (ctx.authToken) env.PAPERCLIP_API_KEY = ctx.authToken;
  return { cwd, env };
}
/** errorMeta.primeErrorCode: the `code` of any adapter error class (codes start with "prime_"), else null. */
function preflightFailure(err: unknown): AdapterExecutionResult {
  const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
  const primeErrorCode = typeof code === "string" && code.startsWith("prime_") ? code : null;
  const errorMessage = err instanceof Error ? err.message : String(err);
  return { exitCode: 1, signal: null, timedOut: false, errorCode: "prime_preflight_failed", errorMessage, errorMeta: { primeErrorCode }, clearSession: false };
}
/** INTERFACES §11.3: every step before spawn. */
async function prepareRun(ctx: AdapterExecutionContext, startedAtMs: number): Promise<PreparedRun> {
  const target = readAdapterExecutionTarget({ executionTarget: ctx.executionTarget, legacyRemoteExecution: ctx.executionTransport?.remoteExecution });
  if (adapterExecutionTargetIsRemote(target)) {
    throw new Error(`prime_agent_local runs only on the local Paperclip host in phase 1; refusing ${describeAdapterExecutionTarget(target)}.`);
  }
  const runtime = resolvePrimeRuntimeConfig(ctx.config, ctx.agent, resolvePaperclipInstanceRootForAdapter());
  const { cwd, env: paperclipEnv } = await buildPaperclipRunEnv(ctx, runtime);
  const { env: childEnv } = buildPrimeChildEnv(process.env, runtime.agentDir, paperclipEnv);
  const seeded = await seedPrimeAgentDir(runtime.agentDir, { provider: runtime.provider, env: paperclipEnv });
  const skills = await stagePrimeSkills(ctx.config);
  const deadlineMs = runtime.timeoutSec > 0 ? startedAtMs + runtime.timeoutSec * 1000 : null;
  return { runtime, cwd, paperclipEnv, childEnv, seeded, skills, deadlineMs };
}
/** pi-local execute.ts 574-635 (system prompt part). */
async function buildSystemPrompt(ctx: AdapterExecutionContext, runtime: PrimeRuntimeConfig, cwd: string): Promise<SystemPrompt> {
  const defaultTemplate = ctx.context.conversationMode === true ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE;
  const data = templateData(ctx);
  const text = renderTemplate(runtime.promptTemplate ?? defaultTemplate, data);
  const fallback: SystemPrompt = { text, notes: [], ownsDefaultPolicy: runtime.promptTemplate === null };
  if (!runtime.instructionsFilePath) return fallback;
  const file = path.resolve(cwd, runtime.instructionsFilePath);
  const dir = `${path.dirname(runtime.instructionsFilePath)}/`;
  try {
    const contents = await fs.readFile(file, "utf8");
    const withNote = `${contents}\n\nThe above agent instructions were loaded from ${file}. Resolve any relative file references from ${dir}.\n\n${defaultTemplate}`;
    const notes = [`Loaded agent instructions from ${file}`, `Appended instructions + path directive to system prompt (relative references from ${dir}).`];
    return { text: renderTemplate(withNote, data), notes, ownsDefaultPolicy: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await ctx.onLog("stdout", `[paperclip] Warning: could not read agent instructions file "${file}": ${reason}\n`);
    return { ...fallback, notes: [`Configured instructionsFilePath ${file}, but file could not be read; continuing without injected instructions.`] };
  }
}
function templateData({ agent, runId, context }: AdapterExecutionContext): Record<string, unknown> {
  return { agentId: agent.id, companyId: agent.companyId, runId, company: { id: agent.companyId }, agent, run: { id: runId, source: "on_demand" }, context };
}
/** pi-local execute.ts 663-689 (user prompt part). */
function buildUserPrompt(ctx: AdapterExecutionContext, runtime: PrimeRuntimeConfig, ownsDefaultPolicy: boolean, resumed: boolean): string {
  const { context } = ctx;
  const sections = selectPaperclipPromptSections(context, {
    resumedSession: resumed, includeCommunicationGuidance: false, includeExecutionContract: ownsDefaultPolicy ? false : undefined,
  });
  const bootstrap = !resumed && runtime.bootstrapPromptTemplate ? renderTemplate(runtime.bootstrapPromptTemplate, templateData(ctx)).trim() : "";
  const skipHeartbeat = (resumed && sections.wakePrompt.length > 0) || isPaperclipRecoveryWakePayload(context.paperclipWake);
  const heartbeat = skipHeartbeat || runtime.promptTemplate === null ? "" : renderTemplate(runtime.promptTemplate, templateData(ctx));
  return joinPromptSections([
    selectInitialCommunicationGuidance(context, { resumedSession: resumed }),
    joinPromptSections([bootstrap, sections.wakePrompt, sections.taskContextNote, asString(context.paperclipSessionHandoffMarkdown, "").trim(), heartbeat]),
  ]);
}
/** pi-local execute.ts 714-753: stdout reaches onLog as whole lines; stderr passes through. */
function lineBufferedLog(onLog: AdapterExecutionContext["onLog"]) {
  let buffer = "";
  const flush = async () => {
    if (buffer) await onLog("stdout", buffer);
    buffer = "";
  };
  return { flush, onLog: async (stream: "stdout" | "stderr", chunk: string) => {
    if (stream === "stderr") return onLog(stream, chunk);
    const lines = (buffer + chunk).split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line) await onLog(stream, `${line}\n`);
  } };
}
async function runAttempt(ctx: AdapterExecutionContext, prep: PreparedRun, system: SystemPrompt, notes: string[], resumeSessionFile: string | null): Promise<Attempt> {
  const { runtime, cwd } = prep;
  const prompt = buildUserPrompt(ctx, runtime, system.ownsDefaultPolicy, resumeSessionFile !== null);
  const args = buildPrimeArgs({
    provider: runtime.provider, model: runtime.model, thinking: runtime.thinking, cwd, sessionDir: runtime.agentDir.sessionDir,
    resumeSessionFile, skillDirs: prep.skills.skillDirs, appendSystemPrompts: [system.text, runtime.appendSystemPrompt ?? ""],
    noContextFiles: runtime.noContextFiles, extraArgs: runtime.extraArgs, prompt,
  });
  const resolvedCommand = await resolveCommandForLogs(runtime.command, cwd, prep.childEnv);
  const runtimeEnv = Object.fromEntries(Object.entries(prep.childEnv).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const loggedKeys = new Set([...Object.keys(prep.paperclipEnv), "PRIME_AGENT_CODING_AGENT_DIR", "PRIME_AGENT_TELEMETRY"]); // A18
  const loggedEnv = Object.fromEntries(Object.entries(runtimeEnv).filter(([key]) => loggedKeys.has(key)));
  await ctx.onMeta?.({
    adapterType: PRIME_ADAPTER_TYPE, command: resolvedCommand, cwd, commandNotes: notes, commandArgs: args,
    env: buildInvocationEnvForLogs(loggedEnv, { runtimeEnv, includeRuntimeKeys: ["HOME"], resolvedCommand }),
    prompt, promptMetrics: { systemPromptChars: system.text.length, promptChars: prompt.length }, context: ctx.context,
  });
  const lines = lineBufferedLog(ctx.onLog);
  const proc = await runChildProcess(ctx.runId, runtime.command, args, {
    cwd,
    env: prep.childEnv as Record<string, string>, // INTERFACES §16 A8: runChildProcess deletes undefined keys after merging process.env
    timeoutSec: prep.deadlineMs === null ? 0 : Math.max(0.001, (prep.deadlineMs - Date.now()) / 1000),
    graceSec: runtime.graceSec,
    onLog: lines.onLog,
    onSpawn: ctx.onSpawn,
  });
  await lines.flush();
  return { proc, parsed: parsePrimeJsonl(proc.stdout) };
}
/** INTERFACES §11.7. Failed, uncertain, timed-out and cancelled runs carry no session fields. */
function mapResult(attempt: Attempt, prep: PreparedRun, clearSession: boolean): AdapterExecutionResult {
  const { proc, parsed } = attempt;
  const { runtime, seeded } = prep;
  const usage = parsed.usage;
  const base: AdapterExecutionResult = {
    exitCode: proc.exitCode, signal: proc.signal, timedOut: false,
    provider: runtime.provider, model: runtime.modelRef, biller: runtime.provider, billingType: seeded.billingType,
    ...(usage ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens } } : {}),
    usageBasis: "per_run",
    costUsd: seeded.billingType === "api" && usage !== null && usage.reportedCostUsd > 0 ? usage.reportedCostUsd : null,
    resultJson: { stdout: proc.stdout, stderr: proc.stderr, cacheWriteTokens: usage?.cacheWriteTokens ?? null, totalTokens: usage?.totalTokens ?? null },
    clearSession,
  };
  const failedExitCode = proc.exitCode !== null && proc.exitCode !== 0 ? proc.exitCode : 1;
  if (proc.timedOut) {
    return { ...base, timedOut: true, errorCode: "prime_run_timeout", errorMessage: `Timed out after ${runtime.timeoutSec}s` };
  }
  if (!parsed.sawAgentEnd) {
    const how = `exit ${proc.exitCode ?? "none"}, signal ${proc.signal ?? "none"}`;
    const stderrLine = firstNonEmptyLine(proc.stderr);
    const message = `prime-agent ended without an agent_end event (${how}); the run outcome is uncertain.${stderrLine ? ` stderr: ${stderrLine}` : ""}`;
    return { ...base, exitCode: failedExitCode, errorCode: "prime_run_uncertain", errorMessage: message };
  }
  if (parsed.errors.length > 0 || proc.exitCode !== 0) {
    const message = parsed.errors[0] ?? (firstNonEmptyLine(proc.stderr) || `prime-agent exited with code ${proc.exitCode}`);
    return { ...base, exitCode: failedExitCode, errorCode: "prime_run_failed", errorMessage: message };
  }
  const sessionId = clearSession ? null : parsed.sessionId;
  const sessionParams: PrimeSessionParams | null = sessionId
    ? { sessionId, sessionFile: path.join(runtime.agentDir.sessionDir, `${sessionId}.jsonl`), cwd: prep.cwd,
        provider: runtime.provider, model: runtime.model, agentDir: runtime.agentDir.agentDir }
    : null;
  const session = sessionParams ? { sessionId, sessionParams: { ...sessionParams }, sessionDisplayId: sessionId } : {};
  return { ...base, exitCode: 0, errorCode: null, errorMessage: null, ...session, summary: parsed.finalMessage };
}
async function runPrime(ctx: AdapterExecutionContext, prep: PreparedRun): Promise<AdapterExecutionResult> {
  const { runtime, cwd } = prep;
  const system = await buildSystemPrompt(ctx, runtime, cwd);
  const notes = [...prep.seeded.notes, ...system.notes];
  const saved = primeSessionCodec.deserialize(ctx.runtime.sessionParams) as PrimeSessionParams | null;
  const header = saved ? await readPrimeSessionHeader(saved.sessionFile) : null;
  const decision = decidePrimeResume({
    saved,
    current: { cwd, provider: runtime.provider, model: runtime.model, agentDir: runtime.agentDir.agentDir },
    header,
  });
  if (saved && !decision.resume) {
    await ctx.onLog(
      "stdout",
      `[paperclip] Prime session "${saved.sessionId}" will not be resumed (${decision.reason}); starting a fresh session.\n`,
    );
  }
  const resumeSessionFile = decision.resume ? decision.sessionFile : null;
  const first = await runAttempt(ctx, prep, system, notes, resumeSessionFile);
  const firstFailed = !first.proc.timedOut && (first.proc.exitCode !== 0 || first.parsed.errors.length > 0);
  if (saved && resumeSessionFile !== null && firstFailed && isPrimeUnknownSessionError(first.proc.stdout, first.proc.stderr)) {
    await ctx.onLog("stdout", `[paperclip] Prime session "${saved.sessionId}" is unavailable; retrying with a fresh session.\n`);
    return mapResult(await runAttempt(ctx, prep, system, notes, null), prep, true);
  }
  return mapResult(first, prep, false);
}
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const startedAtMs = Date.now();
  let prep: PreparedRun;
  try {
    prep = await prepareRun(ctx, startedAtMs);
  } catch (err) {
    return preflightFailure(err);
  }
  try {
    return await runPrime(ctx, prep);
  } finally {
    await prep.skills.cleanup();
  }
}
