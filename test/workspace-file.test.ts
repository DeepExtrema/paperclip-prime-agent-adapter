// TAI-273 §2.2 item 10, the write helper (TAI-339 change 2; TAI-324 T2): the temp file in <cwd>/.prime/ is opened with O_EXCL,
// so an entry already at its name, a symlink included, makes the write fail and is never followed.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => ({ ...await importOriginal<typeof import("node:crypto")>(), randomUUID: () => "fixed-uuid" }));
const { writeWorkspaceFile } = await import("../src/server/governed-run.js");

let root = "";
const ws = () => path.join(root, "ws");
const file = () => path.join(ws(), ".prime", "agent", "settings.json");
const temp = () => path.join(ws(), ".prime", `.settings.json.${process.pid}.fixed-uuid.tmp`);
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "prime-wsfile-"));
  mkdirSync(path.join(ws(), ".prime", "agent"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("writes the exact bytes through a temp file at the fixed name", async () => {
  await writeWorkspaceFile(ws());
  expect(readFileSync(file(), "utf8")).toBe('{"skills":["!**"]}');
  expect(existsSync(temp())).toBe(false);
});
it("refuses a symlink already at the temp name, and writes nothing through it", async () => {
  const outside = path.join(root, "outside.json");
  writeFileSync(outside, "keep");
  symlinkSync(outside, temp());
  await expect(writeWorkspaceFile(ws())).rejects.toMatchObject({ code: "EEXIST" });
  expect(readFileSync(outside, "utf8")).toBe("keep");
  expect(lstatSync(outside).isFile()).toBe(true);
  expect(existsSync(file())).toBe(false);
});
it("refuses a dangling symlink at the temp name, and creates nothing at its target", async () => {
  const target = path.join(root, "created-through-link.json");
  symlinkSync(target, temp());
  await expect(writeWorkspaceFile(ws())).rejects.toMatchObject({ code: "EEXIST" });
  expect(existsSync(target)).toBe(false);
});
