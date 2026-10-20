#!/usr/bin/env node
// Throwaway-Paperclip smoke for prime_agent_local (WP7).
// Starts a separate Paperclip instance from an installed Paperclip CLI with its own
// HOME, PAPERCLIP_HOME and ports, registers this checkout, runs three real Prime
// scenarios and writes evidence to <root>/evidence. It never contacts the live instance.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INSTANCE_ID = "wp7smoke";
const SERVER_PORT = 3197;
const DB_PORT = 54397;
const MODEL = "anthropic/claude-haiku-4-5";
const ROOT_PARENTS = ["/tmp/", "/var/tmp/"];
const TERMINAL = new Set(["succeeded", "interrupted", "failed", "cancelled", "timed_out"]);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FLAGS = {
  "--root": "root",
  "--paperclip-cli": "paperclipCli",
  "--node-bin-dir": "nodeBinDir",
  "--prime-command": "primeCommand",
  "--host-auth-file": "hostAuthFile",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function die(message) {
  process.stderr.write(`smoke: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { printPlan: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--print-plan") {
      args.printPlan = true;
      continue;
    }
    if (argv[i] === "--runtime") {
      const value = argv[++i];
      if (value !== "daemon") die(`--runtime must be daemon: ${value}`);
      args.runtime = value;
      continue;
    }
    const key = FLAGS[argv[i]];
    if (!key || i + 1 >= argv.length) die(`unknown or incomplete argument: ${argv[i]}`);
    args[key] = argv[(i += 1)];
  }
  for (const [flag, key] of Object.entries(FLAGS)) {
    if (!args[key] || !path.isAbsolute(args[key])) die(`${flag} <absolute path> is required`);
  }
  const root = path.resolve(args.root);
  if (!ROOT_PARENTS.some((parent) => root.startsWith(parent))) die(`root must be under /tmp/ or /var/tmp/: ${root}`);
  if (fs.existsSync(root)) die(`root already exists: ${root}`);
  return { ...args, root };
}

function buildPlan(args) {
  const { root } = args;
  const home = path.join(root, "home");
  const paperclipHome = path.join(root, "paperclip-home");
  const instanceRoot = path.join(paperclipHome, "instances", INSTANCE_ID);
  const env = {
    HOME: home,
    TMPDIR: path.join(root, "tmp"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    npm_config_cache: path.join(home, ".npm"),
    UV_CACHE_DIR: path.join(home, ".cache", "uv"),
    PAPERCLIP_HOME: paperclipHome,
    PAPERCLIP_INSTANCE_ID: INSTANCE_ID,
    PAPERCLIP_NO_BROWSER: "1",
    PAPERCLIP_OPEN_ON_LISTEN: "false",
    PATH: `${args.nodeBinDir}:/usr/bin:/bin`,
    LANG: "C.UTF-8",
  };
  const config = {
    $meta: { version: 1, updatedAt: "2026-10-18T00:00:00.000Z", source: "onboard" },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(instanceRoot, "db"),
      embeddedPostgresPort: DB_PORT,
      backup: { enabled: false, intervalMinutes: 60, retentionDays: 1, dir: path.join(instanceRoot, "data", "backups") },
    },
    logging: { mode: "file", logDir: path.join(instanceRoot, "logs") },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      bind: "loopback",
      host: "127.0.0.1",
      port: SERVER_PORT,
      allowedHostnames: [],
      serveUi: false,
    },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    telemetry: { enabled: false },
    updates: { checkEnabled: false },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: path.join(instanceRoot, "data", "storage") },
      s3: { bucket: "paperclip", region: "us-east-1", prefix: "", forcePathStyle: false },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: path.join(instanceRoot, "secrets", "master.key") },
    },
  };
  return {
    args,
    root,
    home,
    paperclipHome,
    instanceRoot,
    workspace: path.join(root, "workspace"),
    evidence: path.join(root, "evidence"),
    apiUrl: `http://127.0.0.1:${SERVER_PORT}/api`,
    serverPort: SERVER_PORT,
    dbPort: DB_PORT,
    env,
    config,
  };
}

// L1 self-test: the isolated env must resolve home and tmp under the scratch root.
function selfTest(plan) {
  const probe = spawnSync(
    path.join(plan.args.nodeBinDir, "node"),
    ["-e", "const os=require('node:os');process.stdout.write(JSON.stringify({home:os.homedir(),tmp:os.tmpdir()}))"],
    { env: plan.env, encoding: "utf8" },
  );
  if (probe.status !== 0) die(`self-test failed: ${probe.stderr}`);
  const seen = JSON.parse(probe.stdout);
  for (const value of [seen.home, seen.tmp, plan.instanceRoot]) {
    if (!value.startsWith(plan.root + path.sep)) die(`self-test failed: ${value} is outside ${plan.root}`);
  }
  return seen;
}

function writeJson(plan, name, value) {
  fs.writeFileSync(path.join(plan.evidence, name), JSON.stringify(value, null, 2) + "\n");
}

async function api(plan, method, route, body) {
  const res = await fetch(plan.apiUrl + route, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} -> HTTP ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function apiOrError(plan, method, route) {
  try {
    return await api(plan, method, route);
  } catch (err) {
    return { error: String(err.message) };
  }
}

function sql(plan, query) {
  const out = spawnSync(
    "psql",
    ["-h", "127.0.0.1", "-p", String(DB_PORT), "-U", "paperclip", "-d", "paperclip", "-At", "-c",
      `select coalesce(json_agg(t), '[]'::json) from (${query}) t`],
    { env: { PATH: "/usr/bin:/bin", PGPASSWORD: "paperclip" }, encoding: "utf8" },
  );
  if (out.status !== 0) throw new Error(`psql failed: ${out.stderr}`);
  return JSON.parse(out.stdout);
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

// L2: metadata only (never contents) of the live Paperclip and host Prime state.
function liveState() {
  const h = os.homedir();
  const state = {};
  for (const rel of [".paperclip/instances/default/config.json", ".paperclip/instances/default/.env",
    ".paperclip/adapter-plugins.json", ".prime/agent/auth.json"]) {
    const st = fs.statSync(path.join(h, rel), { throwIfNoEntry: false });
    state[rel] = st ? `${st.size} ${st.mtimeMs} ${st.ino}` : "missing";
  }
  for (const rel of [".paperclip/instances", ".paperclip/instances/default", ".paperclip/instances/default/secrets", ".prime/agent"]) {
    const dir = path.join(h, rel);
    state[`${rel}/`] = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : "missing";
  }
  const secrets = path.join(h, ".paperclip/instances/default/secrets");
  for (const name of fs.existsSync(secrets) ? fs.readdirSync(secrets).sort() : []) {
    const st = fs.lstatSync(path.join(secrets, name));
    state[`.paperclip/instances/default/secrets/${name}`] = `${st.size} ${st.mtimeMs} ${st.ino}`;
  }
  return state;
}

// L9 / INTERFACES §14 item 8: processes still carrying the scratch root in their environment.
function processesUnder(root) {
  const found = [];
  for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    if (Number(pid) === process.pid) continue;
    try {
      const environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
      if (!environ.split("\0").some((entry) => entry.startsWith("PRIME_AGENT_CODING_AGENT_DIR=" + root))) continue;
      found.push({ pid: Number(pid), cmdline: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim() });
    } catch {
      // process exited or is not ours
    }
  }
  return found;
}

const HEADER = [
    "# WP7 smoke agent",
    "",
    "You are a test agent in a throwaway Paperclip company. Do exactly these steps and nothing else.",
    "The paperclip skill documents the API used below; use exactly this code in the ipython tool.",
    "",
    "Step 1. Run this code once:",
    "```python",
    "import os, json, urllib.request",
    "def pc(method, path, body=None):",
    "    req = urllib.request.Request(os.environ['PAPERCLIP_API_URL'].rstrip('/') + path, method=method,",
    "        data=None if body is None else json.dumps(body).encode(),",
    "        headers={'Authorization': 'Bearer ' + os.environ['PAPERCLIP_API_KEY'],",
    "                 'X-Paperclip-Run-Id': os.environ['PAPERCLIP_RUN_ID'], 'Content-Type': 'application/json'})",
    "    with urllib.request.urlopen(req) as res:",
    "        return res.status, json.loads(res.read() or b'null')",
    "print(repr(os.environ.get('PAPERCLIP_TASK_ID', '')))",
    "```",
    "",
  ];

function instructions(role, specialistId) {
  const noTask = role === "coordinator"
    ? [
        "Step 2. If Step 1 printed '' (no task): run this code once, then reply CREATED and stop:",
        "```python",
        `print(pc('POST', '/api/companies/' + os.environ['PAPERCLIP_COMPANY_ID'] + '/issues', {'title': 'WP7 smoke task', 'description': 'Post a comment containing HERON-7, then mark this issue done.', 'status': 'todo', 'assigneeAgentId': '${specialistId}'}))`,
        "```",
      ]
    : ["Step 2. If Step 1 printed '' (no task): reply NO TASK and stop."];
  const task = [
    "",
    "Step 3. If Step 1 printed a task id: run this code once, then reply DONE and stop:",
    "```python",
    "tid = os.environ['PAPERCLIP_TASK_ID']",
    "print(pc('POST', '/api/issues/' + tid + '/checkout', {'agentId': os.environ['PAPERCLIP_AGENT_ID'], 'expectedStatuses': ['todo', 'backlog', 'blocked', 'in_review', 'in_progress']}))",
    "print(pc('PATCH', '/api/issues/' + tid, {'status': 'done', 'comment': 'HERON-7 smoke reply'}))",
    "```",
    "",
  ];
  return [...HEADER, ...noTask, ...task].join("\n");
}

async function setInstructions(plan, agentId, content) {
  const current = await api(plan, "GET", `/agents/${agentId}/instructions-bundle/file?path=AGENTS.md`);
  await api(plan, "PUT", `/agents/${agentId}/instructions-bundle/file`, {
    path: "AGENTS.md",
    content,
    baseRevisionId: current.revision?.id ?? null,
  });
}

async function waitRun(plan, runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await api(plan, "GET", `/heartbeat-runs/${runId}`);
    if (TERMINAL.has(run.status) || Date.now() > deadline) return run;
    await sleep(3000);
  }
}

async function waitIssueRun(plan, companyId, agentId, issueId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await api(plan, "GET", `/companies/${companyId}/heartbeat-runs?agentId=${agentId}`);
    const run = runs.find((r) => r.contextSnapshot?.issueId === issueId || r.contextSnapshot?.taskId === issueId);
    if (run) return run;
    await sleep(3000);
  }
  return null;
}

