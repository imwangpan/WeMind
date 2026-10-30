import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

import { DATA_DIR } from "@wemind/wechat-ilink-core";
import { BRAIN_HOME, activeMcpServers } from "./mcp-sandbox.js";
import { getAgent } from "./agent-slot.js";
import { acpArgsHint, type ResolvedAgent } from "./brain-agents.js";
import { pidRecordOf, writePidRecords } from "./pid-record.js";
import { spawnAgent } from "./spawn-agent.js";
import {
  brainSessionMapPath,
  normalizeSessionMap,
  sessionKey,
  writeSessionMap,
} from "./session-map.js";
import { ensureEntry, markUsed, titleOf, touchEntry } from "./session-registry.js";
import { stripHandoffPrefix } from "./handoff.js";

/**
 * ACP 大脑：维护一个常驻的 ACP agent 进程（JSON-RPC over stdio，换行分隔）。
 * 通过标准 ACP 协议驱动，agent 可配置（默认 kiro-cli，见 brain-agents.ts），任意兼容 ACP 的 CLI 均可接入。
 * - 每用户一个 ACP session（原生多轮记忆）；session 映射持久化到磁盘。
 * - 自愈：session/prompt 超时/失败 → 杀进程重建；重建后用 session/load 恢复上下文。
 * - 诊断日志（[wemind/wechat-daemon/acp] 前缀，进 daemon.log）：发出请求、收帧、超时时已收 chunk 数与最后收帧时间差。
 * 跑在 brain 沙箱目录下（默认空 MCP），通过 agent 配置的环境变量把该目录传给 agent。
 *
 * **agent 显式传参**：本模块不再持有「当前 agent」常量（改造前是 import 时解析的 `AGENT`，
 * 于是热切换只能重启整个 daemon）。入口 `askBrain`/`newSession` 取一次槽位（`getAgent("brain")`），
 * 之后 `ensureProcess(ag)` / `ensureSession(ag,…)` / `applyModel(ag,…)` / `promptRequest(ag,…)` 一路显式传下去——
 * 过程内不再读槽位，「握手到一半被换掉 agent」在结构上不可能发生（不需要锁）。
 */

function dlog(...a: unknown[]): void {
  console.error("[wemind/wechat-daemon/acp]", ...a);
}

const REQ_TIMEOUT = 30_000; // initialize / session/new / session/load
const PROMPT_IDLE_MS = Number(process.env.WECHAT_BRAIN_IDLE_MS) || 120_000; // 多久没收到任何帧才算"卡死"。重任务单次慢抓取可静默较久（直连 kiro-cli 无此限制），放宽到 2min 兜底真死
const PROMPT_CAP_MS = Number(process.env.WECHAT_BRAIN_CAP_MS) || 900_000; // 单回合硬上限 15min。实测重任务(联网核实)需 ~6.5min；context_token 无时间 TTL(官方)，长回合用本消息 token 仍可送达。卡死由 idle/首帧超时兜底
const BRAIN_PID_FILE = path.join(DATA_DIR, "brain.pid"); // 身份记录（JSON，见 pid-record.ts）；跨入口用同一文件名

/** 首帧超时：env 覆盖 > 配置覆盖（DSH 实测首帧 1–4s，兜底 60s）> 默认 25s。
 *  按 agent 算而不是模块常量——热切换后新 agent 的启动快慢与旧的不同。 */
