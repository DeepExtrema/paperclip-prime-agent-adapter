import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("builds a ui-parser that loads in the host sandbox and parses a tool result", () => {
  const root = new URL("../", import.meta.url);
  execFileSync("npm", ["run", "build"], { cwd: fileURLToPath(root) });
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const source = readFileSync(new URL(pkg.exports["./ui-parser"].import, root), "utf8");
  const exports = {};
  const module = { exports };
  const load = new Function("exports", "module", "self", "globalThis", `"use strict";\n{\n${source}\n}`);
  load(exports, module, undefined, undefined);
  const resolved = module.exports as { parseStdoutLine?: (line: string, ts: string) => unknown };
  expect(resolved.parseStdoutLine).toBeTypeOf("function");
  const ts = "2026-10-18T00:00:00.000Z";
  const line = readFileSync(new URL("./fixtures/prime-jsonl/run4.jsonl", import.meta.url), "utf8").split("\n")[30] ?? "";
  expect(resolved.parseStdoutLine?.(line, ts)).toEqual([
    { kind: "tool_result", ts, toolUseId: "toolu_01D1iEqtRH3v2sCKAY59YkLF", toolName: "ipython", content: "42\n", isError: false },
  ]);
  expect(source).not.toMatch(/\bimport\b|\bexport /);
  expect(pkg.exports["./ui-parser"].import).toBe("./dist/ui-parser.cjs");
  expect(source).toBe(readFileSync(new URL("dist/ui-parser.cjs", root), "utf8"));
});
