// Owner: WP4. Contract: INTERFACES.md §8.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { runChildProcess, type RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import { notImplemented, PrimeCliError } from "../errors.js";
import {
  PRIME_DEFAULT_COMMAND,
  type DetectPrimeModel,
  type EphemeralPrimeAgentDir,
  type ListPrimeModels,
  type ParsePrimeModelList,
  type PrimeModelRow,
} from "../types.js";
import { buildPrimeChildEnv, createEphemeralPrimeAgentDir, seedPrimeAgentDir } from "./runtime-config.js";

export const parsePrimeModelList: ParsePrimeModelList = (stdout) => {
  const rows: PrimeModelRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trimEnd().split(/\s{2,}/);
    if (cols.length !== 6 || (cols[0] === "provider" && cols[1] === "model")) continue;
    const [provider, model, context, maxOut, thinking, images] = cols as [string, string, string, string, string, string];
    rows.push({ provider, model, id: `${provider}/${model}`, context, maxOut, thinking: thinking === "yes", images: images === "yes" });
  }
  return rows;
};

const MODEL_LIST_TIMEOUT_SEC = 20;
const MODEL_LIST_GRACE_SEC = 3;
const firstNonEmptyLine = (text: string): string => text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";

function toAdapterModels(rows: PrimeModelRow[]): AdapterModel[] {
  const ids = [...new Set(rows.map((row) => row.id))];
  ids.sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
  return ids.map((id) => ({ id, label: id }));
}

/** Uncached `<command> model list`. Throws PrimeCliError. */
async function discoverPrimeModels({ command, env, cwd }: Parameters<ListPrimeModels>[0]): Promise<AdapterModel[]> {
  const agentDir = env.PRIME_AGENT_CODING_AGENT_DIR;
  if (!agentDir || !path.isAbsolute(agentDir)) {
    throw new PrimeCliError("prime_model_list_failed", "listPrimeModels requires env.PRIME_AGENT_CODING_AGENT_DIR set to an absolute per-agent or ephemeral agent dir.");
  }
  let result: RunProcessResult;
  try {
    // A8: env goes through unchanged, undefined entries included. runChildProcess merges process.env under it,
    // then deletes keys whose value is undefined; its declared opts.env type omits undefined, hence the cast.
    const runId = `prime-models-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    result = await runChildProcess(runId, command, ["model", "list"], { cwd, env: env as Record<string, string>, timeoutSec: MODEL_LIST_TIMEOUT_SEC, graceSec: MODEL_LIST_GRACE_SEC, onLog: async () => {} });
  } catch (err) {
    throw new PrimeCliError("prime_cli_missing", `Cannot run \`${command}\`: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (result.timedOut) {
    throw new PrimeCliError("prime_model_list_failed", `\`${command} model list\` timed out after ${MODEL_LIST_TIMEOUT_SEC} s.`);
  }
  const exitCode = result.exitCode ?? 1;
  if (exitCode !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new PrimeCliError("prime_model_list_failed", `\`${command} model list\` failed (exit ${exitCode})${detail ? `: ${detail}` : "."}`);
  }
  return toAdapterModels(parsePrimeModelList(result.stdout));
}

export const listPrimeModels: ListPrimeModels = (input) => discoverPrimeModels(input);

/** ServerAdapterModule.listModels: host-credential ephemeral agent dir; [] on any failure. */
export async function listPrimeModelsForAdapter(): Promise<AdapterModel[]> {
  return notImplemented("WP4", "listPrimeModelsForAdapter");
}

/** ServerAdapterModule.refreshModels: as listPrimeModelsForAdapter, bypassing the cache. */
export async function refreshPrimeModelsForAdapter(): Promise<AdapterModel[]> {
  return notImplemented("WP4", "refreshPrimeModelsForAdapter");
}

/** A9: throws PrimeCliError("prime_model_unknown") when modelRef is not in models. */
export function assertPrimeModelListed(_modelRef: string, _models: AdapterModel[]): void {
  return notImplemented("WP4", "assertPrimeModelListed");
}

export const detectPrimeModel: DetectPrimeModel = async () => notImplemented("WP4", "detectPrimeModel");

/** ServerAdapterModule.detectModel: detectPrimeModel(<os.homedir()>/.prime/agent). */
export async function detectPrimeModelForAdapter(): ReturnType<DetectPrimeModel> {
  return notImplemented("WP4", "detectPrimeModelForAdapter");
}
