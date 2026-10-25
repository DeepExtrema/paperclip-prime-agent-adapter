// N0 e04: which daemon command names does 0.10.1 accept? "Unknown daemon command" means no such command.
import { createConfig, scratch, seedAgentDir, show, startDaemon, startFake } from "./harness.mjs";

const names = ["list", "kill", "stop", "close", "shutdown", "cancel_rlm_child", "delete_rlm_subagent", "roster_subscribe", "roster_unsubscribe", "subscribe",
  "get_state", "get_system_prompt", "get_resource_snapshot", "send_message", "agent_message", "cron_list", "cron_cancel", "heartbeats_list", "heartbeat_set",
  "goal_clear", "clear_goal", "goal", "get_goal", "set_goal", "archive", "remove", "destroy", "close_session", "end_session", "stop_session", "terminate",
  "kill_session", "delete_session", "delete_saved_session", "complete_owned_session", "detach", "abort", "wait_for_idle", "get_session_header", "get_messages",
  "worker_idle_passivation", "get_rlm_max_depth_status", "reload", "refine", "new_session", "rename", "agent_messages_pause", "list_children", "get_children"];
const s = scratch("e04");
const fake = await startFake(s);
seedAgentDir(s, fake);
const d = await startDaemon(s);
try {
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
  const sid = created.data.activeSessionId;
  const out = {};
  for (const name of names) {
    if (["shutdown"].includes(name)) continue;
    const r = await d.req({ type: name, activeSessionId: "000000000000", childId: "000000000000" }, 10_000).catch((e) => ({ error: `request failed: ${e.message}` }));
    out[name] = r.success ? "ok" : (r.error ?? "").slice(0, 160);
  }
  show("results", out);
  show("still alive", (await d.req({ type: "list" })).data.sessions.map((r) => r.activeSessionId).includes(sid));
} finally {
  await d.stop();
  fake.stop();
}
