// N0 e25 (plan rev 5, 2.2 item 10): the daemon `create` frame that the 0.10.1 CLI sends for its resource flags.
// A logging Unix-socket proxy sits between `prime-agent --daemon-socket <proxy> <flags>` and a scratch daemon.
// The non-interactive modes (-p, --mode json, --mode rpc) run in-process and never open the socket, so the CLI runs
// interactive, under `script` for a pseudo-terminal, and is killed after 20 s.
// Usage: node e25-cli-create-frame.mjs [cli flags...]   for example: --no-skills --no-prompt-templates
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PRIME, runPrime, scratch, seedAgentDir, show, startDaemon, startFake } from "./harness.mjs";

const flags = process.argv.slice(2);
const s = scratch("e25");
const fake = await startFake(s);
seedAgentDir(s, fake);
const d = await startDaemon(s);
const proxyPath = path.join(s.dir, "tmp", "proxy.sock");
const frames = [];
const proxy = net.createServer((client) => {
  const upstream = net.connect(d.socketPath);
  client.on("data", (c) => { frames.push(c.toString("utf8")); upstream.write(c); });
  upstream.on("data", (c) => client.write(c));
  client.on("close", () => upstream.end());
  upstream.on("close", () => client.end());
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
});
await new Promise((resolve) => proxy.listen(proxyPath, resolve));
try {
  const q = (a) => `'${a.replace(/'/g, "'\\''")}'`;
  const cli = [PRIME, "--daemon-socket", proxyPath, "--provider", "anthropic", "--model", "claude-opus-5-5", ...flags, "SAY<<<cli-reply>>>"].map(q).join(" ");
  const r = await runPrime(s, ["-qfec", cli, "/dev/null"], { timeoutMs: 20_000, command: "script", env: { TERM: "xterm-256color", COLUMNS: "120", LINES: "40" } });
  show("cli exit", { code: r.code, signal: r.signal, stdout: r.stdout.slice(0, 300), stderr: r.stderr.slice(0, 600) });
  const text = frames.join("");
  const creates = text.split("\n").filter((l) => l.includes('"create"') || l.includes("\"type\":\"create"));
  show("create frames (config keys)", creates.map((l) => {
    try { const m = JSON.parse(l); const cmd = m.command ?? m; return { keys: Object.keys(cmd), configKeys: Object.keys(cmd.config ?? {}), config: cmd.config }; } catch { return l.slice(0, 2000); }
  }));
  fs.writeFileSync(path.join(s.dir, "frames.txt"), text);
} finally {
  proxy.close();
  await d.stop();
  fake.stop();
}
show("scratch", s.dir);
