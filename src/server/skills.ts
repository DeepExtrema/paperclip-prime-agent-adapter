// Owner: WP4. Contract: INTERFACES.md §9. Replace the stub bodies; keep the typed exports.
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import { notImplemented } from "../errors.js";
import type { StagePrimeSkills } from "../types.js";

export async function listPrimeSkills(_ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return notImplemented("WP4", "listPrimeSkills");
}

export async function syncPrimeSkills(
  _ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return notImplemented("WP4", "syncPrimeSkills");
}

export const stagePrimeSkills: StagePrimeSkills = async () => notImplemented("WP4", "stagePrimeSkills");
