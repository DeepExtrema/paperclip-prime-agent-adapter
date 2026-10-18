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

function isSinglePathSegment(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

export const stagePrimeSkills: StagePrimeSkills = async (config) => {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desired = new Set(resolveLegacyPaperclipDesiredSkillNames(config, availableEntries));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-prime-skills-"));
  const skillDirs: string[] = [];
  const missing: string[] = [];
  try {
    for (const entry of availableEntries) {
      if (!desired.has(entry.key)) continue;
      if (isPaperclipSkillSourceMissing(entry)) {
        missing.push(entry.runtimeName);
        continue;
      }
      if (!isSinglePathSegment(entry.runtimeName)) {
        missing.push(`${entry.runtimeName} (unsafe runtime name: not a single path segment)`);
        continue;
      }
      const target = path.join(root, entry.runtimeName);
      await fs.symlink(entry.source, target);
      skillDirs.push(target);
    }
  } catch (err) {
    // R-27: the original error is thrown; a cleanup failure is attached as its cause only.
    const cleanupError = await fs.rm(root, { recursive: true, force: true }).then(() => null, (rmErr: unknown) => rmErr);
    if (cleanupError !== null && err instanceof Error && err.cause === undefined) err.cause = cleanupError;
    throw err;
  }
  const availableKeys = new Set(availableEntries.map((entry) => entry.key));
  for (const key of desired) if (!availableKeys.has(key)) missing.push(key);
  const cleanup = async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  };
  return { skillDirs, missing, cleanup };
};
