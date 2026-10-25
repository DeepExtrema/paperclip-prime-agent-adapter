// Owner: WP0 (frozen). Root metadata; the plugin loader imports createServerAdapter from here.
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { PRIME_ADAPTER_LABEL, PRIME_ADAPTER_TYPE } from "./types.js";

export const type = PRIME_ADAPTER_TYPE;
export const label = PRIME_ADAPTER_LABEL;

/** Static list is empty; models come from `prime-agent model list` (listModels). */
export const models: AdapterModel[] = [];

export const agentConfigurationDoc = `# prime_agent_local agent configuration

Adapter: prime_agent_local (Prime Agent)

Use when:
- You want Paperclip to run Prime Agent (\`prime-agent\`) locally as the agent runtime
- You want Prime's Python REPL tool, skills and session resume across heartbeats

Don't use when:
- prime-agent 0.10.x is not installed on the Paperclip host
- You need containment: the agent runs as the Paperclip server user with no sandbox

Core fields:
- model (string, required): \`provider/model\` from \`prime-agent model list\` (for example anthropic/claude-haiku-4-5)
- thinking (string, optional): off, minimal, low, medium, high, xhigh, max
- cwd (string, optional): fallback absolute working directory
- instructionsFilePath (string, optional): instructions file appended to the system prompt
- promptTemplate (string, optional): user prompt template
- appendSystemPrompt (string, optional): extra text appended to the system prompt
- noContextFiles (boolean, optional): disable AGENTS.md / CLAUDE.md discovery
- command (string, optional): defaults to "prime-agent"
- env (object, optional): KEY=VALUE environment variables
- extraArgs (string[], optional): extra prime-agent arguments

Credentials:
- credentialMode "host_auth" (default): the host ~/.prime/agent/auth.json is symlinked into the agent's own Prime dir. Unsafe with Prime 0.10: a token refresh replaces the link and splits the login
- credentialMode "api_key": set apiKeyEnvVar to the env var (bound to a Paperclip secret) that holds the provider key. A Claude sk-ant-oat subscription token is billed as subscription. The variable is removed from Prime's own environment
- credentialMode "managed_subscription": the agent's Paperclip AI connection to the Claude subscription. Needs featureProfile "governed-v1", an anthropic/… model and allowedModels. auth.json is deleted after every run

Model allowlist:
- allowedModels (string[] of provider/modelId, optional): the adapter writes Prime's allowlist and model roles before every run, checks settings.json and auth.json after it, and audits each actor's model from Prime's session files (resultJson.modelAudit). Any breach fails the run
- modelRoles (object, optional, needs allowedModels): subagentDefaultModel, auxiliaryModel, providerBackupModel, imageModel → provider/modelId. Default: model

Feature profile:
- Optional \`featureProfile: "governed-v1"\` (needs \`allowedModels\`, \`runtime: "daemon"\`, \`thinking\`, and \`credentialMode\` \`managed_subscription\` or \`api_key\`): memory on; background refinement, factory, quota auto-resume, traces and telemetry off; \`rlmMaxDepth\` default 1; sessions per run capped by \`maxSubagentsPerRun\` (1–8, default 2); \`settings.json\` limited to an allowlist; agent-dir context files, the workspace's \`.prime/agent/\` (except one managed \`settings.json\` that stays), saved Prime schedules, goals not set by Paperclip, non-memory global harness entries and agent-installed skills disabled at run start; agent-dir files off an allowlist (such as \`models.json\`) moved aside; the parent's skill list limited to Paperclip skills and allowlisted built-ins and checked before the first prompt, and any other session that loads a skill off that list ended; the allowed models checked in the model catalog for the Anthropic address and for reasoning, before the first prompt and after each refresh, and the parent's thinking level checked before the first prompt; one run per agent at a time, and every process that the run leaves ended at run end. \`credentialMode: "managed_subscription"\` needs this profile.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (0 = none)
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Each agent gets its own Prime dir under the Paperclip company tree; memories, settings and sessions stay per agent.
- A listed model is not proof of account entitlement; only a run proves it.
`;

export { createServerAdapter } from "./server/index.js";
