import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

import { DATA_DIR } from "@wemind/wechat-ilink-core";
import { BRAIN_HOME } from "./mcp-sandbox.js";

/**
 * ACP 大脑：维护一个常驻的 `kiro-cli acp` 进程（JSON-RPC over stdio，换行分隔）。
 * - 每用户一个 ACP session（原生多轮记忆）；session 映射持久化到磁盘。
 * - 自愈：session/prompt 超时/失败 → 杀进程重建；重建后用 session/load 恢复上下文。
 * - 诊断日志（[acp] 前缀，进 daemon.log）：发出请求、收帧、超时时已收 chunk 数与最后收帧时间差。
 * 跑在 brain 沙箱 KIRO_HOME 下（默认空 MCP）。只用 node 标准库 + mcp-sandbox，便于独立拆出。
 */

function dlog(...a: unknown[]): void { console.error("[acp]", ...a); }

function resolveKiroCli(): string {
  const override = process.env.KIRO_CLI_BIN?.trim();
  if (override) return override;
  const exe = process.platform === "win32" ? "kiro-cli.exe" : "kiro-cli";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  return "kiro-cli";
}

const KIRO_CLI = resolveKiroCli();
const REQ_TIMEOUT = 30_000; // initialize / session/new / session/load
const PROMPT_IDLE_MS = Number(process.env.WECHAT_BRAIN_IDLE_MS) || 45_000; // 多久没收到任何帧才算"卡死"
const PROMPT_CAP_MS = Number(process.env.WECHAT_BRAIN_CAP_MS) || 300_000; // 单回合硬上限
const SESSION_MAP_FILE = path.join(DATA_DIR, "brain-sessions.json");

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; clear: () => void; method: string };

let child: ChildProcessWithoutNullStreams | null = null;
let initialized = false;
let idCounter = 0;
const pending = new Map<number, Pending>();
const userSessions = new Map<string, string>(); // 本进程已建立的 session
const assembling = new Map<string, string[]>(); // sessionId -> 当前回合文本块
let stdoutBuf = "";
let lastFrameAt = 0; // 最近一次收到任何 stdout 帧的时间
type ProgressEvent = { type: "tool"; kind?: string; purpose?: string; title?: string } | { type: "answer" };
let currentOnProgress: ((ev: ProgressEvent) => void) | null = null; // 当前回合进度回调
let answerStarted = false; // 当前回合是否已通知"开始写回复"
const seenTools = new Set<string>(); // 当前回合已上报的工具标题，去重

function isAlive(): boolean {
  return !!child && child.exitCode === null && !child.killed;
}

/** 杀进程（按 PID 进程树）并清空内部态；不清磁盘 session 映射（留给重建后 load）。 */
function reset(): void {
  const c = child;
  child = null;
  initialized = false;
  if (c?.pid) {
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" });
      else c.kill();
    } catch { /* ignore */ }
  }
  for (const p of pending.values()) { p.clear(); p.reject(new Error("acp process reset")); }
  pending.clear();
  userSessions.clear();
  assembling.clear();
  stdoutBuf = "";
}

// ---- 磁盘 session 映射（userId -> sessionId），跨进程重建保上下文 ----
function loadSessionMap(): Record<string, string> {
  try {
    const j = JSON.parse(fs.readFileSync(SESSION_MAP_FILE, "utf-8"));
    return j && typeof j === "object" ? j : {};
  } catch { return {}; }
}
function saveSessionMap(m: Record<string, string>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SESSION_MAP_FILE, JSON.stringify(m, null, 2), "utf-8");
}

function handleFrame(f: Record<string, any>): void {
  lastFrameAt = Date.now();
  if (typeof f.id === "number" && (f.result !== undefined || f.error !== undefined)) {
    const p = pending.get(f.id);
    if (!p) return;
    p.clear();
    pending.delete(f.id);
    if (f.error) { dlog(`← ${p.method}#${f.id} ERROR ${JSON.stringify(f.error).slice(0, 200)}`); p.reject(new Error(JSON.stringify(f.error))); }
    else p.resolve(f.result);
    return;
  }
  if (f.method === "session/update") {
    const u = f.params?.update;
    if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      const arr = assembling.get(f.params.sessionId);
      if (arr) arr.push(String(u.content.text ?? ""));
      if (!answerStarted && currentOnProgress) { answerStarted = true; try { currentOnProgress({ type: "answer" }); } catch { /* ignore */ } }
    } else if ((u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") && currentOnProgress) {
      const tid = String(u.toolCallId ?? u.title ?? ""); // 每个工具调用只上报一次
      if (tid && !seenTools.has(tid)) {
        seenTools.add(tid);
        const purpose = typeof u.rawInput?.__tool_use_purpose === "string" ? u.rawInput.__tool_use_purpose : undefined;
        try { currentOnProgress({ type: "tool", kind: u.kind, purpose, title: u.title }); } catch { /* ignore */ }
      }
    }
  }
}

function onStdout(d: Buffer): void {
  stdoutBuf += d.toString();
  let i: number;
  while ((i = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, i).trim();
    stdoutBuf = stdoutBuf.slice(i + 1);
    if (!line) continue;
    let f: Record<string, any>;
    try { f = JSON.parse(line); } catch { continue; }
    handleFrame(f);
  }
}

