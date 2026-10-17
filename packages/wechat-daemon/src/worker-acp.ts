import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import { DATA_DIR } from "@wemind/wechat-ilink-core";
import { WORKER_HOME } from "./worker-sandbox.js";
import { resolveAgent } from "./brain-agents.js";
import { loadBrainConfig } from "./brain-config.js";

/**
 * worker ACP 客户端：维护一个常驻的 ACP agent 进程，专跑「漫长任务」（与 acp-brain 的对话大脑并存、互不干扰）。
 * 约 70% 复制自 acp-brain.ts，差异：
 * - **独立单例**（独立 child/pending/session），与 brain 进程并存；
 * - **单任务 session**（MVP 单任务，固定 key="task"）；持久化到 worker-sessions.json，重建后 session/load 续上下文；
 * - **cwd = 任务工作目录**（WEMIND_WORKER_CWD，默认用户主目录），而 KIRO_HOME 指向 WORKER_HOME 沙箱（继承全量 MCP 除 wechat + 记忆）；
 * - **更宽松超时**（漫长任务，env 可调）；
 * - 去掉 brain 的「可发图」首轮提示（worker 是任务执行，非聊天发图场景）。
 * 自愈：session/prompt 超时/失败 → 杀进程；下次 askWorker 重建并 session/load 恢复（→ 用户回「继续」即可续跑）。
 */

function dlog(...a: unknown[]): void {
  console.error("[wemind/wechat-daemon/worker]", ...a);
}

const AGENT = resolveAgent(loadBrainConfig()); // 复用同一 ACP agent 解析（env > 账号 brain.json > auto）
const WORKER_CWD = process.env.WEMIND_WORKER_CWD?.trim() || os.homedir(); // 任务工作目录（按 kiro 约定，MVP 默认主目录）
const REQ_TIMEOUT = 30_000; // initialize / session/new / session/load
const PROMPT_IDLE_MS = Number(process.env.WEMIND_WORKER_IDLE_MS) || 180_000; // 无任何帧多久算"卡死"（worker 比 brain 宽松：3min）
const PROMPT_CAP_MS = Number(process.env.WEMIND_WORKER_CAP_MS) || 1_800_000; // 单轮硬上限 30min（漫长任务）
const FIRST_FRAME_MS = Number(process.env.WEMIND_WORKER_FIRST_FRAME_MS) || 30_000; // 从未出帧多久判"开局即卡死"
const SESSION_MAP_FILE = path.join(DATA_DIR, "worker-sessions.json");
const WORKER_PID_FILE = path.join(DATA_DIR, "worker.pid"); // 标记 worker kiro-cli pid，便于与 brain/用户会话区分、精确清理
const TASK_KEY = "task"; // MVP 单任务的固定 session key

// 本任务的工作目录：本地派发可指定（终端当前目录）；微信派发为 undefined → 用 WORKER_CWD 默认。
// spawn 时生效（子进程 cwd 不可中途改），stopWorker 时清。
let pendingCwd: string | undefined;
/** 设置「下次（本任务首轮）spawn worker 用的 cwd」。本地命令派发传入终端当前目录；不传/空则用默认 WORKER_CWD。 */
export function setWorkerCwd(cwd?: string): void {
  pendingCwd = cwd?.trim() || undefined;
}
/** 本任务有效 cwd（指定优先，否则默认）。 */
function effectiveCwd(): string {
  return pendingCwd ?? WORKER_CWD;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  clear: () => void;
  method: string;
};

let child: ChildProcessWithoutNullStreams | null = null;
let initialized = false;
let idCounter = 0;
const pending = new Map<number, Pending>();
const taskSessions = new Map<string, string>(); // key -> sessionId（MVP 仅 TASK_KEY）
const assembling = new Map<string, string[]>(); // sessionId -> 当前轮文本块
let stdoutBuf = "";
let lastFrameAt = 0;
let frameSeq = 0;
export type WorkerProgressEvent =
  | { type: "tool"; kind?: string; purpose?: string; title?: string }
  | { type: "answer" }
  | { type: "thinking" }
  | { type: "activity" };
let currentOnProgress: ((ev: WorkerProgressEvent) => void) | null = null;
let answerStarted = false;
let thoughtStarted = false;
const seenUpdateTypes = new Set<string>();
const seenTools = new Set<string>();

export function isWorkerAlive(): boolean {
  return !!child && child.exitCode === null && !child.killed;
}

