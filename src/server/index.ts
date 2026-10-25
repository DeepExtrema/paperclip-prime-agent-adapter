// Owner: WP0 (frozen). Wires the server module the Paperclip plugin loader requires.
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { agentConfigurationDoc, models, type } from "../index.js";
import { getPrimeConfigSchema } from "./config-schema.js";
import { execute } from "./execute.js";
import "./managed-connection.js"; // TAI-273 §3.2: registers prime_agent_local for the anthropic subscription connection at load
import {
  detectPrimeModelForAdapter,
  listPrimeModelsForAdapter,
  refreshPrimeModelsForAdapter,
} from "./models.js";
import { primeSessionCodec } from "./session.js";
import { listPrimeSkills, syncPrimeSkills } from "./skills.js";
import { testEnvironment } from "./test.js";

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    listSkills: listPrimeSkills,
    syncSkills: syncPrimeSkills,
    sessionCodec: primeSessionCodec,
    models,
    listModels: listPrimeModelsForAdapter,
    refreshModels: refreshPrimeModelsForAdapter,
    detectModel: detectPrimeModelForAdapter,
    getConfigSchema: getPrimeConfigSchema,
    agentConfigurationDoc,
    runtimeToolDelivery: "environment",
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: true,
  };
}

export { execute, buildPrimeArgs } from "./execute.js";
export { testEnvironment } from "./test.js";
export { parsePrimeJsonl, isPrimeUnknownSessionError } from "./parse.js";
export { primeSessionCodec, readPrimeSessionHeader, decidePrimeResume } from "./session.js";
export {
  parsePrimeModelList,
  listPrimeModels,
  listPrimeModelsForAdapter,
  refreshPrimeModelsForAdapter,
  detectPrimeModel,
  detectPrimeModelForAdapter,
} from "./models.js";
export { listPrimeSkills, syncPrimeSkills, stagePrimeSkills } from "./skills.js";
export { readPrimeVersion, isSupportedPrimeVersion } from "./version.js";
export {
  resolvePrimeRuntimeConfig,
  seedPrimeAgentDir,
  createEphemeralPrimeAgentDir,
  buildPrimeChildEnv,
} from "./runtime-config.js";
export { getPrimeConfigSchema } from "./config-schema.js";