function firstFrameMs(ag: ResolvedAgent): number {
  return Number(process.env.WECHAT_BRAIN_FIRST_FRAME_MS) || ag.firstFrameMs || 25_000;
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
const userSessions = new Map<string, string>(); // 本进程已建立的 session
const assembling = new Map<string, string[]>(); // sessionId -> 当前回合文本块
let stdoutBuf = "";
let lastFrameAt = 0; // 最近一次收到任何 stdout 帧的时间
let frameSeq = 0; // 收到帧的累计序号（用于判定本回合是否出过帧）
type ProgressEvent =
  | { type: "tool"; kind?: string; purpose?: string; title?: string }
  | { type: "answer" }
  | { type: "thinking" }
  | { type: "activity" };
let currentOnProgress: ((ev: ProgressEvent) => void) | null = null; // 当前回合进度回调
let answerStarted = false; // 当前回合是否已通知"开始写回复"
let thoughtStarted = false; // 当前回合是否已通知"正在思考"
const seenUpdateTypes = new Set<string>(); // 诊断：本回合出现过的 sessionUpdate 类型
const seenTools = new Set<string>(); // 当前回合已上报的工具标题，去重
const hintedSessions = new Set<string>(); // 已带上「可发图」约定提示的 session（每会话首轮带上一次）

// ---- 并发门（切脑用）----
// 一回合是一段长异步（可能几分钟）：热切换必须先**等在跑的回合结束**，绝不在整回合上持锁。
// 反过来，切换期间新回合要在门口等（有界），否则会与启动新大脑时**双起进程**（后台守护进程/重试也走这条路）。
let turnInFlight = false; // 有回合正在跑（askBrain / newSession 全程）
let switching = false; // 正在切换大脑
const SWITCH_WAIT_MS = Number(process.env.WEMIND_SWITCH_TIMEOUT_MS) || 120_000; // 回合等切换的上限，与切换自身的启动新大脑的上限一致

export function isTurnInFlight(): boolean {
  return turnInFlight;
}

/** 切换流程开始时调用：此后新回合在门口等，直到 `endSwitch()`。 */
export function beginSwitch(): void {
  switching = true;
}

export function endSwitch(): void {
  switching = false;
}

/** 切换流程用：等在跑的回合结束（诚实失败——超时说明情况让用户重试，绝不半路砍掉回合）。 */
export async function drainTurn(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (turnInFlight) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

/** 回合入口用：切换进行中就先等它完成（有界），再继续——避免与启动新大脑抢同一个 ACP 进程。 */
async function waitWhileSwitching(): Promise<void> {
  if (!switching) return;
  dlog("turn waits for in-flight brain switch…");
  await drainSwitch(SWITCH_WAIT_MS);
}

async function drainSwitch(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (switching) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

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
  writePidRecords(BRAIN_PID_FILE, []); // 没有进程 = 没有记录
  for (const p of pending.values()) {
    p.clear();
    p.reject(new Error("acp process reset"));
  }
  pending.clear();
  userSessions.clear();
  assembling.clear();
  stdoutBuf = "";
}

// ---- 磁盘 session 映射（`<agent>:<userId>` -> sessionId），跨进程重建保上下文 ----
const keyOf = (ag: ResolvedAgent, userId: string): string => sessionKey(ag.name, userId);

function loadSessionMap(ag: ResolvedAgent): Record<string, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(brainSessionMapPath(DATA_DIR), "utf-8"));
  } catch {
    return {};
  }
  const { map, migrated } = normalizeSessionMap(raw, ag.name);
  if (migrated) saveSessionMap(map); // 立即写入磁盘，避免下次换 agent 时旧条目再被“继承”一次
  return map;
}
function saveSessionMap(m: Record<string, string>): void {
  writeSessionMap(brainSessionMapPath(DATA_DIR), m); // 原子写：半截 JSON 等于所有会话丢失
}