/** 杀进程（按 PID 进程树）并清空内部态；不清磁盘 session 映射（留给重建后 load）。 */
function reset(): void {
  const c = child;
  child = null;
  initialized = false;
  if (c?.pid) {
    try {
      if (process.platform === "win32")
        spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true, // 避免瞬时闪出控制台窗口
        });
      else c.kill();
    } catch {
      /* ignore */
    }
  }
  try {
    fs.unlinkSync(WORKER_PID_FILE);
  } catch {
    /* ignore */
  }
  for (const p of pending.values()) {
    p.clear();
    p.reject(new Error("worker process reset"));
  }
  pending.clear();
  taskSessions.clear();
  assembling.clear();
  stdoutBuf = "";
}

function loadSessionMap(): Record<string, string> {
  try {
    const j = JSON.parse(fs.readFileSync(SESSION_MAP_FILE, "utf-8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}
function saveSessionMap(m: Record<string, string>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SESSION_MAP_FILE, JSON.stringify(m, null, 2), "utf-8");
}

function handleFrame(f: Record<string, any>): void {
  lastFrameAt = Date.now();
  frameSeq += 1;
  if (typeof f.id === "number" && (f.result !== undefined || f.error !== undefined)) {
    const p = pending.get(f.id);
    if (!p) return;
    p.clear();
    pending.delete(f.id);
    if (f.error) {
      dlog(`← ${p.method}#${f.id} ERROR ${JSON.stringify(f.error).slice(0, 200)}`);
      p.reject(new Error(JSON.stringify(f.error)));
    } else p.resolve(f.result);
    return;
  }
  if (f.method === "session/update") {
    const u = f.params?.update;
    if (u?.sessionUpdate) seenUpdateTypes.add(String(u.sessionUpdate));
    if (currentOnProgress) {
      try {
        currentOnProgress({ type: "activity" });
      } catch {
        /* ignore */
      }
    }
    if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      const arr = assembling.get(f.params.sessionId);
      if (arr) arr.push(String(u.content.text ?? ""));
      if (!answerStarted && currentOnProgress) {
        answerStarted = true;
        try {
          currentOnProgress({ type: "answer" });
        } catch {
          /* ignore */
        }
      }
    } else if (u?.sessionUpdate === "agent_thought_chunk") {
      if (!thoughtStarted && currentOnProgress) {
        thoughtStarted = true;
        try {
          currentOnProgress({ type: "thinking" });
        } catch {
          /* ignore */
        }
      }
    } else if (
      (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") &&
      currentOnProgress
    ) {
      const tid = String(u.toolCallId ?? u.title ?? "");
      if (tid && !seenTools.has(tid)) {
        seenTools.add(tid);
        const purpose =
          typeof u.rawInput?.__tool_use_purpose === "string"
            ? u.rawInput.__tool_use_purpose
            : undefined;
        try {
          currentOnProgress({ type: "tool", kind: u.kind, purpose, title: u.title });
        } catch {
          /* ignore */
        }
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
    try {
      f = JSON.parse(line);
    } catch {
      continue;
    }
    handleFrame(f);
  }
}

function request(method: string, params: unknown, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!child) {
      reject(new Error("no worker process"));
      return;
    }
    const id = ++idCounter;
    dlog(`→ ${method}#${id}`);
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, clear: () => clearTimeout(t), method });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

/** session/prompt 专用：空闲超时 + 首帧超时 + 硬上限（漫长任务，比 brain 宽松）。 */
function promptRequest(params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!child) {
      reject(new Error("no worker process"));
      return;
    }
    const id = ++idCounter;
    const startedAt = Date.now();
    lastFrameAt = Date.now();
    const startSeq = frameSeq;
    dlog(
      `→ session/prompt#${id} (idle=${PROMPT_IDLE_MS}ms cap=${PROMPT_CAP_MS}ms firstFrame=${FIRST_FRAME_MS}ms)`,
    );
    const iv = setInterval(() => {
      const idle = Date.now() - lastFrameAt;
      const total = Date.now() - startedAt;
      const noFrameYet = frameSeq === startSeq;
      const firstFrameTimeout = noFrameYet && total > FIRST_FRAME_MS;
      if (firstFrameTimeout || idle > PROMPT_IDLE_MS || total > PROMPT_CAP_MS) {
        if (pending.delete(id)) {
          clearInterval(iv);
          const why = firstFrameTimeout ? "no-first-frame" : idle > PROMPT_IDLE_MS ? "idle" : "cap";
          reject(new Error(`session/prompt ${why} timeout (idle=${idle}ms total=${total}ms)`));
        }
      }
    }, 5000);
    pending.set(id, { resolve, reject, clear: () => clearInterval(iv), method: "session/prompt" });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method: "session/prompt", params }) + "\n",
    );
  });
}

