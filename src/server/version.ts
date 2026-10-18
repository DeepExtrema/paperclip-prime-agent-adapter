// Owner: WP5. Contract: INTERFACES.md §8, §16 A8.
import { randomUUID } from "node:crypto";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { PrimeCliError } from "../errors.js";
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

export const readPrimeVersion: ReadPrimeVersion = async ({ command, env, cwd }) => {
  let result;
  try {
    // A8: env goes to runChildProcess unchanged; it merges process.env, then deletes the undefined entries.
    // The cast only bridges the host's `Record<string, string>` parameter type.
    result = await runChildProcess(`prime-version-${randomUUID()}`, command, ["--version"], {
      cwd,
      env: env as Record<string, string>,
      timeoutSec: VERSION_TIMEOUT_SEC,
      graceSec: VERSION_GRACE_SEC,
      onLog: async () => {},
    });
  } catch (err) {
    throw new PrimeCliError("prime_cli_missing", err instanceof Error ? err.message : String(err), { cause: err });
  }
  if (result.timedOut) {
    throw new PrimeCliError("prime_cli_version_unreadable", `"${command} --version" timed out after ${VERSION_TIMEOUT_SEC} s.`);
  }
  if (result.exitCode !== 0) {
    const detail = firstLine(result.stderr) || firstLine(result.stdout);
    throw new PrimeCliError("prime_cli_version_unreadable", `"${command} --version" exited with code ${result.exitCode ?? "null"}: ${detail}`);
  }
  const version = firstLine(result.stdout);
  if (!parseCore(version)) {
    throw new PrimeCliError("prime_cli_version_unreadable", `"${command} --version" printed "${version}", not a x.y.z version.`);
  }
  return version;
};

export const isSupportedPrimeVersion: IsSupportedPrimeVersion = (version) => {
  const core = parseCore(version);
  const min = parseCore(PRIME_SUPPORTED_VERSION_RANGE.min);
  const maxExclusive = parseCore(PRIME_SUPPORTED_VERSION_RANGE.maxExclusive);
  if (!core || !min || !maxExclusive) return false;
  return compareCore(core, min) >= 0 && compareCore(core, maxExclusive) < 0;
};
