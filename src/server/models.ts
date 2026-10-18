// Owner: WP4. Contract: INTERFACES.md §8. Replace the stub bodies; keep the typed exports.
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { notImplemented } from "../errors.js";
import type { DetectPrimeModel, ListPrimeModels, ParsePrimeModelList } from "../types.js";

export const parsePrimeModelList: ParsePrimeModelList = () => notImplemented("WP4", "parsePrimeModelList");

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
