// Owner: WP6. Contract: INTERFACES.md §12.
import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { PRIME_THINKING_LEVELS } from "../types.js";

export function getPrimeConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      { key: "credentialMode", label: "Credential mode", type: "select", default: "host_auth",
        options: [
          { value: "host_auth", label: "Host Prime login (auth.json symlink)" },
          { value: "api_key", label: "API key from an environment variable" },
        ],
        hint: "host_auth links the host ~/.prime/agent/auth.json into this agent's own Prime dir. Unsafe with Prime 0.10: a token refresh splits the login. Prefer api_key." },
      { key: "apiKeyEnvVar", label: "API key environment variable", type: "text",
        hint: "Name of the env var (bind it to a Paperclip secret) that holds the provider key. Never the key itself.",
        meta: { visibleWhen: { key: "credentialMode", values: ["api_key"] } } },
      { key: "thinking", label: "Thinking level", type: "select", default: "",
        options: [{ value: "", label: "Prime default" }, ...PRIME_THINKING_LEVELS.map((level) => ({ value: level, label: level }))],
        hint: "Passed as --thinking. Prime default passes no flag." },
      { key: "appendSystemPrompt", label: "Append system prompt", type: "textarea",
        hint: "Extra text passed with --append-system-prompt." },
      { key: "noContextFiles", label: "Disable context files", type: "toggle", default: false,
        hint: "Adds --no-context-files (no AGENTS.md / CLAUDE.md discovery)." },
      { key: "agentDirRoot", label: "Agent dir root", type: "text",
        hint: "Absolute path. Default: <instance>/companies/<companyId>/agents." },
      { key: "runtime", label: "Prime runtime", type: "select", default: "print", options: [{ value: "print", label: "Print (one prime-agent -p per run)" }, { value: "daemon", label: "Daemon (one Prime daemon per run: subagents, goals, autonomy)" }], hint: "daemon starts a Prime daemon for each run and stops it when the run ends." },
      { key: "goal", label: "Goal", type: "textarea", hint: "Seeds a Prime goal for a new session (daemon runtime)." },
      { key: "goalTokenBudget", label: "Goal token budget", type: "text", hint: "Positive token budget for the goal." },
      { key: "autonomous", label: "Autonomous mode", type: "toggle", default: false, hint: "Prime continues until its gates pass or a limit is reached (daemon runtime)." },
      { key: "autonomousMaxTurns", label: "Autonomous max turns", type: "text" },
      { key: "autonomousMaxTokens", label: "Autonomous max tokens", type: "text" },
      { key: "autonomousMaxContinuations", label: "Autonomous max continuations", type: "text" },
      { key: "autonomousTimeoutMs", label: "Autonomous timeout (ms)", type: "text" },
      { key: "autonomousGates", label: "Autonomous gate commands", type: "textarea", hint: "One shell command per line." },
      { key: "autonomousGateRetries", label: "Gate retries", type: "text" },
      { key: "autonomousGateTimeoutMs", label: "Gate timeout (ms)", type: "text" },
      { key: "rlmMaxDepth", label: "Subagent max depth", type: "text", hint: "rlm.spawn depth limit for this agent's sessions." },
      { key: "subagentDefaultModel", label: "Subagent default model", type: "text", hint: "provider/modelId used when rlm.spawn pins no model." },
      { key: "allowedModels", label: "Allowed models", type: "textarea",
        hint: "One provider/modelId per line. When set, the adapter writes Prime's allowlist and model roles before every run, checks settings.json and auth.json after it, and fails the run if any actor used another model. modelRoles is set through the API." },
    ],
  };
}
