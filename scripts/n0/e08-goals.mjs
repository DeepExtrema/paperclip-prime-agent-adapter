// N0 e08: goals.
//  1. Where a goal set by the model (goal.create) is stored in the session file.
//  2. Whether `create` with sessionPath, for a session whose goal is active and whose continuation is owed, starts a turn before any prompt.
//  3. Whether a command from outside the model ("/goal clear" as a prompt) clears the goal without a model call.
// The fake server leaves goal continuation prompts unanswered while s.goalHangFile exists, so the run stops with a continuation owed.
import fs from "node:fs";
import { createConfig, delay, requests, scratch, seedAgentDir, show, startDaemon, startFake, turn } from "./harness.mjs";
import { entries } from "./session-file.mjs";

const s = scratch("e08");
const fake = await startFake(s);
seedAgentDir(s, fake);
const goalEntries = (file) => entries(file).filter((e) => e.type !== "message" && JSON.stringify(e).toLowerCase().includes("goal")).map((e) => JSON.stringify(e).slice(0, 700));
const continuations = (from) => requests(s).slice(from).filter((r) => r.lastUserText.includes("[goal: continuation]")).length;
let file;
{
  const d = await startDaemon(s);
  try {
    const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
    file = created.data.sessionFile;
    const sid = created.data.activeSessionId;
    show("get_commands", ((await d.req({ type: "get_commands", activeSessionId: sid })).data?.commands ?? []).map((c) => `${c.name ?? c}${c.source ? ` (${c.source})` : ""}`));
    fs.writeFileSync(s.goalHangFile, "1");
    const r0 = requests(s).length;
    show("prompt_and_wait: goal.create", await d.req({ type: "prompt_and_wait", activeSessionId: sid, queueIfBusy: false,
      message: "BEGINCMD\nprint(await goal.create('N0 foreign objective'))\nENDCMD" }, 60_000));
    await delay(3000);
    show("goal continuation requests so far (hung)", continuations(r0));
    show("roster", (await d.req({ type: "list" })).data.sessions.map((r) => `${r.activeSessionId}:${r.activity}`));
  } finally {
    await d.stop();
  }
}
show("session file entry types", [...new Set(entries(file).map((e) => e.type))]);
show("goal-bearing non-message entries", goalEntries(file));
await delay(500);
{
  const d = await startDaemon(s);
  try {
    const r0 = requests(s).length;
    const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s), sessionPath: file }, 60_000);
    const sid = created.data.activeSessionId;
    await delay(8000);
    const auto = continuations(r0);
    show("goal continuation requests in 8 s after create with sessionPath, before any prompt", auto);
    show("roster after resume", (await d.req({ type: "list" })).data.sessions.map((r) => `${r.activeSessionId}:${r.activity}`));
    if (auto > 0) show("abort the self-started turn", await d.req({ type: "abort", activeSessionId: sid }));
    fs.rmSync(s.goalHangFile, { force: true });
    await delay(1000);
    const r1 = requests(s).length;
    show("prompt_and_wait '/goal clear'", await d.req({ type: "prompt_and_wait", activeSessionId: sid, message: "/goal clear", queueIfBusy: false }, 60_000));
    await delay(3000);
    show("model requests after '/goal clear'", requests(s).slice(r1).map((r) => r.lastUserText.slice(0, 160)));
    show("goal-bearing entries after clear (last 3)", goalEntries(file).slice(-3));
    fs.writeFileSync(s.goalHangFile, "1");
    await d.req({ type: "prompt_and_wait", activeSessionId: sid, message: "BEGINCMD\nprint('GOAL', await goal.get())\nENDCMD", queueIfBusy: false }, 60_000);
    await delay(2000);
    show("goal.get after clear", entries(file).filter((e) => e.type === "message" && e.message?.role === "toolResult").slice(-1).map((e) => JSON.stringify(e.message.content).slice(0, 700)));
    show("continuations after goal.get", continuations(r1));
  } finally {
    await d.stop();
    fake.stop();
  }
}
fs.copyFileSync(file, `${s.dir}/session-file-copy.jsonl`);
show("scratch", s.dir);
