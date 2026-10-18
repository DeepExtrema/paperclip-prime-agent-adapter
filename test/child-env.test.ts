import { describe, expect, it } from "vitest";
import { buildPrimeChildEnv } from "../src/server/runtime-config.js";
import type { PrimeAgentDirPlan } from "../src/types.js";
const AGENT_DIR = "/srv/agents/agent-1/prime-agent-home";
const PLAN: PrimeAgentDirPlan = {
  kind: "agent", agentDir: AGENT_DIR, sessionDir: `${AGENT_DIR}/sessions`,
  credential: { mode: "host_auth", hostAuthFile: "/home/op/.prime/agent/auth.json" },
};

describe("buildPrimeChildEnv base env (INTERFACES §4, §16 A8)", () => {
  it("blanks inherited Prime, RLM, PI and provider keys as explicit undefined and sets the adapter keys", () => {
    const base: NodeJS.ProcessEnv = {
      PATH: "/usr/bin", HOME: "/home/op", PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: "secret-token", RLM_SESSION_DIR: "/rlm",
      PI_CODING_AGENT_DIR: "/pi", PRIME_AGENT_CODING_AGENT_DIR: "/elsewhere", ANTHROPIC_API_KEY: "sk-host", UNSET_VALUE: undefined,
    };
    const { env, droppedKeys } = buildPrimeChildEnv(base, PLAN, { PAPERCLIP_RUN_ID: "run-1" });
    expect(env).toStrictEqual({
      PATH: "/usr/bin", HOME: "/home/op", PAPERCLIP_RUN_ID: "run-1", PRIME_AGENT_CODING_AGENT_DIR: AGENT_DIR, PRIME_AGENT_TELEMETRY: "0",
      PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: undefined, RLM_SESSION_DIR: undefined, PI_CODING_AGENT_DIR: undefined,
      ANTHROPIC_API_KEY: undefined,
    });
    expect(droppedKeys).toEqual([
      "ANTHROPIC_API_KEY", "PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN", "RLM_SESSION_DIR",
    ]);
    expect(JSON.stringify(droppedKeys)).not.toContain("secret-token");
  });
  it("returns stripped keys as present keys with value undefined (A8 test)", () => {
    const { env } = buildPrimeChildEnv({ PRIME_AGENT_INTERNAL_X: "1", PI_CODING_AGENT_DIR: "/x", OPENAI_API_KEY: "k" }, PLAN, {});
    for (const key of ["PRIME_AGENT_INTERNAL_X", "PI_CODING_AGENT_DIR", "OPENAI_API_KEY"]) {
      expect([Object.hasOwn(env, key), env[key]]).toStrictEqual([true, undefined]);
    }
  });
  it("adds the default PATH when neither env has one", () => {
    const { env } = buildPrimeChildEnv({ HOME: "/home/op" }, PLAN, {});
    expect(env.PATH).toBe("/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin");
  });
});

describe("buildPrimeChildEnv Paperclip env (INTERFACES §4 step 2, §16 A8)", () => {
  it("blanks internal and adapter-owned keys but keeps operator Prime settings and config provider keys", () => {
    const { env, droppedKeys } = buildPrimeChildEnv({ PATH: "/usr/bin", HOME: "/home/op", ANTHROPIC_API_KEY: "sk-host" }, PLAN, {
      HOME: "/paperclip/agent-home", PAPERCLIP_API_KEY: "run-jwt", PRIME_AGENT_KERNEL_VENV: "/opt/venv",
      ANTHROPIC_API_KEY: "sk-config", PRIME_AGENT_INTERNAL_X: "leak", RLM_DEPTH: "2", PI_CODING_AGENT_DIR: "/pi",
      PRIME_AGENT_CODING_AGENT_DIR: "/elsewhere", PRIME_AGENT_SESSION_DIR: "/sessions", PRIME_AGENT_TELEMETRY: "1",
      PRIME_AGENT_DAEMON_SOCKET: "/run/prime.sock", PRIME_AGENT_KERNEL_OWNER_PID: "123",
    });
    expect(droppedKeys).toEqual([
      "ANTHROPIC_API_KEY", "PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "PRIME_AGENT_DAEMON_SOCKET", "PRIME_AGENT_INTERNAL_X",
      "PRIME_AGENT_KERNEL_OWNER_PID", "PRIME_AGENT_SESSION_DIR", "PRIME_AGENT_TELEMETRY", "RLM_DEPTH",
    ]);
    expect(env).toStrictEqual({
      PATH: "/usr/bin", HOME: "/paperclip/agent-home", PAPERCLIP_API_KEY: "run-jwt", PRIME_AGENT_KERNEL_VENV: "/opt/venv",
      ANTHROPIC_API_KEY: "sk-config", PRIME_AGENT_CODING_AGENT_DIR: AGENT_DIR, PRIME_AGENT_TELEMETRY: "0",
      PRIME_AGENT_INTERNAL_X: undefined, RLM_DEPTH: undefined, PI_CODING_AGENT_DIR: undefined, PRIME_AGENT_SESSION_DIR: undefined,
      PRIME_AGENT_DAEMON_SOCKET: undefined, PRIME_AGENT_KERNEL_OWNER_PID: undefined,
    });
  });
});

