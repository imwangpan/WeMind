// M1 smoke #2: verify session/load (WeMind self-heal path) and a tool-using prompt
// (tool_call progress + whether any reverse permission request appears).
//
// 用法（Windows）：
//   $env:OPENCODE_EXE = "<...>/opencode.exe"
//   node scripts/acp-smoke2.mjs
// 详见 docs/接入-OpenCode.md 附录 A。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = process.env.OPENCODE_EXE || "opencode";
const workDir = path.join(os.tmpdir(), "wemind-acp-smoke2");
fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });
fs.writeFileSync(path.join(workDir, "note.txt"), "the secret word is PINEAPPLE\n", "utf-8");

const log = (...a) => console.error("[smoke2]", ...a);
const child = spawn(EXE, ["acp"], { cwd: workDir, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });

let buf = "";
const reverse = [];
const updateTypes = new Set();
const toolTitles = [];
const chunks = [];
let idc = 0;
const pending = new Map();

child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let f;
    try { f = JSON.parse(line); } catch { continue; }
    if (typeof f.id === "number" && (f.result !== undefined || f.error !== undefined) && pending.has(f.id)) {
      const p = pending.get(f.id); pending.delete(f.id); clearTimeout(p.timer);
      if (f.error) p.reject(new Error(JSON.stringify(f.error))); else p.resolve(f.result);
      continue;
    }
    if (f.method && f.id !== undefined) {
      reverse.push(f.method);
      log(">>> REVERSE REQUEST:", f.method, JSON.stringify(f.params).slice(0, 200));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: f.id, error: { code: -32601, message: "unsupported" } }) + "\n");
      continue;
    }
    if (f.method === "session/update") {
      const u = f.params?.update;
      if (u?.sessionUpdate) updateTypes.add(String(u.sessionUpdate));
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") chunks.push(String(u.content.text ?? ""));
      if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") {
        const t = String(u.toolCallId ?? u.title ?? "");
        if (t && !toolTitles.includes(t)) toolTitles.push(t);
      }
    }
  }
});
child.stderr.on("data", (d) => log("stderr:", d.toString().trim().slice(0, 400)));
child.on("exit", (c) => log("exited", c));

const req = (method, params, ms) => new Promise((resolve, reject) => {
  const id = ++idc;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout ${ms}ms`)); }, ms);
  pending.set(id, { resolve, reject, timer });
  log("→", method, `#${id}`);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const r = {};
  try { r.init = await req("initialize", { protocolVersion: 1, clientCapabilities: {} }, 30000); } catch (e) { r.init = "ERR " + e.message; }
  let sid;
  try { const s = await req("session/new", { cwd: workDir, mcpServers: [] }, 30000); sid = s?.sessionId; r.new = sid; } catch (e) { r.new = "ERR " + e.message; }

  if (sid) {
    // 1) tool-using prompt
    try { r.promptTool = await req("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "Read the file note.txt in the current directory using your tools and tell me the secret word." }] }, 120000); } catch (e) { r.promptTool = "ERR " + e.message; }
    const toolAnswer = chunks.join("").trim();
    // 2) session/load (self-heal path used by WeMind)
    try { r.load = await req("session/load", { sessionId: sid, cwd: workDir, mcpServers: [] }, 30000); } catch (e) { r.load = "ERR " + e.message; }
    // 3) continue same session -> verify context restored
    chunks.length = 0;
    try { r.prompt2 = await req("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "What was the secret word? One word." }] }, 120000); } catch (e) { r.prompt2 = "ERR " + e.message; }
    r.recall = chunks.join("").trim();
    r.toolAnswer = toolAnswer;
  }

  await sleep(300);
  log("==================== SUMMARY ====================");
  log("session/new   :", JSON.stringify(r.new));
  log("tool prompt   :", JSON.stringify(r.promptTool));
  log("tool answer   :", JSON.stringify(r.toolAnswer));
  log("tool titles   :", toolTitles.join(" | ") || "(none)");
  log("session/load  :", JSON.stringify(r.load));
  log("recall prompt :", JSON.stringify(r.prompt2));
  log("recall answer :", JSON.stringify(r.recall));
  log("updateTypes   :", [...updateTypes].join(",") || "(none)");
  log("REVERSE REQS  :", reverse.length ? reverse.join(", ") : "(none)");
  try { child.kill(); } catch {}
  process.exit(0);
})();
