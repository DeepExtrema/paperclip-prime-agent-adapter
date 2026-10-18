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
- credentialMode "host_auth" (default): the host ~/.prime/agent/auth.json is symlinked into the agent's own Prime dir
- credentialMode "api_key": set apiKeyEnvVar to the env var (bound to a Paperclip secret) that holds the provider key

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (0 = none)
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Each agent gets its own Prime dir under the Paperclip company tree; memories, settings and sessions stay per agent.
- A listed model is not proof of account entitlement; only a run proves it.
`;

export { createServerAdapter } from "./server/index.js";