describe("buildPrimeChildEnv server Paperclip env (§16 A17)", () => {
  it("does not copy server-only PAPERCLIP_* variables from the base env", () => {
    const base = { PATH: "/usr/bin", PAPERCLIP_AGENT_JWT_SECRET: "jwt", PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100" };
    const { env } = buildPrimeChildEnv(base, PLAN, { PAPERCLIP_API_KEY: "run-jwt" });
    expect([Object.hasOwn(env, "PAPERCLIP_AGENT_JWT_SECRET"), env.PAPERCLIP_RUNTIME_API_URL, env.PAPERCLIP_API_KEY]).toEqual([false, "http://127.0.0.1:3100", "run-jwt"]);
  });
});

describe("buildPrimeChildEnv base allowlist (§16 A22)", () => {
  it("passes runtime settings, blanks server secrets and accepts operator provider keys", () => {
    const allowed = {
      PATH: "/usr/bin", HOME: "/home/op", USER: "op", LOGNAME: "op", SHELL: "/bin/bash", LANG: "en_US.UTF-8",
      LC_ALL: "C", TZ: "UTC", TERM: "xterm", TMPDIR: "/tmp", XDG_CACHE_HOME: "/tmp/cache",
      SSL_CERT_FILE: "/certs/ca.pem", SSL_CERT_DIR: "/certs", NODE_EXTRA_CA_CERTS: "/certs/node.pem",
      HTTP_PROXY: "http://proxy:8080", HTTPS_PROXY: "http://proxy:8080", NO_PROXY: "localhost",
      http_proxy: "http://proxy:8080", https_proxy: "http://proxy:8080", no_proxy: "localhost",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100", PAPERCLIP_LISTEN_HOST: "127.0.0.1", PAPERCLIP_LISTEN_PORT: "3100",
    };
    const base = {
      ...allowed, DATABASE_URL: "fixture-db", AWS_SECRET_ACCESS_KEY: "fixture-aws", GH_TOKEN: "fixture-gh",
      BETTER_AUTH_SECRET: "fixture-auth", GOOGLE_API_KEY: "fixture-google", OPENAI_API_KEY: "fixture-host",
    };
    const configEnv = { OPENAI_API_KEY: "fixture-config" };
    const { env, droppedKeys } = buildPrimeChildEnv(base, PLAN, { PAPERCLIP_RUN_ID: "run-1", ...configEnv });
    expect(env).toStrictEqual({
      ...allowed, DATABASE_URL: undefined, AWS_SECRET_ACCESS_KEY: undefined, GH_TOKEN: undefined,
      BETTER_AUTH_SECRET: undefined, GOOGLE_API_KEY: undefined, OPENAI_API_KEY: "fixture-config",
      PAPERCLIP_RUN_ID: "run-1", PRIME_AGENT_CODING_AGENT_DIR: AGENT_DIR, PRIME_AGENT_TELEMETRY: "0",
    });
    expect(droppedKeys).toEqual([
      "AWS_SECRET_ACCESS_KEY", "BETTER_AUTH_SECRET", "DATABASE_URL", "GH_TOKEN", "GOOGLE_API_KEY", "OPENAI_API_KEY",
    ]);
  });
});
