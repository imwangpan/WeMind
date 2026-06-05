import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

import { BRAIN_HOME } from "./mcp-sandbox.js";

/**
 * ACP 大脑：维护一个常驻的 `kiro-cli acp` 进程（JSON-RPC over stdio，换行分隔）。
 * - 每次用前探活，进程不在则重启 + 重新 initialize（按需重建 session）。
 * - 每个用户一个 ACP session（原生多轮记忆）。
 * - 回复从 session/update 的 agent_message_chunk 流式拼接（天然无旁白/无 ANSI）。
 * 跑在 brain 沙箱 KIRO_HOME 下（默认空 MCP）。只用 node 标准库 + mcp-sandbox，便于独立拆出。
 */

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
const TIMEOUT_MS = Number(process.env.WECHAT_BRAIN_TIMEOUT_MS) || 120_000;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

let child: ChildProcessWithoutNullStreams | null = null;
let initialized = false;
let idCounter = 0;
const pending = new Map<number, Pending>();
const userSessions = new Map<string, string>();
const assembling = new Map<string, string[]>(); // sessionId -> 当前回合文本块
let stdoutBuf = "";

function isAlive(): boolean {
  return !!child && child.exitCode === null && !child.killed;
}

/** 杀进程并清空所有内部态（pending 全部 reject）。 */
function reset(): void {
  if (child?.pid) {
    const pid = child.pid;
    try {
      // 只按本进程的 PID 杀整棵树（含 MCP 子进程），绝不按进程名误伤其它 kiro-cli。
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill();
    } catch { /* ignore */ }
  }
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("acp process gone")); }
  pending.clear();
  child = null;
  initialized = false;
  userSessions.clear();
  assembling.clear();
  stdoutBuf = "";
}

function handleFrame(f: Record<string, any>): void {
  // 响应（带 id）
  if (typeof f.id === "number" && (f.result !== undefined || f.error !== undefined)) {
    const p = pending.get(f.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(f.id);
    if (f.error) p.reject(new Error(JSON.stringify(f.error)));
    else p.resolve(f.result);
    return;
  }
  // 流式更新：只收 agent_message_chunk 的文本
  if (f.method === "session/update") {
    const u = f.params?.update;
    if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      const arr = assembling.get(f.params.sessionId);
      if (arr) arr.push(String(u.content.text ?? ""));
    }
  }
  // 其余 _kiro.dev/* 通知忽略
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

function request(method: string, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!child) { reject(new Error("no acp process")); return; }
    const id = ++idCounter;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

/** 存活检测：进程不在/未初始化则重启并 initialize。 */
async function ensureProcess(): Promise<void> {
  if (isAlive() && initialized) return;
  reset();
  child = spawn(KIRO_CLI, ["acp"], {
    shell: false,
    windowsHide: true,
    cwd: BRAIN_HOME,
    env: { ...process.env, KIRO_HOME: BRAIN_HOME },
  });
  child.stdout.on("data", onStdout);
  child.stderr.on("data", () => { /* ignore */ });
  child.on("exit", () => { reset(); });
  child.on("error", () => { reset(); });
  await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  initialized = true;
}

async function ensureSession(userId: string): Promise<string> {
  const existing = userSessions.get(userId);
  if (existing) return existing;
  const res = (await request("session/new", { cwd: BRAIN_HOME, mcpServers: [] })) as { sessionId?: string };
  if (!res?.sessionId) throw new Error("session/new returned no sessionId");
  userSessions.set(userId, res.sessionId);
  return res.sessionId;
}

/** 向 Kiro 提问（常驻 + 原生多轮），返回纯文本回复。 */
export async function askKiroForUser(userId: string, message: string): Promise<string> {
  await ensureProcess();
  const sid = await ensureSession(userId);
  assembling.set(sid, []);
  try {
    await request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: message }] });
    return (assembling.get(sid) ?? []).join("").trim();
  } finally {
    assembling.delete(sid);
  }
}

/** 用户主动开新会话：丢弃旧 session，立即建新（清空上下文）。 */
export async function newSession(userId: string): Promise<void> {
  userSessions.delete(userId);
  await ensureProcess();
  await ensureSession(userId);
}

/** MCP 激活集变更后调用：重启 acp 进程，使其按新的沙箱 mcp.json 重新加载。 */
export function restart(): void {
  reset();
}
