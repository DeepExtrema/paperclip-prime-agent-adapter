// N0 (TAI-273 plan rev 4, section 5 step 2): a scripted stand-in for the Anthropic Messages API.
// It never forwards anything. Run it only inside scripts/n0/offline.sh, whose network namespace has loopback only.
//
// The reply is chosen from the newest user text in the request:
//   BEGINCMD python ENDCMD  one python_repl call per marker, in order; after the last one, the reply is "DONE".
//   SAY<<<text>>>    a text reply.
//   SLEEP<<<n>>>     the text reply "SLEPT" after n seconds (a busy model).
//   anything else    the text reply "OK".
// A request whose system prompt is Prime's /refine subsystem gets one JSON refinement that creates a prompt note (N0REFINEPROMPT).
// FAKE_GOAL_HANG_FILE: while the file exists, a goal continuation prompt gets no answer for 10 minutes.
// FAKE_RETRY_AFTER: the retry-after header (seconds) on a 429, default 30.
// FAKE_STATUS_FILE: when the file holds an HTTP status (for example 401 or 429), every request gets that error.
// FAKE_BODIES: when set, every raw request body is appended there too (one JSON line each).
// FAKE_LOG: one JSON line per request (path, header names, auth scheme and key prefix, betas, system text, tools, last user text).
import fs from "node:fs";
import http from "node:http";

const port = Number(process.env.FAKE_PORT ?? 0);
const logFile = process.env.FAKE_LOG ?? null;
const statusFile = process.env.FAKE_STATUS_FILE ?? null;
const goalHangFile = process.env.FAKE_GOAL_HANG_FILE ?? null;
let counter = 0;

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";

function plan(messages) {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === "user" && textOf(m.content).trim() !== "" && !(Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_result"))) {
      lastUser = i;
      break;
    }
  }
  const text = lastUser >= 0 ? textOf(messages[lastUser].content) : "";
  const done = messages.slice(lastUser + 1).filter((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_use")).length;
  const cmds = [...text.matchAll(/BEGINCMD\n?([\s\S]*?)\n?ENDCMD/g)].map((m) => m[1]);
  if (cmds.length > 0) return done < cmds.length ? { tool: cmds[done], text } : { say: "DONE", text };
  if (text.includes("[goal: continuation]") && goalHangFile && fs.existsSync(goalHangFile)) return { say: "HUNG", sleepMs: 600_000, text };
  const sleep = /SLEEP<<<(\d+)>>>/.exec(text);
  if (sleep) return { say: "SLEPT", sleepMs: Number(sleep[1]) * 1000, text };
  const say = /SAY<<<([\s\S]*?)>>>/.exec(text);
  return { say: say ? say[1] : "OK", text };
}

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function reply(res, body, choice) {
  const id = `msg_fake_${++counter}`;
  const model = body.model ?? "fake";
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let block;
  let stop;
  if (choice.tool !== undefined) {
    const tool = (body.tools ?? []).find((t) => t.name === "python_repl") ?? (body.tools ?? [])[0];
    const field = tool?.input_schema?.required?.[0] ?? Object.keys(tool?.input_schema?.properties ?? { code: 1 })[0];
    block = { type: "tool_use", id: `toolu_fake_${counter}`, name: tool?.name ?? "python_repl", input: { [field]: choice.tool } };
    stop = "tool_use";
  } else {
    block = { type: "text", text: choice.say };
    stop = "end_turn";
  }
  if (body.stream === false) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, type: "message", role: "assistant", model, content: [block], stop_reason: stop, usage }));
    return;
  }
  const start = block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} };
  const delta = block.type === "text" ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) };
  sse(res, [
    ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: start }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function authSummary(headers) {
  const auth = headers.authorization ?? null;
  const key = headers["x-api-key"] ?? null;
  return {
    scheme: auth ? auth.split(" ")[0] : key ? "x-api-key" : null,
    keyPrefix: (auth ? auth.split(" ")[1] ?? "" : key ?? "").slice(0, 14) || null,
  };
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { unparsed: raw.slice(0, 200) }; }
    const status = statusFile && fs.existsSync(statusFile) ? Number(fs.readFileSync(statusFile, "utf8").trim()) : 200;
    const systemText = Array.isArray(body.system) ? body.system.map((b) => b.text ?? "").join("\n") : String(body.system ?? "");
    const choice = systemText.includes("/refine continual harness subsystem")
      ? { say: JSON.stringify({ summary: "N0 probe", rationale: "N0 probe", expectedOutcome: "N0 probe",
          edits: [{ action: "create", kind: "prompt", title: "N0 refine prompt", content: "N0REFINEPROMPT", reason: "N0 probe" }] }), text: "(refiner)" }
      : Array.isArray(body.messages) ? plan(body.messages) : { say: "OK", text: "" };
    if (process.env.FAKE_BODIES) fs.appendFileSync(process.env.FAKE_BODIES, `${JSON.stringify({ at: new Date().toISOString(), body })}\n`);
    if (logFile) {
      const system = Array.isArray(body.system) ? body.system.map((b) => b.text ?? "").join("\n") : String(body.system ?? "");
      fs.appendFileSync(logFile, `${JSON.stringify({
        at: new Date().toISOString(), method: req.method, path: req.url, status, model: body.model ?? null, stream: body.stream ?? null,
        headerNames: Object.keys(req.headers).sort(), auth: authSummary(req.headers),
        beta: req.headers["anthropic-beta"] ?? null, userAgent: req.headers["user-agent"] ?? null,
        tools: (body.tools ?? []).map((t) => t.name), system, messageCount: body.messages?.length ?? null,
        lastUserText: choice.text.slice(0, 2000), reply: choice.tool !== undefined ? { tool: choice.tool } : { say: choice.say ?? null },
      })}\n`);
    }
    if (req.url?.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    if (status !== 200) {
      const type = status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : status === 403 ? "permission_error" : "api_error";
      const headers = { "content-type": "application/json", "request-id": `req_fake_${counter}` };
      if (status === 429) Object.assign(headers, { "retry-after": process.env.FAKE_RETRY_AFTER ?? "30", "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 3600) });
      res.writeHead(status, headers);
      res.end(JSON.stringify({ type: "error", error: { type, message: status === 401 ? "invalid x-api-key (fake)" : status === 429 ? "This request would exceed your rate limit (fake)" : "fake error" } }));
      return;
    }
    if (req.method !== "POST" || !req.url?.includes("/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `fake server has no ${req.method} ${req.url}` } }));
      return;
    }
    setTimeout(() => reply(res, body, choice), choice.sleepMs ?? 0);
  });
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (process.env.FAKE_PORT_FILE) fs.writeFileSync(process.env.FAKE_PORT_FILE, String(address.port));
  process.stdout.write(`fake-anthropic listening on 127.0.0.1:${address.port}\n`);
});
