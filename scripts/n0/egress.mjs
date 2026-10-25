// N0: allow-listed egress for the one kernel-build test (PyPI, the uv CPython download).
//   node egress.mjs proxy <unix-socket> <log>   outside the namespace: HTTP CONNECT proxy on a Unix socket
//   node egress.mjs bridge <unix-socket> <port>  inside offline.sh: 127.0.0.1:<port> -> the Unix socket
// The proxy refuses every host that is not on ALLOW and logs each request, so the log shows that no Anthropic host was asked for.
import fs from "node:fs";
import net from "node:net";

const ALLOW = [/^pypi\.org$/, /^files\.pythonhosted\.org$/, /^github\.com$/, /^objects\.githubusercontent\.com$/, /^release-assets\.githubusercontent\.com$/,
  /^releases\.astral\.sh$/, /^astral\.sh$/, /^python-standalone\.org$/, /^download\.python\.org$/];
const [mode, socketPath, arg] = process.argv.slice(2);

if (mode === "proxy") {
  fs.rmSync(socketPath, { force: true });
  net.createServer((client) => {
    client.once("data", (head) => {
      const line = head.toString("latin1").split("\r\n")[0] ?? "";
      const m = /^CONNECT ([^:\s]+):(\d+) /.exec(line);
      const host = m?.[1] ?? null;
      const allowed = host !== null && ALLOW.some((re) => re.test(host));
      fs.appendFileSync(arg, `${JSON.stringify({ at: new Date().toISOString(), request: line.slice(0, 200), host, allowed })}\n`);
      if (!m || !allowed) { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
      const upstream = net.connect(Number(m[2]), host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
  }).listen(socketPath, () => console.log(`egress proxy on ${socketPath}`));
} else if (mode === "bridge") {
  net.createServer((c) => {
    const u = net.connect(socketPath);
    c.pipe(u);
    u.pipe(c);
    u.on("error", () => c.destroy());
    c.on("error", () => u.destroy());
  }).listen(Number(arg), "127.0.0.1", () => console.log(`bridge 127.0.0.1:${arg} -> ${socketPath}`));
} else {
  console.error("usage: egress.mjs proxy <socket> <log> | bridge <socket> <port>");
  process.exit(2);
}