async function settle(plan, companyId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const runs = await api(plan, "GET", `/companies/${companyId}/heartbeat-runs`);
    if (runs.every((r) => TERMINAL.has(r.status)) || Date.now() > deadline) return runs;
    await sleep(5000);
  }
}

async function collectRun(plan, label, run) {
  writeJson(plan, `run-${label}.json`, run);
  writeJson(plan, `run-${label}-log.json`, await apiOrError(plan, "GET", `/heartbeat-runs/${run.id}/log`));
  writeJson(plan, `run-${label}-events.json`, await apiOrError(plan, "GET", `/heartbeat-runs/${run.id}/events`));
  await sleep(5000);
  writeJson(plan, `processes-after-${label}.json`, processesUnder(plan.root));
}

function findSessionParams(value, out = []) {
  if (value && typeof value === "object") {
    if (typeof value.sessionFile === "string" && typeof value.agentDir === "string") out.push(value);
    for (const child of Object.values(value)) findSessionParams(child, out);
  }
  return out;
}

function listTree(dir, depth) {
  if (!fs.existsSync(dir)) return "missing";
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) out[entry.name] = `-> ${fs.readlinkSync(full)}`;
    else if (entry.isDirectory()) out[entry.name] = depth > 1 ? listTree(full, depth - 1) : "dir";
    else out[entry.name] = "file";
  }
  return out;
}

