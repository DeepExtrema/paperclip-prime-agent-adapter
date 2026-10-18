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

/** Cached (60 s) `prime-agent model list` in the given agent dir. Throws PrimeCliError. */
export const listPrimeModels: ListPrimeModels = async () => notImplemented("WP4", "listPrimeModels");

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
