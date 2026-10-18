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
        hint: "host_auth links the host ~/.prime/agent/auth.json into this agent's own Prime dir." },
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
    ],
  };
}
