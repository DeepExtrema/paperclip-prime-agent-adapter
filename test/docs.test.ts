import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRIME_CHECK_CODES, PRIME_RESULT_ERROR_CODES } from "../src/types.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

const DOCS = ["README.md", "docs/install.md", "docs/configuration.md", "docs/credentials.md", "docs/troubleshooting.md"];
const CLAIM_LEVELS = ["registered/loaded", "deterministic-qualified", "live-qualified", "not qualified"];
const PRIVATE_PATTERNS: Array<[string, RegExp]> = [
  ["absolute home path", /\/home\/[^\s/`'")]+/],
  ["uuid (company, agent, issue or run id)", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["API key", /\bsk-[A-Za-z0-9_-]{8,}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

describe.each(DOCS)("%s", (doc) => {
  it("exists and is not empty", () => {
    expect(existsSync(path.join(repoRoot, doc))).toBe(true);
    expect(read(doc).trim().length).toBeGreaterThan(200);
  });

  it("contains no private host data (L13)", () => {
    const text = read(doc);
    for (const [label, pattern] of PRIVATE_PATTERNS) expect(text, label).not.toMatch(pattern);
  });

  it("has only relative links that resolve", () => {
    const text = read(doc);
    for (const match of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
      const target = match[1]!;
      if (/^[a-z]+:/i.test(target)) continue;
      expect(existsSync(path.resolve(repoRoot, path.dirname(doc), target)), target).toBe(true);
    }
  });
});

describe("README.md qualification table (L4)", () => {
  it("uses only the claim levels", () => {
    const section = read("README.md").split("\n## Qualification\n")[1]?.split("\n## ")[0] ?? "";
    const rows = section.split("\n").filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line) && !line.startsWith("| Surface"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(CLAIM_LEVELS).toContain(row.split("|")[2]?.trim());
  });
});

describe("docs/configuration.md", () => {
  it("documents every adapterConfig key from INTERFACES.md §2", () => {
    const section = read("INTERFACES.md").split("\n## 2.")[1]!.split("\n## 3.")[0]!;
    const keys = [...section.matchAll(/^\| `([A-Za-z]+)`/gm)].map((match) => match[1]!);
    expect(keys).toHaveLength(17);
    const doc = read("docs/configuration.md");
    for (const key of keys) expect(doc, key).toContain("`" + key + "`");
  });
});

describe("docs/troubleshooting.md", () => {
  it("documents every check code, result error code and thrown error code", () => {
    const thrown = [...read("src/errors.ts").matchAll(/"(prime_[a-z_]+)"/g)].map((match) => match[1]!);
    const codes = new Set<string>([...PRIME_CHECK_CODES, ...PRIME_RESULT_ERROR_CODES, ...thrown]);
    expect(codes.size).toBe(54);
    const doc = read("docs/troubleshooting.md");
    for (const code of codes) expect(doc, code).toContain("`" + code + "`");
  });
});
