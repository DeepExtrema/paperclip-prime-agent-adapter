// N0 e16: does pushing "prime_agent_local" into AI_CONNECTION_CAPABILITIES from the adapter side change what the host's
// isAiConnectionCompatible (called by select() in server/dist/services/ai-connections.js) reads? One Node process, both live paths.
// No Prime, no network. The adapter side resolves @paperclipai/shared through this worktree's node_modules link.
// Run with: node --experimental-import-meta-resolve scripts/n0/e16-registration.mjs (resolves as an ESM import from the server's dir).
import { pathToFileURL } from "node:url";

const APP = "/home/extremis/.paperclip/cli/installs/local/2026.1005.0-prime.reinstall.1/app";
const serverUrl = import.meta.resolve("@paperclipai/shared", pathToFileURL(`${APP}/server/dist/services/ai-connections.js`).href);
const host = await import(serverUrl);
const adapterSideUrl = import.meta.resolve("@paperclipai/shared/ai-connections");
const adapterSide = await import(adapterSideUrl);
const requirement = { provider: "anthropic", method: "subscription", mode: "responsible_user" };
const report = (label) => console.log(JSON.stringify({ label,
  hostArray: host.AI_CONNECTION_CAPABILITIES.anthropic.methods.subscription.adapters,
  hostApiKeyArray: host.AI_CONNECTION_CAPABILITIES.anthropic.methods.api_key.adapters,
  hostCompatible: host.isAiConnectionCompatible(requirement, "prime_agent_local", "anthropic/claude-opus-5-5"),
  hostCompatibleSubscriptionOnly: host.isAiConnectionCompatible({ provider: "anthropic", method: "subscription" }, "prime_agent_local", "anthropic/claude-opus-5-5"),
  hostCompatibleApiKeyOnly: host.isAiConnectionCompatible({ provider: "anthropic", method: "api_key" }, "prime_agent_local", "anthropic/claude-opus-5-5") }));
console.log(JSON.stringify({ serverResolved: serverUrl, adapterResolved: adapterSideUrl, sameObject: host.AI_CONNECTION_CAPABILITIES === adapterSide.AI_CONNECTION_CAPABILITIES }));
report("before");
const adapters = adapterSide.AI_CONNECTION_CAPABILITIES.anthropic.methods.subscription.adapters;
if (!adapters.includes("prime_agent_local")) adapters.push("prime_agent_local");
report("after adapter-side push");
