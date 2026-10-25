// N0 e02: the kernel builder honours PRIME_AGENT_KERNEL_VENV, UV_PYTHON_INSTALL_DIR and UV_CACHE_DIR; a second start in a new HOME reuses the venv.
// Usage: node e02-kernel.mjs <kernel-root> [proxyPort]. With proxyPort, uv may reach the allow-listed hosts through egress.mjs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createConfig, requests, scratch, seedAgentDir, show, startDaemon, startFake, tree, turn } from "./harness.mjs";
import { toolResults } from "./session-file.mjs";

const [kernelRoot, proxyPort] = process.argv.slice(2);
const k = { venv: path.join(kernelRoot, "venv"), python: path.join(kernelRoot, "python"), cache: path.join(kernelRoot, "uv-cache") };
const proxy = proxyPort ? `http://127.0.0.1:${proxyPort}` : null;
const s = scratch("e02");
const fake = await startFake(s);
seedAgentDir(s, fake);
const venvBefore = fs.existsSync(k.venv) ? fs.statSync(k.venv).mtimeMs : null;
const d = await startDaemon(s, { env: {
  PRIME_AGENT_KERNEL_VENV: k.venv, UV_PYTHON_INSTALL_DIR: k.python, UV_CACHE_DIR: k.cache,
  ...(proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } : {}),
} });
try {
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
  const sid = created.data.activeSessionId;
  const started = Date.now();
  show("turn", await turn(d, sid, "BEGINCMD\nimport sys, os\nprint('EXE', sys.executable)\nprint('PREFIX', sys.prefix)\nprint('VENV', os.environ.get('VIRTUAL_ENV'))\nENDCMD", 600_000));
  show("turn seconds", (Date.now() - started) / 1000);
  show("tool results", toolResults(created.data.sessionFile));
  show("readlink -f venv/bin/python", fs.existsSync(path.join(k.venv, "bin", "python")) ? execFileSync("readlink", ["-f", path.join(k.venv, "bin", "python")]).toString().trim() : "missing");
  show("venv mtime before/after", { before: venvBefore, after: fs.existsSync(k.venv) ? fs.statSync(k.venv).mtimeMs : null });
  show("home/.prime", tree(path.join(s.home, ".prime")));
  show("home/.local/share/uv", tree(path.join(s.home, ".local", "share", "uv")).slice(0, 20));
  show("requests", requests(s).length);
  const log = fs.readdirSync(path.join(s.agentDir, "logs")).map((f) => `== ${f}\n${fs.readFileSync(path.join(s.agentDir, "logs", f), "utf8").slice(-3000)}`).join("\n");
  show("logs", log);
} finally {
  await d.stop();
  fake.stop();
}
