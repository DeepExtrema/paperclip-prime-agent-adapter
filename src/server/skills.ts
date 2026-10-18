// Owner: WP4. Contract: INTERFACES.md §9.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { notImplemented } from "../errors.js";
import { PRIME_ADAPTER_TYPE, type StagePrimeSkills } from "../types.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function buildPrimeSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const configuredDetail = "Passed to Prime with --skill on the next run.";
  return buildRuntimeMountedSkillSnapshot({ adapterType: PRIME_ADAPTER_TYPE, availableEntries, desiredSkills, configuredDetail });
}

export async function listPrimeSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildPrimeSkillSnapshot(ctx.config);
}

/** Ephemeral mode: nothing to write; stagePrimeSkills stages desired skills per run. */
export async function syncPrimeSkills(ctx: AdapterSkillContext, _desiredSkills: string[]): Promise<AdapterSkillSnapshot> {
  return buildPrimeSkillSnapshot(ctx.config);
}

export const stagePrimeSkills: StagePrimeSkills = async () => notImplemented("WP4", "stagePrimeSkills");
