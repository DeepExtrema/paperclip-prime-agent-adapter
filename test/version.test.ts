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

describe("readPrimeVersion (INTERFACES.md §8, §16 A8)", () => {
  it("returns the trimmed first line of `<command> --version`", async () => {
    const command = await fakePrime('printf "  0.10.0  \\nsecond line\\n"');
    await expect(readPrimeVersion({ command, env: {}, cwd: dir })).resolves.toBe("0.10.0");
  });

  it("passes --version, the cwd and the env to the child", async () => {
    const command = await fakePrime('printf "%s|%s|%s" "$*" "$(pwd)" "$WP5_MARK" > "$WP5_OUT"; echo 0.10.0');
    const out = path.join(dir, "out.txt");
    await readPrimeVersion({ command, env: { WP5_MARK: "mark-1", WP5_OUT: out }, cwd: dir });
    expect(await readFile(out, "utf8")).toBe(`--version|${dir}|mark-1`);
  });

  it("passes undefined entries through, so the child neither sees them nor inherits them", async () => {
    const command = await fakePrime('printf "%s|%s" "${WP5_KEEP-unset}" "${WP5_DROP-unset}" > "$WP5_OUT"; echo 0.10.0');
    const out = path.join(dir, "out.txt");
    process.env.WP5_KEEP = "kept";
    process.env.WP5_DROP = "leaked";
    try {
      await readPrimeVersion({ command, env: { WP5_OUT: out, WP5_DROP: undefined }, cwd: dir });
    } finally {
      delete process.env.WP5_KEEP;
      delete process.env.WP5_DROP;
    }
    expect(await readFile(out, "utf8")).toBe("kept|unset");
  });
});

describe("readPrimeVersion failures (INTERFACES.md §8)", () => {
  it("throws prime_cli_missing when the command cannot be spawned", async () => {
    const command = path.join(dir, "no-such-prime-agent");
    const error = await cliError(command);
    expect(error.code).toBe("prime_cli_missing");
    expect(error.message).toContain(`Failed to start command "${command}"`);
  });

  it("throws prime_cli_version_unreadable on a non-zero exit", async () => {
    const command = await fakePrime('echo "boom" >&2; exit 3');
    const error = await cliError(command);
    expect(error.code).toBe("prime_cli_version_unreadable");
    expect(error.message).toBe(`"${command} --version" exited with code 3: boom`);
  });

  it("throws prime_cli_version_unreadable when the first line is not x.y.z", async () => {
    const command = await fakePrime('echo "prime-agent version unknown"');
    const error = await cliError(command);
    expect(error.code).toBe("prime_cli_version_unreadable");
    expect(error.message).toBe(`"${command} --version" printed "prime-agent version unknown", not a x.y.z version.`);
  });
});
