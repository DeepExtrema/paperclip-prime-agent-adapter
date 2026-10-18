import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const script = path.join(repoRoot, "scripts", "install-local.sh");
const PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}

async function stubPaperclip(installStatus: number, adapterInfo: unknown) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
      const isInstall = req.method === "POST" && req.url === "/api/adapters/install";
      res.writeHead(isInstall ? installStatus : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(isInstall ? { type: "prime_agent_local" } : adapterInfo));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { seen, apiUrl: `http://127.0.0.1:${port}/api`, close };
}

function runScript(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("bash", [script, ...args], { env: { PATH, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const loaded = { type: "prime_agent_local", loaded: true, source: "external" };

beforeAll(() => {
  const build = spawnSync(path.join(repoRoot, "node_modules", ".bin", "tsc"), [], { cwd: repoRoot, encoding: "utf8" });
  expect(build.status, build.stdout + build.stderr).toBe(0);
}, 120_000);

describe("scripts/install-local.sh", () => {
  it("registers the checkout as a local path and confirms it is loaded", async () => {
    const stub = await stubPaperclip(201, loaded);
    try {
      const result = await runScript(["--api-url", stub.apiUrl, "--skip-build"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe(`prime_agent_local registered from ${repoRoot} (loaded, external)\n`);
      expect(stub.seen.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /api/adapters/install",
        "GET /api/adapters/prime_agent_local",
      ]);
      expect(JSON.parse(stub.seen[0]!.body)).toEqual({ packageName: repoRoot, isLocalPath: true });
      expect(stub.seen[0]!.auth).toBeUndefined();
    } finally {
      await stub.close();
    }
  });

  it("prints usage and exits 2 without --api-url", async () => {
    const result = await runScript(["--skip-build"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("usage: scripts/install-local.sh --api-url <http://host:port/api> [--skip-build]\n");
  });
});