async function ensureProcess(): Promise<void> {
  if (isWorkerAlive() && initialized) return;
  reset();
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (AGENT.homeEnvVar) env[AGENT.homeEnvVar] = WORKER_HOME; // 配置目录（MCP/记忆）走 WORKER_HOME 沙箱
  // 预设声明的额外环境变量（%HOME% → 沙箱根）
  for (const [k, v] of Object.entries(AGENT.env ?? {}))
    env[k] = v.replaceAll("%HOME%", WORKER_HOME);
  const cwd = effectiveCwd();
  const proc = spawn(AGENT.bin, AGENT.args, {
    shell: AGENT.shell,
    windowsHide: true,
    cwd, // 任务工作目录（本地派发可指定，否则默认 WORKER_CWD），区别于 KIRO_HOME 沙箱
    env,
  });
  child = proc;
  dlog(`spawn ${AGENT.name} worker pid=${proc.pid} cwd=${cwd} home=${WORKER_HOME}`);
  try {
    fs.writeFileSync(WORKER_PID_FILE, String(proc.pid), "utf-8");
  } catch {
    /* best-effort */
  }
  proc.stdout.on("data", onStdout);
  proc.stderr.on("data", () => {
    /* ignore */
  });
  proc.on("exit", (code) => {
    dlog(`worker exited code=${code}`);
    if (child === proc) reset();
  });
  proc.on("error", (e) => {
    dlog(`worker error ${String(e)}`);
    if (child === proc) reset();
  });
  await request("initialize", { protocolVersion: 1, clientCapabilities: {} }, REQ_TIMEOUT);
  initialized = true;
  dlog("initialized");
}

async function ensureSession(key: string): Promise<string> {
  const existing = taskSessions.get(key);
  if (existing) return existing;
  const map = loadSessionMap();
  const saved = map[key];
  if (saved) {
    try {
      await request(
        "session/load",
        { sessionId: saved, cwd: effectiveCwd(), mcpServers: [] },
        REQ_TIMEOUT,
      );
      taskSessions.set(key, saved);
      dlog(`session/load ok ${saved}`);
      return saved;
    } catch (e) {
      dlog(`session/load failed (${String(e)}), creating new`);
    }
  }
  const res = (await request(
    "session/new",
    { cwd: effectiveCwd(), mcpServers: [] },
    REQ_TIMEOUT,
  )) as { sessionId?: string };
  if (!res?.sessionId) throw new Error("session/new returned no sessionId");
  taskSessions.set(key, res.sessionId);
  map[key] = res.sessionId;
  saveSessionMap(map);
  dlog(`session/new ok ${res.sessionId}`);
  return res.sessionId;
}

/**
 * 向 worker 发一轮 prompt（任务派发或注入续跑），等这一轮 ACP 响应结束，返回拼接文本。
 * 失败即重建进程（下一轮 session/load 恢复上下文）→ 配合「继续」实现中断恢复。
 */
export async function askWorker(
  instruction: string,
  onProgress?: (ev: WorkerProgressEvent) => void,
): Promise<string> {
  await ensureProcess();
  const sid = await ensureSession(TASK_KEY);
  assembling.set(sid, []);
  currentOnProgress = onProgress ?? null;
  answerStarted = false;
  thoughtStarted = false;
  seenUpdateTypes.clear();
  seenTools.clear();
  const t0 = Date.now();
  const prompt: unknown[] = [{ type: "text", text: instruction || "（继续）" }];
  try {
    await promptRequest({ sessionId: sid, prompt });
    const txt = (assembling.get(sid) ?? []).join("").trim();
    dlog(
      `prompt ok ${Date.now() - t0}ms chunks=${(assembling.get(sid) ?? []).length} updateTypes=[${[...seenUpdateTypes].join(",")}]`,
    );
    return txt;
  } catch (e) {
    const chunks = (assembling.get(sid) ?? []).length;
    const sinceFrame = lastFrameAt ? Date.now() - lastFrameAt : -1;
    dlog(
      `prompt FAIL ${Date.now() - t0}ms chunks=${chunks} lastFrameAgo=${sinceFrame}ms err=${String(e)} -> rebuild`,
    );
    reset();
    throw e;
  } finally {
    currentOnProgress = null;
    assembling.delete(sid);
  }
}

/** 开新任务会话：丢弃旧 session（含磁盘映射），下次 askWorker 全新开始。 */
export function newWorkerSession(): void {
  const map = loadSessionMap();
  delete map[TASK_KEY];
  saveSessionMap(map);
  taskSessions.delete(TASK_KEY);
}

/** 停止 worker：杀进程、清状态、丢弃任务 session（任务结束）。 */
export function stopWorker(): void {
  reset();
  newWorkerSession();
  pendingCwd = undefined; // 任务结束，清掉本任务 cwd（下个任务重新指定或用默认）
}
