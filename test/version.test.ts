import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrimeCliError } from "../src/errors.js";
import { isSupportedPrimeVersion, readPrimeVersion } from "../src/server/version.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "wp5-version-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fakePrime(body: string): Promise<string> {
  const file = path.join(dir, "prime-agent");
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

async function cliError(command: string): Promise<PrimeCliError> {
  const error = await readPrimeVersion({ command, env: {}, cwd: dir }).catch((err: unknown) => err);
  expect(error).toBeInstanceOf(PrimeCliError);
  return error as PrimeCliError;
}

describe("isSupportedPrimeVersion (INTERFACES.md §8)", () => {
  it.each([["0.10.0", true], ["0.10.7", true], ["0.10.10", true], ["0.9.9", false], ["0.11.0", false], ["1.0.0", false]])(
    "%s -> %s",
    (version, expected) => {
      expect(isSupportedPrimeVersion(version)).toBe(expected);
    },
  );

  it.each(["0.10.0-beta.1", "0.10", "v0.10.0", "", "0.10.0 extra"])("rejects non-core version %j", (version) => {
    expect(isSupportedPrimeVersion(version)).toBe(false);
  });
});
