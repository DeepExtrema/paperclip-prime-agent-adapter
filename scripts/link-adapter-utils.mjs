// Links node_modules/@paperclipai/adapter-utils to the host Paperclip copy.
//
// npm 11 cannot install the host package through a `file:` dependency: the
// package declares `bundleDependencies`, and npm then resolves the relative
// `file:` spec against the wrong base directory (ENOENT). See WP0-REPORT.md.
// The adapter must build against the host's adapter-utils, so we symlink it.
// Override the source with PAPERCLIP_ADAPTER_UTILS_DIR.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_VERSION = "0.3.1";
const DEFAULT_SOURCE = path.join(
  os.homedir(),
  ".paperclip/cli/installs/local/2026.1005.0-prime.reinstall.1/app/packages/adapter-utils",
);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(process.env.PAPERCLIP_ADAPTER_UTILS_DIR || DEFAULT_SOURCE);
const linkDir = path.join(repoRoot, "node_modules", "@paperclipai");
const linkPath = path.join(linkDir, "adapter-utils");

const manifest = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
if (manifest.name !== "@paperclipai/adapter-utils" || manifest.version !== EXPECTED_VERSION) {
  throw new Error(
    `${source} is ${manifest.name}@${manifest.version}; expected @paperclipai/adapter-utils@${EXPECTED_VERSION}`,
  );
}

const relativeTarget = path.relative(linkDir, source);
fs.mkdirSync(linkDir, { recursive: true });
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
console.log(`@paperclipai/adapter-utils -> ${relativeTarget}`);