async function scenarios(plan, check) {
  const company = await api(plan, "POST", "/companies", { name: "WP7 Smoke Co" });
  const cid = company.id;
  const control = await api(plan, "POST", `/companies/${cid}/agents`, {
    name: "Control Process", role: "general", adapterType: "process",
    adapterConfig: { command: "/bin/true" }, runtimeConfig: { heartbeat: { enabled: false } },
  });

  const companyBefore = await api(plan, "GET", `/companies/${cid}`);
  const install = spawnSync("bash", [path.join(REPO, "scripts", "install-local.sh"), "--api-url", plan.apiUrl, "--skip-build"],
    { env: plan.env, encoding: "utf8" });
  fs.writeFileSync(path.join(plan.evidence, "install-local.log"), `exit=${install.status}\n${install.stdout}${install.stderr}`);
  check("install-local.sh exits 0", install.status === 0, `exit ${install.status}`);
  const companyAfter = await api(plan, "GET", `/companies/${cid}`);
  check("company record unchanged by the install (L15)", JSON.stringify(companyAfter) === JSON.stringify(companyBefore),
    `requireBoardApprovalForNewAgents=${companyAfter.requireBoardApprovalForNewAgents}`);
  const adapter = await api(plan, "GET", "/adapters/prime_agent_local");
  writeJson(plan, "adapter.json", adapter);
  check("adapter loaded from external plugin", adapter.loaded === true && adapter.source === "external", JSON.stringify(adapter));
  writeJson(plan, "config-schema.json", await apiOrError(plan, "GET", "/adapters/prime_agent_local/config-schema"));
  const models = await apiOrError(plan, "GET", `/companies/${cid}/adapters/prime_agent_local/models`);
  writeJson(plan, "models.json", models);
  check("model list includes the smoke model", JSON.stringify(models).includes(`"${MODEL}"`), MODEL);

  if (plan.args.runtime === "daemon") return await daemonScenarios(plan, check, cid);

  const adapterConfig = { command: plan.args.primeCommand, model: MODEL, thinking: "off", cwd: plan.workspace, timeoutSec: 600 };
  const runtimeConfig = { heartbeat: { enabled: false, maxConcurrentRuns: 1 } };
  const coordinator = await api(plan, "POST", `/companies/${cid}/agents`, {
    name: "Coordinator", role: "ceo", adapterType: "prime_agent_local", adapterConfig, runtimeConfig,
  });
  const specialist = await api(plan, "POST", `/companies/${cid}/agents`, {
    name: "Specialist", role: "engineer", reportsTo: coordinator.id, adapterType: "prime_agent_local", adapterConfig, runtimeConfig,
  });
  writeJson(plan, "agents.json", { company, control, coordinator, specialist });
  await setInstructions(plan, coordinator.id, instructions("coordinator", specialist.id));
  await setInstructions(plan, specialist.id, instructions("specialist"));

  const envTest = await api(plan, "POST", `/companies/${cid}/adapters/prime_agent_local/test-environment`, { adapterConfig });
  writeJson(plan, "test-environment.json", envTest);
  check("testEnvironment status is not fail", envTest.status !== "fail", envTest.status);

  // (a) coordinator wake without an issue
  const wake = await api(plan, "POST", `/agents/${coordinator.id}/wakeup`, { source: "on_demand", triggerDetail: "manual", reason: "wp7-coordinator" });
  const runA = await waitRun(plan, wake.id, 600000);
  await collectRun(plan, "a-coordinator", runA);
  check("(a) coordinator run succeeded", runA.status === "succeeded", runA.status);
  const created = sql(plan, `select id, identifier, title, status, assignee_agent_id from issues where company_id = '${cid}' and assignee_agent_id = '${specialist.id}'`);
  check("(a) exactly one issue assigned to the specialist", created.length === 1, JSON.stringify(created));
  const issueId = created[0]?.id;

  // (b) specialist wake on that issue (Paperclip wakes the assignee on assignment)
  const startB = issueId ? await waitIssueRun(plan, cid, specialist.id, issueId, 180000) : null;
  check("(b) specialist run started for the issue", startB !== null, String(issueId));
  if (startB) {
    const runB = await waitRun(plan, startB.id, 600000);
    await collectRun(plan, "b-specialist", runB);
    check("(b) specialist run succeeded", runB.status === "succeeded", runB.status);
    const issue = sql(plan, `select status from issues where id = '${issueId}'`)[0];
    const comments = sql(plan, `select body, author_agent_id from issue_comments where issue_id = '${issueId}'`);
    writeJson(plan, "issue-b.json", { issue, comments });
    check("(b) issue done with HERON-7 comment", issue?.status === "done" && comments.some((c) => c.body.includes("HERON-7")), JSON.stringify(issue));
  }

  // (c) both agents at once, both on the symlinked host subscription
  const [issueC1, issueC2] = await Promise.all([
    api(plan, "POST", `/companies/${cid}/issues`, { title: "WP7 concurrency A", description: "Post a comment containing HERON-7, then mark this issue done.", status: "todo", assigneeAgentId: coordinator.id }),
    api(plan, "POST", `/companies/${cid}/issues`, { title: "WP7 concurrency B", description: "Post a comment containing HERON-7, then mark this issue done.", status: "todo", assigneeAgentId: specialist.id }),
  ]);
  const [startC1, startC2] = await Promise.all([
    waitIssueRun(plan, cid, coordinator.id, issueC1.id, 180000),
    waitIssueRun(plan, cid, specialist.id, issueC2.id, 180000),
  ]);
  check("(c) both concurrent runs started", startC1 !== null && startC2 !== null, "");
  if (startC1 && startC2) {
    const [runC1, runC2] = await Promise.all([waitRun(plan, startC1.id, 600000), waitRun(plan, startC2.id, 600000)]);
    await collectRun(plan, "c-coordinator", runC1);
    await collectRun(plan, "c-specialist", runC2);
    check("(c) both concurrent runs succeeded", runC1.status === "succeeded" && runC2.status === "succeeded", `${runC1.status} ${runC2.status}`);
    const overlap = Date.parse(runC1.startedAt) < Date.parse(runC2.finishedAt) && Date.parse(runC2.startedAt) < Date.parse(runC1.finishedAt);
    check("(c) the two runs overlapped in time", overlap, `${runC1.startedAt}..${runC1.finishedAt} / ${runC2.startedAt}..${runC2.finishedAt}`);
  }

  // Evidence: usage rows, session params, agent dirs, auth links
  const allRuns = await settle(plan, cid, 300000);
  writeJson(plan, "runs-all.json", allRuns.map((r) => ({ id: r.id, agentId: r.agentId, status: r.status, source: r.invocationSource,
    issueId: r.contextSnapshot?.issueId ?? null, startedAt: r.startedAt, finishedAt: r.finishedAt, errorCode: r.errorCode })));
  check("all company runs settled", allRuns.every((r) => TERMINAL.has(r.status)), `${allRuns.length} runs`);
  writeJson(plan, "cost-events.json", sql(plan, `select heartbeat_run_id, agent_id, provider, model, biller, billing_type, input_tokens, cached_input_tokens, output_tokens, cost_cents, cost_status from cost_events where company_id = '${cid}' order by occurred_at`));
  const agentDirs = {};
  for (const agent of [coordinator, specialist]) {
    const agentDir = path.join(plan.instanceRoot, "companies", cid, "agents", agent.id, "prime-agent-home");
    agentDirs[agent.name] = agentDir;
    const sessions = {
      runtimeState: await api(plan, "GET", `/agents/${agent.id}/runtime-state`),
      taskSessions: await api(plan, "GET", `/agents/${agent.id}/task-sessions`),
    };
    writeJson(plan, `sessions-${agent.name}.json`, sessions);
    const params = findSessionParams(sessions);
    check(`${agent.name}: sessionParams point into its own agent dir`,
      params.length > 0 && params.every((p) => p.agentDir === agentDir && p.sessionFile.startsWith(agentDir + path.sep) && fs.existsSync(p.sessionFile)),
      JSON.stringify(params));
    const authPath = path.join(agentDir, "auth.json");
    const isLink = fs.lstatSync(authPath, { throwIfNoEntry: false })?.isSymbolicLink() === true;
    check(`${agent.name}: auth.json is still a symlink`, isLink, isLink ? fs.readlinkSync(authPath) : "not a symlink");
  }
  writeJson(plan, "agent-dirs.json", Object.fromEntries(Object.entries(agentDirs).map(([name, dir]) => [name, listTree(dir, 2)])));
  writeJson(plan, "scratch-home-prime.json", listTree(path.join(plan.home, ".prime", "agent"), 1));
  const controlAfter = await api(plan, "GET", `/agents/${control.id}`);
  check("control agent unchanged (L15)", controlAfter.adapterType === control.adapterType
    && JSON.stringify(controlAfter.adapterConfig) === JSON.stringify(control.adapterConfig), controlAfter.adapterType);
}

