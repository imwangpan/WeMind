// M1 smoke harness: drive `opencode acp` exactly like wemind's acp-brain.ts does.
// Newline-delimited JSON-RPC 2.0 over stdio; clientCapabilities: {} (same as WeMind).
// Goal: prove initialize / session/new / session/prompt plumbing, and detect any
// server->client reverse requests (fs/read_text_file, fs/write_text_file,
// session/request_permission, terminal/*) that WeMind's client does NOT handle.
//
// 用法（Windows）：
//   $env:OPENCODE_EXE = "<...>/opencode.exe"   # 省略则用 PATH 上的 opencode
//   node scripts/acp-smoke.mjs
// 详见 docs/接入-OpenCode.md 附录 A。smoke2 另测 session/load 自愈与工具调用。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = process.env.OPENCODE_EXE || "opencode";
const workDir = path.join(os.tmpdir(), "wemind-acp-smoke");
fs.mkdirSync(workDir, { recursive: true });

const log = (...a) => console.error("[smoke]", ...a);

const child = spawn(EXE, ["acp"], {
  cwd: workDir,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  shell: false,
});

let buf = "";
const frames = [];
const reverseRequests = [];
let idc = 0;
const pending = new Map();
const updateTypes = new Set();
const answerChunks = [];

child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let f;
    try {
      f = JSON.parse(line);
    } catch {
      log("non-JSON stdout:", line.slice(0, 200));
      continue;
    }
    frames.push(f);
    handleFrame(f);
  }
});

child.stderr.on("data", (d) => log("stderr:", d.toString().trim().slice(0, 500)));
child.on("exit", (code) => log("process exited code=", code));

function handleFrame(f) {
  if (
    typeof f.id === "number" &&
    (f.result !== undefined || f.error !== undefined) &&
    pending.has(f.id)
  ) {
    const p = pending.get(f.id);
    pending.delete(f.id);
    clearTimeout(p.timer);
    if (f.error) p.reject(new Error(JSON.stringify(f.error)));
    else p.resolve(f.result);
    return;
  }
  // Server -> client request: has a method AND an id, but no matching pending call.
  if (f.method && f.id !== undefined) {
    reverseRequests.push(f);
    log(">>> REVERSE REQUEST:", f.method, JSON.stringify(f.params).slice(0, 300));
    // Answer unknown reverse requests with an error so we don't hang, but keep the record.
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: f.id,
        error: { code: -32601, message: "method not supported by smoke client" },
      }) + "\n",
    );
    return;
  }
  if (f.method === "session/update") {
    const u = f.params?.update;
    if (u?.sessionUpdate) updateTypes.add(String(u.sessionUpdate));
    if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      answerChunks.push(String(u.content.text ?? ""));
    }
    return;
  }
  if (f.method) log("notification:", f.method);
  else log("frame:", JSON.stringify(f).slice(0, 300));
}

function request(method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = ++idc;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    log("→", method, `#${id}`);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v) => JSON.stringify(v).slice(0, 400);

(async () => {
  const results = {};

  try {
    results.initialize = await request(
      "initialize",
      { protocolVersion: 1, clientCapabilities: {} },
      30000,
    );
  } catch (e) {
    results.initialize = "ERROR: " + e.message;
  }

  let sid;
  try {
    const s = await request("session/new", { cwd: workDir, mcpServers: [] }, 30000);
    results.sessionNew = s;
    sid = s?.sessionId;
  } catch (e) {
    results.sessionNew = "ERROR: " + e.message;
  }

  if (sid) {
    try {
      results.prompt = await request(
        "session/prompt",
        { sessionId: sid, prompt: [{ type: "text", text: "Reply with exactly: OK" }] },
        90000,
      );
    } catch (e) {
      results.prompt = "ERROR: " + e.message;
    }
  }

  await sleep(500);
  log("==================== SUMMARY ====================");
  log("initialize :", short(results.initialize));
  log("session/new:", short(results.sessionNew));
  log("prompt     :", short(results.prompt));
  log("updateTypes:", [...updateTypes].join(",") || "(none)");
  log("answerText :", JSON.stringify(answerChunks.join("")));
  log(
    "REVERSE REQUESTS:",
    reverseRequests.length ? reverseRequests.map((r) => r.method).join(", ") : "(none)",
  );
  log("total stdout frames:", frames.length);
  try {
    child.kill();
  } catch {}
  process.exit(0);
})();
