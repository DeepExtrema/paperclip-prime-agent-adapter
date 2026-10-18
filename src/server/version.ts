// Owner: WP5. Contract: INTERFACES.md §8, §16 A8.
import { randomUUID } from "node:crypto";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { PrimeCliError, notImplemented } from "../errors.js";
import { PRIME_SUPPORTED_VERSION_RANGE } from "../types.js";
import type { IsSupportedPrimeVersion, ReadPrimeVersion } from "../types.js";

type Core = [number, number, number];
const CORE_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const VERSION_TIMEOUT_SEC = 10;
const VERSION_GRACE_SEC = 3;

function parseCore(version: string): Core | null {
  const match = CORE_VERSION_RE.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

const compareCore = (a: Core, b: Core): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const firstLine = (text: string): string => text.split(/\r?\n/)[0]?.trim() ?? "";

export const readPrimeVersion: ReadPrimeVersion = async () => notImplemented("WP5", "readPrimeVersion");

export const isSupportedPrimeVersion: IsSupportedPrimeVersion = (version) => {
  const core = parseCore(version);
  const min = parseCore(PRIME_SUPPORTED_VERSION_RANGE.min);
  const maxExclusive = parseCore(PRIME_SUPPORTED_VERSION_RANGE.maxExclusive);
  if (!core || !min || !maxExclusive) return false;
  return compareCore(core, min) >= 0 && compareCore(core, maxExclusive) < 0;
};
