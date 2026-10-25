#!/usr/bin/env node
// Test double for prime-agent 0.10.0 (WP3). It never calls a model.
// Every invocation appends {argv, cwd, env, pid} as one JSON line to $FAKE_PRIME_RECORD.
import { appendFileSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const env = process.env;
if (env.FAKE_PRIME_RECORD) appendFileSync(env.FAKE_PRIME_RECORD, `${JSON.stringify({ argv, cwd: process.cwd(), env, pid: process.pid })}\n`);
const resumeIndex = argv.indexOf("-r");
const mode = resumeIndex >= 0 && env.FAKE_PRIME_RESUME_MODE ? env.FAKE_PRIME_RESUME_MODE : (env.FAKE_PRIME_MODE ?? "echo");
if (argv[0] === "--version") {
  await new Promise((resolve) => setTimeout(resolve, Number(env.FAKE_PRIME_VERSION_DELAY_MS ?? "0")));
  process.stdout.write(`${env.FAKE_PRIME_VERSION ?? "0.10.0"}\n`);
} else if (argv[0] === "model" && argv[1] === "list") {
  process.stdout.write(readFileSync(env.FAKE_PRIME_MODEL_LIST, "utf8"));
} else if (mode === "unknown_session") {
  process.stderr.write(`Error: No session found matching '${argv[resumeIndex + 1]}'\n`);
  process.exitCode = 1;
} else if (mode === "hang") {
  if (env.FAKE_PRIME_IGNORE_TERM === "1") process.on("SIGTERM", () => {});
  process.stdout.write(`${readFileSync(env.FAKE_PRIME_STDOUT_FILE, "utf8").split("\n")[0]}\n`);
  setInterval(() => {}, 1000);
} else {
  const stdout = readFileSync(env.FAKE_PRIME_STDOUT_FILE, "utf8");
  const text = mode === "drop_agent_end" ? stdout.split("\n").filter((line) => !line.includes('"type":"agent_end"')).join("\n") : stdout;
  const chunkBytes = Number(env.FAKE_PRIME_CHUNK_BYTES ?? "0");
  for (let i = 0; i < text.length; i += chunkBytes > 0 ? chunkBytes : text.length) {
    process.stdout.write(text.slice(i, chunkBytes > 0 ? i + chunkBytes : text.length));
    if (chunkBytes > 0) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (env.FAKE_PRIME_STDERR) process.stderr.write(env.FAKE_PRIME_STDERR);
  if (env.FAKE_PRIME_WRITE_SESSION === "1") {
    // TAI-225 §9 audit: the session header plus one message line per assistant message_end, as Prime writes them.
    const events = text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
    const header = events.find((e) => e.type === "session");
    const lines = [header, ...events.filter((e) => e.type === "message_end" && e.message?.role === "assistant").map((e) => ({ type: "message", message: e.message }))];
    const { appendFileSync: append, mkdirSync } = await import("node:fs");
    const dir = argv[argv.indexOf("--session-dir") + 1];
    mkdirSync(dir, { recursive: true });
    append(`${dir}/${header.id}.jsonl`, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  }
  process.exitCode = Number(env.FAKE_PRIME_EXIT_CODE ?? "0");
}