async function daemonScenarios(plan, check, cid) {
  const adapterConfig = { command: plan.args.primeCommand, model: MODEL, thinking: "off", cwd: plan.workspace, timeoutSec: 600,
    runtime: "daemon", rlmMaxDepth: 1, subagentDefaultModel: MODEL };
  const specialist = await api(plan, "POST", `/companies/${cid}/agents`, {
    name: "Specialist", role: "engineer", adapterType: "prime_agent_local", adapterConfig,
    runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 1 } },
  });
  writeJson(plan, "agents.json", { specialist });
  await setInstructions(plan, specialist.id, [...HEADER,
    "Step 2. Run this code once:", "```python",
    "import inspect",
    "async def call(x): return await x if inspect.isawaitable(x) else x",
    'found = await call(rlm.harness.search("proof codeword", kind="memory", global_=True))',
    "print(found)", "```",
    "If an entry was found: reply MEMORY SAYS plus its full content (including the child word stored there) and stop.",
    "Step 3. Run this code once:", "```python",
    'h = await rlm.spawn("Reply with only this: the word KESTREL, a hyphen, then the number four as a digit.", name="proof-child", model="anthropic/claude-haiku-4-5")',
    "print(await rlm.collect(timeout_ms=180000))", "```",
    "If collect says running, end this turn with WAITING FOR CHILD. Do not run Step 4 or invent a child answer. When the child reply arrives, continue at Step 4, not Step 2.",
    "Step 4. Only after receiving the actual child reply: set child_word to its exact reply text in Python, then run:", "```python",
    'await call(rlm.harness.create_memory("proof codeword", "The proof codeword is OSPREY-9. The child word is " + child_word, global_=True))',
    "print(pc('POST', '/api/companies/' + os.environ['PAPERCLIP_COMPANY_ID'] + '/issues', {'title': 'Daemon proof ' + os.environ['PAPERCLIP_RUN_ID'], 'status': 'todo'}))",
    "```", "Reply CHILD SAID plus the child's word and stop.",
  ].join("\n"));
  const issue = await api(plan, "POST", `/companies/${cid}/issues`, {
    title: "Daemon specialist proof", description: "Follow the daemon proof instructions: spawn a child, use its actual reply, and store memory. On the next run recall both memory and child word. Do not change issue status or post comments.",
    status: "todo", assigneeAgentId: specialist.id,
  });
  writeJson(plan, "proof-issue.json", issue);
  const runs = [];
  for (const label of ["d1", "d2"]) {
    const wake = label === "d1"
      ? await waitIssueRun(plan, cid, specialist.id, issue.id, 180000)
      : await api(plan, "POST", `/agents/${specialist.id}/wakeup`, { source: "on_demand", triggerDetail: "manual", reason: "daemon-d2", payload: { issueId: issue.id } });
    if (!wake) throw new Error("Specialist issue run did not start.");
    const run = await waitRun(plan, wake.id, 600000);
    await collectRun(plan, label, run); runs.push(run);
    const out = spawnSync("pgrep", ["-af", "--", "--mode daemon"], { env: plan.env, encoding: "utf8" });
    fs.writeFileSync(path.join(plan.evidence, `pgrep-after-${label}.txt`), out.stdout);
    check(`(d) no daemon after ${label.toUpperCase()}`, !out.stdout.split("\n").some(line => line.includes(plan.root)), "");
    const sessions = await api(plan, "GET", `/agents/${specialist.id}/task-sessions`);
    writeJson(plan, `sessions-${label}.json`, sessions.filter(session => session.taskKey === issue.id));
  }
  const params = runs.map((run, i) => findSessionParams(run)[0] ?? findSessionParams(JSON.parse(fs.readFileSync(path.join(plan.evidence, `sessions-d${i + 1}.json`), "utf8")))[0]);
  const text = label => fs.readFileSync(path.join(plan.evidence, `run-${label}.json`), "utf8") + fs.readFileSync(path.join(plan.evidence, `run-${label}-log.json`), "utf8");
  const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : entry.isFile() ? [path.join(dir, entry.name)] : []);
  const child = params[0] && files(params[0].agentDir).find(file => file.endsWith(".jsonl") && file !== params[0].sessionFile && fs.readFileSync(file, "utf8").includes("KESTREL-4"));
  check("(a) D1 succeeded and used the child's reply", runs[0].status === "succeeded" && text("d1").includes("CHILD SAID KESTREL-4") && Boolean(child), child ?? "no child session");
  check("(b) D2 resumed the D1 session and recalled the memory", runs[1].status === "succeeded" && Boolean(params[0]?.sessionId) && Boolean(params[1]?.sessionId) && params[0].sessionId === params[1].sessionId && runs[1].sessionIdAfter === runs[0].sessionIdAfter && text("d2").includes("MEMORY SAYS") && text("d2").includes("OSPREY-9") && text("d2").includes("harness.search") && text("d2").includes("KESTREL-4"), JSON.stringify(params));
  const issues = await api(plan, "GET", `/companies/${cid}/issues`);
  writeJson(plan, "issues.json", issues);
  check("(c) D1 created its issue with its own run key", issues.filter(issue => issue.title === `Daemon proof ${runs[0].id}`).length === 1, "");
  writeJson(plan, "cost-events.json", sql(plan, `select heartbeat_run_id, agent_id, provider, model, biller, billing_type, input_tokens, cached_input_tokens, output_tokens, cost_cents, cost_status from cost_events where company_id = '${cid}' order by occurred_at`));
  writeJson(plan, "proof-session-params.json", params);
  writeJson(plan, "proof-child-session.json", { file: child ?? null });
}