function request(method: string, params: unknown, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!child) { reject(new Error("no acp process")); return; }
    const id = ++idCounter;
    dlog(`→ ${method}#${id}`);
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout after ${timeoutMs}ms`)); }, timeoutMs);
    pending.set(id, { resolve, reject, clear: () => clearTimeout(t), method });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

/**
 * session/prompt 专用：空闲超时（PROMPT_IDLE_MS 内无任何帧才判卡死）+ 硬上限（PROMPT_CAP_MS）。
 * 只要 brain 还在出帧（工具进度/正文），就不打断——避免误杀"慢但在干活"的长查询。
 */
function promptRequest(params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!child) { reject(new Error("no acp process")); return; }
    const id = ++idCounter;
    const startedAt = Date.now();
    lastFrameAt = Date.now(); // 重置空闲基线：从本次 prompt 发出算起，避免用上一回合的旧时间戳误判
    dlog(`→ session/prompt#${id} (idle=${PROMPT_IDLE_MS}ms cap=${PROMPT_CAP_MS}ms)`);
    const iv = setInterval(() => {
      const idle = Date.now() - lastFrameAt;
      const total = Date.now() - startedAt;
      if (idle > PROMPT_IDLE_MS || total > PROMPT_CAP_MS) {
        if (pending.delete(id)) {
          clearInterval(iv);
          reject(new Error(`session/prompt ${idle > PROMPT_IDLE_MS ? "idle" : "cap"} timeout (idle=${idle}ms total=${total}ms)`));
        }
      }
    }, 5000);
    pending.set(id, { resolve, reject, clear: () => clearInterval(iv), method: "session/prompt" });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "session/prompt", params }) + "\n");
  });
}

async function ensureProcess(): Promise<void> {
  if (isAlive() && initialized) return;
  reset();
  const proc = spawn(KIRO_CLI, ["acp", "--trust-all-tools"], {
    shell: false,
    windowsHide: true,
    cwd: BRAIN_HOME,
    env: { ...process.env, KIRO_HOME: BRAIN_HOME },
  });
  child = proc;
  dlog(`spawn acp pid=${proc.pid}`);
  proc.stdout.on("data", onStdout);
  proc.stderr.on("data", () => { /* ignore */ });
  // 只在"退出的就是当前 child"时才重置，避免旧进程迟到的 exit 误杀新进程
  proc.on("exit", (code) => { dlog(`acp exited code=${code}`); if (child === proc) reset(); });
  proc.on("error", (e) => { dlog(`acp error ${String(e)}`); if (child === proc) reset(); });
  await request("initialize", { protocolVersion: 1, clientCapabilities: {} }, REQ_TIMEOUT);
  initialized = true;
  dlog("initialized");
}

async function ensureSession(userId: string): Promise<string> {
  const existing = userSessions.get(userId);
  if (existing) return existing;
  const map = loadSessionMap();
  const saved = map[userId];
  if (saved) {
    try {
      await request("session/load", { sessionId: saved, cwd: BRAIN_HOME, mcpServers: [] }, REQ_TIMEOUT);
      userSessions.set(userId, saved);
      dlog(`session/load ok ${saved}`);
      return saved;
    } catch (e) {
      dlog(`session/load failed (${String(e)}), creating new`);
    }
  }
  const res = (await request("session/new", { cwd: BRAIN_HOME, mcpServers: [] }, REQ_TIMEOUT)) as { sessionId?: string };
  if (!res?.sessionId) throw new Error("session/new returned no sessionId");
  userSessions.set(userId, res.sessionId);
  map[userId] = res.sessionId;
  saveSessionMap(map);
  dlog(`session/new ok ${res.sessionId}`);
  return res.sessionId;
}

/** 向 Kiro 提问（常驻 + 原生多轮）。失败即重建进程（下条用 session/load 恢复上下文）。 */
export async function askKiroForUser(userId: string, message: string, onProgress?: (ev: ProgressEvent) => void, images?: Array<{ data: string; mimeType: string }>): Promise<string> {
  await ensureProcess();
  const sid = await ensureSession(userId);
  assembling.set(sid, []);
  currentOnProgress = onProgress ?? null;
  answerStarted = false;
  seenTools.clear();
  const t0 = Date.now();
  const prompt: unknown[] = [];
  for (const im of images ?? []) prompt.push({ type: "image", mimeType: im.mimeType, data: im.data });
  prompt.push({ type: "text", text: message || "（用户发来一张图片，请查看并回应）" });
  try {
    await promptRequest({ sessionId: sid, prompt });
    const txt = (assembling.get(sid) ?? []).join("").trim();
    dlog(`prompt ok ${Date.now() - t0}ms chunks=${(assembling.get(sid) ?? []).length}`);
    return txt;
  } catch (e) {
    const chunks = (assembling.get(sid) ?? []).length;
    const sinceFrame = lastFrameAt ? Date.now() - lastFrameAt : -1;
    dlog(`prompt FAIL ${Date.now() - t0}ms chunks=${chunks} lastFrameAgo=${sinceFrame}ms err=${String(e)} -> rebuild`);
    reset(); // 自愈：杀掉可能假死的进程，下条消息重建并 session/load 恢复
    throw e;
  } finally {
    currentOnProgress = null;
    assembling.delete(sid);
  }
}

/** 用户主动开新会话：丢弃旧 session（含磁盘映射），重建一个全新 session。 */
export async function newSession(userId: string): Promise<void> {
  const map = loadSessionMap();
  delete map[userId];
  saveSessionMap(map);
  userSessions.delete(userId);
  await ensureProcess();
  await ensureSession(userId);
}

/** MCP 激活集变更后调用：重启 acp 进程（重建后会 session/load 恢复上下文）。 */
export function restart(): void {
  reset();
}
