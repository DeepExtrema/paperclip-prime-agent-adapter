import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/smoke-throwaway-paperclip.mjs", import.meta.url));
const nodeBinDir = path.dirname(process.execPath);
let scratch = "";
beforeAll(() => {
  scratch = mkdtempSync("/tmp/wp7-smoke-plan-");
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function printPlan(root: string) {
  return spawnSync(process.execPath, [
    script, "--print-plan", "--root", root,
    "--paperclip-cli", "/opt/paperclip/index.js",
    "--node-bin-dir", nodeBinDir,
    "--prime-command", "/opt/prime/prime-agent",
    "--host-auth-file", "/opt/prime/auth.json",
  ], { encoding: "utf8", env: { PATH: `${nodeBinDir}:/usr/bin:/bin` } });
}

describe("scripts/smoke-throwaway-paperclip.mjs --print-plan (L1)", () => {
  it("keeps every path, port and variable away from the live instance", () => {
    const root = path.join(scratch, "root");
    const result = printPlan(root);
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(Object.keys(plan.env).sort()).toEqual([
      "HOME", "LANG", "PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_NO_BROWSER",
      "PAPERCLIP_OPEN_ON_LISTEN", "PATH", "TMPDIR", "UV_CACHE_DIR", "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "npm_config_cache",
    ]);
    for (const key of ["HOME", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
      "UV_CACHE_DIR", "npm_config_cache", "PAPERCLIP_HOME"]) {
      expect(plan.env[key].startsWith(root + "/"), key).toBe(true);
    }
    expect(plan.env.PATH).toBe(`${nodeBinDir}:/usr/bin:/bin`);
    expect(plan.instanceRoot).toBe(path.join(root, "paperclip-home", "instances", "wp7smoke"));
    expect(plan.apiUrl).toBe("http://127.0.0.1:3197/api");
    expect(plan.config.server).toMatchObject({ deploymentMode: "local_trusted", host: "127.0.0.1", port: 3197 });
    expect(plan.config.database).toMatchObject({
      mode: "embedded-postgres",
      embeddedPostgresPort: 54397,
      embeddedPostgresDataDir: path.join(plan.instanceRoot, "db"),
    });
    expect(plan.selfTest).toEqual({ home: path.join(root, "home"), tmp: path.join(root, "tmp") });
    expect(JSON.stringify(plan)).not.toMatch(/DATABASE_URL|CODEX_HOME|ANTHROPIC|OPENAI|PRIME_AGENT_/);
  });

  it("refuses a root outside /tmp and /var/tmp", () => {
    const result = printPlan("/srv/wp7-root");
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("smoke: root must be under /tmp/ or /var/tmp/: /srv/wp7-root\n");
  });

  it("refuses a root that already exists", () => {
    const result = printPlan(scratch);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(`smoke: root already exists: ${scratch}\n`);
  });
});
