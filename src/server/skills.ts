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

/** Prime 0.10.1's built-in skills (plan F10). A Paperclip skill with one of these names would replace the built-in (N0 item 2). */
export const PRIME_BUILTIN_SKILL_NAMES = [
  "agent-message", "agent-observe", "attach-image", "compact", "edit", "factory", "goal", "mcp", "prime-intellect", "refine",
  "rlm-heartbeat", "skill-creator", "websearch",
] as const;
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** `name` from the SKILL.md frontmatter, or null when there is none. */
export async function readPrimeSkillName(source: string): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(source, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const match = /^name\s*:\s*(.*)$/.exec(line);
    if (match) return match[1]!.trim().replace(/^(["'])(.*)\1$/, "$2").trim() || null;
  }
  return null;
}

type NamedEntry = { key: string; runtimeName: string; source: string };
/**
 * TAI-273 §4.1 (G1): the dir name each skill is staged under. Prime needs a skill's name to equal its dir name, so the
 * frontmatter name is used. The runtime name is kept, with one `[paperclip]` line, when the name is missing or invalid,
 * when two skills share it, or when it is a Prime built-in name.
 */
export async function planPrimeSkillNames(entries: NamedEntry[]): Promise<{ names: Map<string, string>; logLines: string[] }> {
  const names = new Map<string, string>();
  const logLines: string[] = [];
  const counts = new Map<string, number>();
  const frontmatter = new Map<string, string | null>();
  for (const entry of entries) {
    const name = await readPrimeSkillName(entry.source);
    frontmatter.set(entry.key, name);
    if (name !== null) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const entry of entries) {
    const name = frontmatter.get(entry.key) ?? null;
    const keep = (why: string) => {
      names.set(entry.key, entry.runtimeName);
      logLines.push(`[paperclip] Skill "${entry.runtimeName}" is staged under its runtime name: ${why}.\n`);
    };
    if (name === null) keep("its SKILL.md has no frontmatter name");
    else if (!SKILL_NAME.test(name) || name.length > 64) keep(`its frontmatter name "${name}" is not a valid Prime skill name`);
    else if ((counts.get(name) ?? 0) > 1) keep(`another skill also has the name "${name}"`);
    else if ((PRIME_BUILTIN_SKILL_NAMES as readonly string[]).includes(name)) keep(`"${name}" is a Prime built-in skill name`);
    else names.set(entry.key, name);
  }
  return { names, logLines };
}

async function buildPrimeSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const configuredDetail = "Passed to Prime with --skill on the next run.";
  const snapshot = buildRuntimeMountedSkillSnapshot({ adapterType: PRIME_ADAPTER_TYPE, availableEntries, desiredSkills, configuredDetail });
  const present = availableEntries.filter((entry) => !isPaperclipSkillSourceMissing(entry) && isSinglePathSegment(entry.runtimeName));
  const { names } = await planPrimeSkillNames(present);
  return { ...snapshot, entries: snapshot.entries.map((entry) => {
    const staged = names.get(entry.key);
    return staged ? { ...entry, locationLabel: `Prime skill name: ${staged}` } : entry;
  }) };
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
  const staging: NamedEntry[] = [];
  for (const entry of availableEntries) {
    if (!desired.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry)) missing.push(entry.runtimeName);
    else if (!isSinglePathSegment(entry.runtimeName)) missing.push(`${entry.runtimeName} (unsafe runtime name: not a single path segment)`);
    else staging.push(entry);
  }
  const { names, logLines } = await planPrimeSkillNames(staging);
  try {
    for (const entry of staging) {
      const target = path.join(root, names.get(entry.key)!);
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
  return { skillDirs, missing, cleanup, logLines };
};