function handleReverseRequest(f: Record<string, any>): void {
  const method = String(f.method);
  dlog(`← reverse request ${method}#${f.id}`);
  if (method === "session/request_permission") {
    const options = Array.isArray(f.params?.options) ? f.params.options : [];
    // 默认拒绝（安全）；可信部署可显式开启一次性放行
    const allow =
      process.env.WEMIND_ACP_AUTO_ALLOW === "1"
        ? options.find((o: any) => o?.kind === "allow_once" || o?.kind === "allow_always")
        : undefined;
    const result = allow
      ? { outcome: { outcome: "selected", optionId: allow.optionId } }
      : { outcome: { outcome: "cancelled" } };
    child?.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: f.id, result }) + "\n");
    dlog(`permission ${allow ? "allowed" : "rejected"}`);
    return;
  }
  // 未知反向请求也要回错误，否则对端会挂起
  child?.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: f.id,
      error: { code: -32601, message: "method not supported" },
    }) + "\n",
  );
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
  // agent -> client 的反向请求（带 method + id）；必须应答，否则会挂到超时
  if (f.method && f.id !== undefined) {
    handleReverseRequest(f);
    return;
  }
  if (f.method === "session/update") {
    const u = f.params?.update;
    if (u?.sessionUpdate) seenUpdateTypes.add(String(u.sessionUpdate)); // 诊断
    // 任意 session/update 帧都视为"活动" → 让 daemon 静默刷新心跳基线（流式期间不误报"仍在处理"）
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
      const tid = String(u.toolCallId ?? u.title ?? ""); // 每个工具调用只上报一次
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
      reject(new Error("no acp process"));
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

/**
 * session/prompt 专用：空闲超时（PROMPT_IDLE_MS 内无任何帧才判卡死）+ 硬上限（PROMPT_CAP_MS）。
 * 只要 brain 还在出帧（工具进度/正文），就不打断——避免误杀"慢但在干活"的长查询。
 */
function promptRequest(ag: ResolvedAgent, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!child) {
      reject(new Error("no acp process"));
      return;
    }
    const id = ++idCounter;
    const startedAt = Date.now();
    lastFrameAt = Date.now(); // 重置空闲基线：从本次 prompt 发出算起，避免用上一回合的旧时间戳误判
    const startSeq = frameSeq; // 记录起点，用于判定本回合是否出过帧
    const firstFrame = firstFrameMs(ag);
    dlog(
      `→ session/prompt#${id} (idle=${PROMPT_IDLE_MS}ms cap=${PROMPT_CAP_MS}ms firstFrame=${firstFrame}ms)`,
    );
    const iv = setInterval(() => {
      const idle = Date.now() - lastFrameAt;
      const total = Date.now() - startedAt;
      const noFrameYet = frameSeq === startSeq; // 本回合从未出过帧
      const firstFrameTimeout = noFrameYet && total > firstFrame;
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

async function ensureProcess(ag: ResolvedAgent): Promise<void> {
  if (isAlive() && initialized) return;
  reset();
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (ag.homeEnvVar) env[ag.homeEnvVar] = BRAIN_HOME; // 把 brain 沙箱目录传给 agent
  // 配置里声明的额外环境变量（%HOME% → 沙箱根），如 opencode 的 OPENCODE_DISABLE_PROJECT_CONFIG
  for (const [k, v] of Object.entries(ag.env ?? {})) env[k] = v.replaceAll("%HOME%", BRAIN_HOME);
  const proc = spawnAgent(ag, { cwd: BRAIN_HOME, env });
  child = proc;
  dlog(`spawn ${ag.name} acp pid=${proc.pid} bin=${ag.bin} args=[${ag.args.join(" ")}]`);
  // 身份记录（JSON）：manage.ts 据此算进程特征串与展示 live 状态，不必猜「配置里的 agent 是不是正在跑的那个」
  writePidRecords(BRAIN_PID_FILE, [pidRecordOf(proc.pid!, ag)]);
  proc.stdout.on("data", onStdout);
  proc.stderr.on("data", () => {
    /* ignore */
  });
  // 只在"退出的就是当前 child"时才重置，避免旧进程迟到的 exit 误杀新进程
  proc.on("exit", (code) => {
    // A：握手前就退出时，把「args 可能漏了 ACP 模式参数」直接写进日志（比只报一行 exited 好查）
    const hint = child === proc && !initialized ? acpArgsHint(ag) : "";
    dlog(`acp exited code=${code}${hint}`);
    if (child === proc) reset();
  });
  proc.on("error", (e) => {
    dlog(`acp error ${String(e)}`);
    if (child === proc) reset();
  });
  try {
    await request("initialize", { protocolVersion: 1, clientCapabilities: {} }, REQ_TIMEOUT);
  } catch (e) {
    // A：initialize 超时/失败最常见的原因是 args 覆盖漏了 ACP 子命令——把诊断提示附在同一行日志里
    dlog(`initialize failed: ${String(e)}${acpArgsHint(ag)}`);
    throw e;
  }
  initialized = true;
  dlog("initialized");
}

/** 按配置选模型路由（如 DSH 的 deepseek-account）；没有 model 的 agent 跳过。 */
async function applyModel(ag: ResolvedAgent, sid: string): Promise<void> {
  if (!ag.model) return;
  try {
    await request(
      "session/set_config_option",
      { sessionId: sid, configId: "model", value: ag.model },
      REQ_TIMEOUT,
    );
    dlog(`model set ${ag.model}`);
  } catch (e) {
    dlog(`model set failed (${String(e)})`);
    throw e;
  }
}

/** 会话建立/恢复后切到预设声明的模式（免审批：claude-code 的 bypassPermissions、codex 的 agent-full-access）。
 *  **失败只记日志、不抛**：模式不可用（如 claude-code 以 root 跑却没有 IS_SANDBOX）时进程仍可用，
 *  审批请求继续由应答器处理（默认拒绝，WEMIND_ACP_AUTO_ALLOW=1 放行）；抛错反而会把整轮打成失败。 */
async function applySessionMode(ag: ResolvedAgent, sid: string): Promise<void> {
  if (!ag.sessionMode) return;
  try {
    await request("session/set_mode", { sessionId: sid, modeId: ag.sessionMode }, REQ_TIMEOUT);
    dlog(`session mode set ${ag.sessionMode}`);
  } catch (e) {
    dlog(`session mode set failed (${String(e)})——继续；审批请求仍由应答器处理`);
  }
}

async function ensureSession(ag: ResolvedAgent, userId: string): Promise<string> {
  const existing = userSessions.get(userId);
  if (existing) return existing;
  // 配了 mcpViaAcp 的 agent（DSH）：激活集随 session 下发；其余 agent 传空（走各自沙箱配置文件）
  const mcpServers = ag.mcpViaAcp ? activeMcpServers() : [];
  const map = loadSessionMap(ag);
  const saved = map[keyOf(ag, userId)];
  if (saved) {
    // agent 指定 resume（DSH）；其余仍先 load，失败再试 resume，最后 new
    const methods: Array<"load" | "resume"> =
      ag.restore === "resume" ? ["resume"] : ["load", "resume"];
    for (const method of methods) {
      try {
        await request(
          `session/${method}`,
          { sessionId: saved, cwd: BRAIN_HOME, mcpServers },
          REQ_TIMEOUT,
        );
        await applyModel(ag, saved);
        await applySessionMode(ag, saved);
        userSessions.set(userId, saved);
        markUsed(ag.name, userId, saved); // 会话登记表：把它顶到「最近使用」（列表按此排序）
        dlog(`session/${method} ok ${saved} mcp=[${mcpServers.map((s: any) => s.name).join(",")}]`);
        return saved;
      } catch (e) {
        dlog(`session/${method} failed (${String(e)})`);
      }
    }
  }
  const res = (await request("session/new", { cwd: BRAIN_HOME, mcpServers }, REQ_TIMEOUT)) as {
    sessionId?: string;
  };
  if (!res?.sessionId) throw new Error("session/new returned no sessionId");
  await applyModel(ag, res.sessionId);
  await applySessionMode(ag, res.sessionId);
  userSessions.set(userId, res.sessionId);
  map[keyOf(ag, userId)] = res.sessionId;
  saveSessionMap(map);
  ensureEntry(ag.name, userId, res.sessionId); // 会话登记表：新会话进列表（turns 从 0 起）
  dlog(`session/new ok ${res.sessionId} mcp=[${mcpServers.map((s: any) => s.name).join(",")}]`);
  return res.sessionId;
}

/** 向大脑（配置的 ACP agent）提问（常驻 + 原生多轮）。失败即重建进程（下条用 session/load 恢复上下文）。 */
export async function askBrain(
  userId: string,
  message: string,
  onProgress?: (ev: ProgressEvent) => void,
  images?: Array<{ data: string; mimeType: string }>,
): Promise<string> {
  await waitWhileSwitching(); // 切换进行中就先在门口等（有界）：绝不在启动新大脑时双起进程
  const ag = getAgent("brain"); // 等完之后才取槽位——拿到的是切换后的新大脑；此后全程用它，过程内不再读槽位
  turnInFlight = true; // 从这一刻起，切脑会等本回合结束（drainTurn）
  try {
    return await runTurn(ag, userId, message, onProgress, images);
  } finally {
    turnInFlight = false;
  }
}

async function runTurn(
  ag: ResolvedAgent,
  userId: string,
  message: string,
  onProgress?: (ev: ProgressEvent) => void,
  images?: Array<{ data: string; mimeType: string }>,
): Promise<string> {
  await ensureProcess(ag);
  const sid = await ensureSession(ag, userId);
  assembling.set(sid, []);
  currentOnProgress = onProgress ?? null;
  answerStarted = false;
  thoughtStarted = false;
  seenUpdateTypes.clear();
  seenTools.clear();
  const t0 = Date.now();
  const prompt: unknown[] = [];
  if (images?.length && !ag.images) {
    prompt.push({
      type: "text",
      text: "（用户发来图片，但当前大脑不支持图片输入；请让用户改用文字，或切换到支持图片的大脑。不要臆测图片内容。）",
    });
  }
  if (ag.images) {
    for (const im of images ?? [])
      prompt.push({ type: "image", mimeType: im.mimeType, data: im.data });
  }
  if (!hintedSessions.has(sid)) {
    hintedSessions.add(sid);
    prompt.push({
      type: "text",
      text: "（系统提示：你正在通过微信和用户对话。需要给用户发图片时，在回复里用 Markdown 图片语法 ![](图片的 http 链接或本地文件绝对路径)，系统会自动把它作为图片消息发出（你本身不会文生图，可发联网搜到的图、本地已有的图、或自己用代码渲染保存的图表）。重要：服务器从中国大陆下载该图，请选「可直接下载的直链」——优先 raw.githubusercontent.com 等原始文件直链；避免 wikipedia/wikimedia（大陆被墙）以及 pixabay/unsplash 等带热链保护、直链常返回 403 的图床。拿不准时优先把图先下载到本地再用本地绝对路径引用，或直接发链接让用户自己点。其余正常用文字/Markdown 回复。此提示只出现一次，无需理会本句。）",
    });
  }
  prompt.push({ type: "text", text: message || "（用户发来一张图片，请查看并回应）" });
  try {
    await promptRequest(ag, { sessionId: sid, prompt });
    const txt = (assembling.get(sid) ?? []).join("").trim();
    // 成功回合才登记：轮次 +1、刷新最近使用、首次写入标题（用户消息前 30 字；纯图片消息没有文字 → 留给下一次）
    // 标题取**剥掉交接前缀**后的正文：不然列表里全是「【交接摘要 · 来自 …】」，用户认不出哪条是哪条。
    touchEntry(ag.name, userId, sid, { title: titleOf(stripHandoffPrefix(message)) });
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
    reset(); // 自愈：杀掉可能假死的进程，下条消息重建并 session/load 恢复
    throw e;
  } finally {
    currentOnProgress = null;
    assembling.delete(sid);
  }
}

/** 用户主动开新会话：丢弃旧 session（含磁盘映射），重建一个全新 session。 */
export async function newSession(userId: string): Promise<void> {
  await waitWhileSwitching();
  const ag = getAgent("brain");
  turnInFlight = true; // 与 askBrain 共用「有回合在碰 ACP 进程」这一事实（切脑据此等待）
  try {
    const map = loadSessionMap(ag);
    delete map[keyOf(ag, userId)]; // 只清当前 agent 的；换大脑前那个 agent 的上下文仍保留
    saveSessionMap(map);
    userSessions.delete(userId);
    await ensureProcess(ag);
    await ensureSession(ag, userId);
  } finally {
    turnInFlight = false;
  }
}

/**
 * 「恢复会话」：把某条**已有的**会话切回当前，**严格恢复**——只认真接上的 load/resume，
 * 接不上就如实报错，**绝不**回退成 session/new（那会让用户以为上下文回来了，其实是一张白纸），
 * 也**不改**会话当前会话记录（当前会话原样保留，用户还能继续用）。
 * 成功才动磁盘：userSessions + 当前会话表（`<agent>:<userId>` → 这条）。
 */
export async function resumeSession(
  userId: string,
  sessionId: string,
): Promise<{ ok: true } | { ok: false; problem: string }> {
  await waitWhileSwitching();
  const ag = getAgent("brain");
  turnInFlight = true; // 与 askBrain 共用「有回合在碰 ACP 进程」这一事实（切脑据此等待）
  const short = sessionId.slice(0, 8);
  try {
    await ensureProcess(ag);
    const mcpServers = ag.mcpViaAcp ? activeMcpServers() : [];
    const methods: Array<"load" | "resume"> =
      ag.restore === "resume" ? ["resume"] : ["load", "resume"];
    let lastErr = "";
    for (const method of methods) {
      try {
        await request(`session/${method}`, { sessionId, cwd: BRAIN_HOME, mcpServers }, REQ_TIMEOUT);
        await applyModel(ag, sessionId);
        await applySessionMode(ag, sessionId);
        userSessions.set(userId, sessionId);
        const map = loadSessionMap(ag);
        map[keyOf(ag, userId)] = sessionId;
        saveSessionMap(map);
        dlog(`resume ok ${sessionId}`);
        return { ok: true };
      } catch (e) {
        lastErr = String(e);
        dlog(`resume session/${method} failed (${lastErr})`);
      }
    }
    return {
      ok: false,
      problem: `接不上会话 ${short}（该 agent 不支持恢复，或这条会话已被它自己清理）。当前会话没变，可以继续用；要开新的就发「新会话」。${lastErr ? `\n（原因：${lastErr.slice(0, 120)}）` : ""}`,
    };
  } finally {
    turnInFlight = false;
  }
}

/**
 * 切换流程用：为新 agent 备好进程与（触发者）会话——启动成功才算「新大脑真的能用 ACP 说话」。
 * 会话走既有 ensureSession：该 agent 里有本人的旧会话就 load/resume 恢复上下文，没有就新建。
 * `userId` 为空（CLI 触发、还不知道是谁在聊）时只验进程能握手。
 */
export async function warmup(ag: ResolvedAgent, userId: string): Promise<string> {
  await ensureProcess(ag);
  if (!userId) return "";
  return ensureSession(ag, userId);
}

/** MCP 激活集变更后调用：重启 acp 进程（重建后会 session/load 恢复上下文）。 */
export function restart(): void {
  reset();
}

/** 当前大脑是否接受图片输入（配置里的能力；默认 true）。 */
export function supportsImages(): boolean {
  return getAgent("brain").images;
}

/** 当前 agent 的静默期心跳覆盖（默认 undefined → 15s）。按回合取：热切换后心跳随之改变。 */
export function heartbeatMs(): number | undefined {
  return getAgent("brain").heartbeatMs;
}
