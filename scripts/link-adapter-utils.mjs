// Links node_modules/@paperclipai/adapter-utils and @paperclipai/shared to the host Paperclip copies.
//
// npm 11 cannot install the host package through a `file:` dependency: the
// package declares `bundleDependencies`, and npm then resolves the relative
// `file:` spec against the wrong base directory (ENOENT). See WP0-REPORT.md.
// The adapter must build against the host's adapter-utils, so we symlink it.
// TAI-273 §3.2: @paperclipai/shared must be the running host's own module instance, because
// the adapter registers itself in the AI_CONNECTION_CAPABILITIES array that the host's select() reads.
// Override the sources with PAPERCLIP_ADAPTER_UTILS_DIR and PAPERCLIP_SHARED_DIR.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_VERSION = "0.3.1";
const APP = path.join(os.homedir(), ".paperclip/cli/installs/local/2026.1005.0-prime.reinstall.1/app");
const PACKAGES = [
  { name: "adapter-utils", source: process.env.PAPERCLIP_ADAPTER_UTILS_DIR || path.join(APP, "packages/adapter-utils") },
  { name: "shared", source: process.env.PAPERCLIP_SHARED_DIR || path.join(APP, "packages/shared") },
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const linkDir = path.join(repoRoot, "node_modules", "@paperclipai");
fs.mkdirSync(linkDir, { recursive: true });

for (const { name, source: configured } of PACKAGES) {
  const source = path.resolve(configured);
  const linkPath = path.join(linkDir, name);
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  if (manifest.name !== `@paperclipai/${name}` || manifest.version !== EXPECTED_VERSION) {
    throw new Error(`${source} is ${manifest.name}@${manifest.version}; expected @paperclipai/${name}@${EXPECTED_VERSION}`);
  }
  const relativeTarget = path.relative(linkDir, source);
  let current = null;
  try {
    current = fs.readlinkSync(linkPath);
  } catch (err) {
    if (err.code === "EINVAL") throw new Error(`${linkPath} exists and is not a symlink`);
    if (err.code !== "ENOENT") throw err;
  }
  if (current !== relativeTarget) {
    if (current !== null) fs.unlinkSync(linkPath);
    fs.symlinkSync(relativeTarget, linkPath, "dir");
  }
  console.log(`@paperclipai/${name} -> ${relativeTarget}`);
}