async function live(plan) {
  for (const port of [SERVER_PORT, DB_PORT]) if (await portInUse(port)) die(`port ${port} is in use`);
  const hostAuth = fs.statSync(plan.args.hostAuthFile, { throwIfNoEntry: false });
  if (!hostAuth?.isFile() || (hostAuth.mode & 0o077) !== 0) die(`host auth file missing or not mode 0600: ${plan.args.hostAuthFile}`);
  for (const dir of [plan.root, plan.env.TMPDIR, plan.workspace, plan.evidence, plan.instanceRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(plan.home, ".prime", "agent"), { recursive: true, mode: 0o700 });
  fs.symlinkSync(plan.args.hostAuthFile, path.join(plan.home, ".prime", "agent", "auth.json"));
  fs.writeFileSync(path.join(plan.instanceRoot, "config.json"), JSON.stringify(plan.config, null, 2) + "\n");
  writeJson(plan, "self-test.json", selfTest(plan));
  const before = liveState();
  writeJson(plan, "live-state-before.json", before);

  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass: Boolean(pass), detail });
    process.stdout.write(`${pass ? "PASS" : "FAIL"} ${name}\n`);
  };
  const log = fs.openSync(path.join(plan.evidence, "server.log"), "a");
  const server = spawn(path.join(plan.args.nodeBinDir, "node"), [plan.args.paperclipCli, "run", "-i", INSTANCE_ID],
    { cwd: plan.root, env: plan.env, detached: true, stdio: ["ignore", log, log] });
  const exited = new Promise((resolve) => server.once("exit", resolve));
  try {
    const deadline = Date.now() + 180000;
    let health = null;
    while (health?.status !== "ok" && Date.now() < deadline && server.exitCode === null) {
      health = await api(plan, "GET", "/health").catch(() => null);
      if (health?.status !== "ok") await sleep(2000);
    }
    writeJson(plan, "health.json", health);
    check("throwaway Paperclip is healthy", health?.status === "ok", health?.version ?? "no health response");
    if (health?.status === "ok") await scenarios(plan, check);
  } catch (err) {
    check("smoke finished without an exception", false, String(err.stack ?? err));
  } finally {
    process.kill(-server.pid, "SIGTERM");
    const stopped = await Promise.race([exited.then(() => true), sleep(60000).then(() => false)]);
    if (!stopped) process.kill(-server.pid, "SIGKILL");
    check("server stopped within 60 s", stopped, "");
    check("ports released", !(await portInUse(SERVER_PORT)) && !(await portInUse(DB_PORT)), `${SERVER_PORT} ${DB_PORT}`);
    const leftovers = processesUnder(plan.root);
    writeJson(plan, "processes-final.json", leftovers);
    check("no prime-agent process left under the scratch root", leftovers.length === 0, JSON.stringify(leftovers));
    const after = liveState();
    writeJson(plan, "live-state-after.json", after);
    const changed = Object.keys(before).filter((key) => key !== ".prime/agent/auth.json" && JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    check("live Paperclip and host Prime stop-class state unchanged (L2)", changed.length === 0, changed.join(", "));
    writeJson(plan, "SUMMARY.json", { passed: results.every((r) => r.pass), results });
  }
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

const args = parseArgs(process.argv.slice(2));
const plan = buildPlan(args);
if (args.printPlan) {
  process.stdout.write(JSON.stringify({
    root: plan.root,
    instanceRoot: plan.instanceRoot,
    apiUrl: plan.apiUrl,
    serverPort: plan.serverPort,
    dbPort: plan.dbPort,
    env: plan.env,
    config: plan.config,
    selfTest: selfTest(plan),
  }, null, 2) + "\n");
} else {
  await live(plan);
}
