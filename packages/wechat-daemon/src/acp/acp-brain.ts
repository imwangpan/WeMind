import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import { createLogger, DATA_DIR } from "@wemind/wechat-ilink-core";
import {
  activeMcpServers,
  ensureBrainHome,
  nativeMcpServers,
  warnForbiddenNativeMcp,
} from "../agents/sandbox/mcp-sandbox.js";
import { agentRuntime } from "../agents/config/runtime.js";
import { configFingerprint } from "../agents/config/config-fingerprint.js";
import { formatMcpPerf, mcpPerfWarnings } from "../agents/config/mcp-perf.js";
import { getSessionCwd, setSessionCwd } from "../agents/config/session-cwd.js";
import { getAgent } from "../agents/agent-slot.js";
import { acpArgsHint, agentEnv, prepareAgent, type ResolvedAgent } from "../agents/brain-agents.js";
import { pidRecordOf, writePidRecords } from "../shared/process/pid-record.js";
import { spawnAgent } from "../shared/process/spawn-agent.js";
import {
  backupCorruptSessionMap,
  brainSessionMapPath,
  normalizeSessionMap,
  readSessionMapStrict,
  sessionKey,
  writeSessionMap,
} from "../sessions/session-map.js";
import { ensureEntry, markUsed, titleOf, touchEntry } from "../sessions/session-registry.js";
import { stripHandoffPrefix } from "../sessions/handoff.js";
import {
  applyAcpModel,
  applyAcpSessionMode,
  availableAcpModes,
  acpTurnFirstFrameMs,
  acpTurnChunks,
  acpTurnText,
  beginAcpTurn,
  clearAcpTurn,
  drainAcpReplay,
  endAcpTurn,
  feedAcpStdout,
  handleAcpFrame,
  newTurnState,
  promptAcp,
  requestAcp,
  type AcpHost,
  type AcpPending,
  type AcpProgressEvent,
} from "./protocol/acp-connection.js";
import { LineDecoder } from "../shared/io/line-decoder.js";
const log = createLogger("wechat-daemon/acp");

/**
 * ACP 大脑：维护一个常驻的 ACP agent 进程（JSON-RPC over stdio，换行分隔）。
 * 通过标准 ACP 协议驱动，agent 可配置（默认 kiro-cli，见 brain-agents.ts），任意兼容 ACP 的 CLI 均可接入。
 * - 每用户一个 ACP session（原生多轮记忆）；session 映射持久化到磁盘。
 * - 自愈：session/prompt 超时/失败 → 杀进程重建；重建后用 session/load 恢复上下文。
 * - 诊断日志（统一走 `createLogger("wechat-daemon/acp")`，格式 `[wemind/wechat-daemon/acp][INFO|WARN|ERROR] …`，全部 stderr、进 daemon.log）：发出请求、收帧、超时时已收 chunk 数与最后收帧时间差；`spawn`/`initialized`/`session/new`/`prompt ok` 等帧级关键线索归 INFO（排障必须可见），失败与自愈归 WARN/ERROR。
 * 跑在 brain 沙箱目录下（默认空 MCP），通过 agent 配置的环境变量把该目录传给 agent。
 * 协议细节（帧处理、请求/回合超时、模型与模式、回放静默）与 worker 共用 `acp-connection.ts`；本模块只保留常驻单例与会话持久化。
 *
 * **agent 显式传参**：本模块不再持有「当前 agent」常量（改造前是 import 时解析的 `AGENT`，
 * 于是热切换只能重启整个 daemon）。入口 `askBrain`/`newSession` 取一次槽位（`getAgent("brain")`），
 * 之后 `ensureProcess(ag)` / `ensureSession(ag,…)` / `applyAcpModel(host, ag, …)` / `promptAcp(host, …)` 一路显式传下去——
 * 过程内不再读槽位，「握手到一半被换掉 agent」在结构上不可能发生（不需要锁）。
 */

const REQ_TIMEOUT = 30_000; // initialize / session/new / session/load
const PROMPT_IDLE_MS = Number(process.env.WECHAT_BRAIN_IDLE_MS) || 120_000; // 多久没收到任何帧才算"卡死"。重任务单次慢抓取可静默较久（直连 kiro-cli 无此限制），放宽到 2min 兜底真死
const PROMPT_CAP_MS = Number(process.env.WECHAT_BRAIN_CAP_MS) || 900_000; // 单回合硬上限 15min。实测重任务(联网核实)需 ~6.5min；context_token 无时间 TTL(官方)，长回合用本消息 token 仍可送达。卡死由 idle/首帧超时兜底
const BRAIN_PID_FILE = path.join(DATA_DIR, "brain.pid"); // 身份记录（JSON，见 pid-record.ts）；跨入口用同一文件名

/** 首帧超时：env 覆盖 > 配置覆盖（DSH 实测首帧 1–4s，兜底 60s）> 默认 25s。
 *  按 agent 算而不是模块常量——热切换后新 agent 的启动快慢与旧的不同。 */
function firstFrameMs(ag: ResolvedAgent): number {
  return Number(process.env.WECHAT_BRAIN_FIRST_FRAME_MS) || ag.firstFrameMs || 25_000;
}

let child: ChildProcessWithoutNullStreams | null = null;
let initialized = false;
let configFp = "";
let idCounter = 0;
const pending = new Map<number, AcpPending>();
const userSessions = new Map<string, string>(); // 本进程已建立的 session
// 会话建立耗时按 sessionId 记，供 prompt 日志带出 mcpCount；进程重建后清空（下次建立会重新记）。
const sessionPerf = new Map<string, { mcpCount: number; sessionNewMs: number }>();
const turn = newTurnState(); // 当前回合的拼接缓冲与进度状态
const rpcState = { lastFrameAt: 0, frameSeq: 0 }; // 最近收帧时间 + 累计序号（首帧/回放判定）
const stdoutLines = new LineDecoder();
const hintedSessions = new Set<string>(); // 已带上「可发图」约定提示的 session（每会话首轮带上一次）
type ProgressEvent = AcpProgressEvent;

const host: AcpHost = {
  pending,
  turn,
  state: rpcState,
  hasProcess: () => !!child,
  noProcessMessage: "no acp process",
  nextId: () => ++idCounter,
  write: (payload) => {
    child?.stdin.write(JSON.stringify(payload) + "\n");
  },
  log: (message, level) =>
    level === "error"
      ? log.error(message)
      : level === "warn"
        ? log.warn(message)
        : log.info(message),
};

// ---- 并发门（切脑用）----
// 一回合是一段长异步（可能几分钟）：热切换必须先**等在跑的回合结束**，绝不在整回合上持锁。
// 反过来，切换期间新回合要在门口等（有界），否则会与启动新大脑时**双起进程**（后台守护进程/重试也走这条路）。
let turnDepth = 0; // 已入队/正在跑的 ACP 操作数（提问 / 新建会话 / 恢复会话）
let opChain: Promise<void> = Promise.resolve(); // ACP 操作串行链：同一时刻只有一个操作在碰进程
let switching = false; // 正在切换大脑
let pendingReload = false; // 配置变更要求重启，但当前有回合在跑 → 排到最后一个回合结束
const SWITCH_WAIT_MS = Number(process.env.WEMIND_SWITCH_TIMEOUT_MS) || 120_000; // 回合等切换的上限，与切换自身的启动新大脑的上限一致

export function isTurnInFlight(): boolean {
  return turnDepth > 0;
}

/**
 * 所有会碰 ACP 进程的操作（提问 / 新建 / 恢复）都从这里排队：同一时刻只有一个在跑。
 * 微信回合与控制桥是两条独立入口，没有这道门时 `session/new` 会插进 `session/prompt` 中间，
 * 或在恢复会话时把正在跑的回合的 `userSessions` 改掉。
 * `turnDepth` 在**入队时**就加：切脑的 `drainTurn` 要连排队中的操作一起等，不能只看正在跑的那个。
 */
function withBrainOp<T>(fn: () => Promise<T>): Promise<T> {
  turnDepth += 1;
  const run = opChain.then(fn, fn).finally(() => {
    turnDepth -= 1;
    if (turnDepth === 0 && pendingReload) {
      pendingReload = false;
      log.info("回合已结束：应用排队的 MCP/config 变更（重启大脑）");
      reset();
    }
  });
  opChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** 控制桥请求的等待上限：CLI 已经放弃后，排队中的操作不再执行（见 control-bridge.ts 的 expiresAt）。 */
function expired(deadline?: number): boolean {
  return deadline !== undefined && Date.now() > deadline;
}
const EXPIRED_MSG = "请求已超时（CLI 已不再等待），本次未执行";

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
  while (isTurnInFlight()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

/** 回合入口用：切换进行中就先等它完成（有界），再继续——避免与启动新大脑抢同一个 ACP 进程。 */
async function waitWhileSwitching(): Promise<void> {
  if (!switching) return;
  log.info("turn waits for in-flight brain switch…");
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
  configFp = "";
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
  sessionPerf.clear();
  clearAcpTurn(turn);
  stdoutLines.reset();
}

// ---- 磁盘 session 映射（`<agent>:<userId>` -> sessionId），跨进程重建保上下文 ----
const keyOf = (ag: ResolvedAgent, userId: string): string => sessionKey(ag.name, userId);

function loadSessionMap(ag: ResolvedAgent): Record<string, string> {
  const file = brainSessionMapPath(DATA_DIR);
  let raw: Record<string, string>;
  try {
    raw = readSessionMapStrict(file);
  } catch (e) {
    const backup = backupCorruptSessionMap(file);
    log.warn(
      `session map unreadable (${String(e)}) → ${backup ? `backed up to ${backup}` : "backup failed"}；按空表继续`,
    );
    return {};
  }
  const { map, migrated } = normalizeSessionMap(raw, ag.name);
  if (migrated) saveSessionMap(map); // 立即写入磁盘，避免下次换 agent 时旧条目再被“继承”一次
  return map;
}
function saveSessionMap(m: Record<string, string>): void {
  writeSessionMap(brainSessionMapPath(DATA_DIR), m); // 原子写：半截 JSON 等于所有会话丢失
}

async function ensureProcess(ag: ResolvedAgent): Promise<void> {
  // 先按当前配置算指纹：终端侧改了配置就让本轮重建进程（不在一轮对话中途换配置）。
  const before = configFingerprint(ag, agentRuntime("brain", ag));
  if (isAlive() && initialized && configFp === before) return;
  if (isAlive() && initialized) {
    log.info(`config changed (${ag.name}) → rebuild before next turn`);
  }
  reset();
  const kept: string[] = [];
  const rt = ensureBrainHome(ag); // direct 不写文件；sandbox 才准备副本
  warnForbiddenNativeMcp(ag, rt); // 只告警：agent 自己配置里有微信 MCP 时提示回环风险
  const env = agentEnv(ag, rt.home, kept, DATA_DIR, { direct: rt.mode === "direct" }); // 父进程 env → 沙箱目录 → 预设 env → 预设 envDefaults（父进程已设的不覆盖）
  if (kept.length) log.info(`env defaults kept from parent: ${kept.join(",")}`); // 部署方显式设置的审批类开关
  prepareAgent(ag); // 启动前落盘 agent 需要的派生配置（DSH 的 session-root patch）
  const fp = configFingerprint(ag, rt);
  const proc = spawnAgent(ag, { cwd: rt.cwd, env });
  child = proc;
  log.info(
    `spawn ${ag.name} acp pid=${proc.pid} cwd=${rt.cwd} home=${rt.home} bin=${ag.bin} args=[${ag.args.join(" ")}]`,
  );
  // 身份记录（JSON）：manage.ts 据此算进程特征串与展示 live 状态，不必猜「配置里的 agent 是不是正在跑的那个」
  writePidRecords(BRAIN_PID_FILE, [pidRecordOf(proc.pid!, ag)]);
  proc.stdout.on("data", (d) => feedAcpStdout(stdoutLines, d, (f) => handleAcpFrame(f, host)));
  proc.stderr.on("data", () => {
    /* ignore */
  });
  // 只在"退出的就是当前 child"时才重置，避免旧进程迟到的 exit 误杀新进程
  proc.on("exit", (code) => {
    // A：握手前就退出时，把「args 可能漏了 ACP 模式参数」直接写进日志（比只报一行 exited 好查）
    const hint = child === proc && !initialized ? acpArgsHint(ag) : "";
    (code === 0 ? log.info : log.warn)(`acp exited code=${code}${hint}`);
    if (child === proc) reset();
  });
  proc.on("error", (e) => {
    log.error(`acp error ${String(e)}`);
    if (child === proc) reset();
  });
  try {
    await requestAcp(
      host,
      "initialize",
      { protocolVersion: 1, clientCapabilities: {} },
      REQ_TIMEOUT,
    );
  } catch (e) {
    // A：initialize 超时/失败最常见的原因是 args 覆盖漏了 ACP 子命令——把诊断提示附在同一行日志里
    log.error(`initialize failed: ${String(e)}${acpArgsHint(ag)}`);
    throw e;
  }
  initialized = true;
  configFp = fp;
  log.info("initialized");
}

async function ensureSession(ag: ResolvedAgent, userId: string): Promise<string> {
  const existing = userSessions.get(userId);
  if (existing) return existing;
  const rt = agentRuntime("brain", ag);
  // 配了 mcpViaAcp 的 agent（DSH / Claude Code / Copilot / Codex）：MCP 随 session 下发；
  // direct 下发真实 catalog 全量（parity）+ overlay，sandbox 下发 curated 激活集；其余 agent 传空（走各自配置文件）。
  const mcpServers = ag.mcpViaAcp ? activeMcpServers(ag, rt) : [];
  const map = loadSessionMap(ag);
  const saved = map[keyOf(ag, userId)];
  if (saved) {
    // agent 指定 resume（DSH）；其余仍先 load，失败再试 resume，最后 new
    const methods: Array<"load" | "resume"> =
      ag.restore === "resume" ? ["resume"] : ["load", "resume"];
    const savedCwd = getSessionCwd(ag.name, saved);
    const cwd = savedCwd ?? rt.cwd;
    for (const method of methods) {
      let restored: any;
      let establishMs = 0;
      try {
        const tEstablish = Date.now();
        restored = await requestAcp(
          host,
          `session/${method}`,
          { sessionId: saved, cwd, mcpServers },
          REQ_TIMEOUT,
        );
        establishMs = Date.now() - tEstablish;
        await drainAcpReplay(host, ag);
      } catch (e) {
        log.warn(`session/${method} failed (${String(e)})`);
        continue;
      }
      // 恢复已经成功：模型设置失败只记日志，不能退回 session/new——那会丢掉刚恢复的上下文。
      // （applyModel 自己会记 `model set failed`，这里只负责不让它把恢复判成失败。）
      try {
        await applyAcpModel(host, ag, saved, REQ_TIMEOUT);
      } catch {
        /* 已在 applyModel 内记日志 */
      }
      await applyAcpSessionMode(host, ag, saved, availableAcpModes(restored), REQ_TIMEOUT);
      userSessions.set(userId, saved);
      if (!savedCwd) setSessionCwd(ag.name, saved, cwd);
      markUsed(ag.name, userId, saved); // 会话登记表：把它顶到「最近使用」（列表按此排序）
      const perf = {
        mcpCount: mcpServers.length,
        nativeMcpCount: Object.keys(nativeMcpServers(ag)).length,
        sessionNewMs: establishMs,
      };
      sessionPerf.set(saved, perf);
      log.info(
        `session/${method} ok ${saved} mcp=[${mcpServers.map((s: any) => s.name).join(",")}] ${formatMcpPerf(perf)}`,
      );
      for (const warning of mcpPerfWarnings(perf)) log.warn(warning);
      return saved;
    }
  }
  const tNew = Date.now();
  const res = (await requestAcp(host, "session/new", { cwd: rt.cwd, mcpServers }, REQ_TIMEOUT)) as {
    sessionId?: string;
  };
  const sessionNewMs = Date.now() - tNew;
  if (!res?.sessionId) throw new Error("session/new returned no sessionId");
  await applyAcpModel(host, ag, res.sessionId, REQ_TIMEOUT);
  await applyAcpSessionMode(host, ag, res.sessionId, availableAcpModes(res), REQ_TIMEOUT);
  userSessions.set(userId, res.sessionId);
  setSessionCwd(ag.name, res.sessionId, rt.cwd);
  map[keyOf(ag, userId)] = res.sessionId;
  saveSessionMap(map);
  ensureEntry(ag.name, userId, res.sessionId); // 会话登记表：新会话进列表（turns 从 0 起）
  const perf = {
    mcpCount: mcpServers.length,
    nativeMcpCount: Object.keys(nativeMcpServers(ag)).length,
    sessionNewMs,
  };
  sessionPerf.set(res.sessionId, perf);
  log.info(
    `session/new ok ${res.sessionId} mcp=[${mcpServers.map((s: any) => s.name).join(",")}] ${formatMcpPerf(perf)}`,
  );
  for (const warning of mcpPerfWarnings(perf)) log.warn(warning);
  return res.sessionId;
}

/** 向大脑（配置的 ACP agent）提问（常驻 + 原生多轮）。失败即重建进程（下条用 session/load 恢复上下文）。 */
export async function askBrain(
  userId: string,
  message: string,
  onProgress?: (ev: ProgressEvent) => void,
  images?: Array<{ data: string; mimeType: string }>,
  opts: { deadline?: number } = {},
): Promise<string> {
  return (await askBrainTurn(userId, message, onProgress, images, opts)).text;
}

/**
 * 同 `askBrain`，但把**实际答话的 agent** 一并返回。
 * 交接摘要必须记实际大脑：请求排队期间可能刚好切换完成，只读入口时的槽位会记错来源。
 */
export async function askBrainTurn(
  userId: string,
  message: string,
  onProgress?: (ev: ProgressEvent) => void,
  images?: Array<{ data: string; mimeType: string }>,
  opts: { deadline?: number } = {},
): Promise<{ text: string; agent: string }> {
  await waitWhileSwitching(); // 切换进行中就先在门口等（有界）：绝不在启动新大脑时双起进程
  return withBrainOp(async () => {
    if (expired(opts.deadline)) throw new Error(EXPIRED_MSG);
    const ag = getAgent("brain"); // 排队期间可能刚切过脑——轮到本操作时才取槽位
    const text = await runTurn(ag, userId, message, onProgress, images);
    return { text, agent: ag.name };
  });
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
  beginAcpTurn(turn, sid, onProgress);
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
      text: "（系统提示：你正在通过微信和用户对话。需要给用户发图片时，在回复里用 Markdown 图片语法 ![](图片的 http 链接或本地文件绝对路径)，系统会自动把它作为图片消息发出（你本身不会文生图，可发联网搜到的图、本地已有的图、或自己用代码渲染保存的图表）。需要发文件/视频时，用显式链接 [附件](file:///绝对路径)、[文件](file:///绝对路径) 或 [视频](file:///绝对路径)；系统会读取本地文件并作为文件/视频消息发出（音频请按文件发，不支持语音气泡）。服务器从中国大陆下载图片，请选「可直接下载的直链」——优先 raw.githubusercontent.com 等原始文件直链；避免 wikipedia/wikimedia（大陆被墙）以及 pixabay/unsplash 等带热链保护、直链常返回 403 的图床。拿不准时优先把图先下载到本地再用本地绝对路径引用，或直接发链接让用户自己点。其余正常用文字/Markdown 回复。此提示只出现一次，无需理会本句。）",
    });
  }
  prompt.push({ type: "text", text: message || "（用户发来一张图片，请查看并回应）" });
  try {
    await promptAcp(
      host,
      { sessionId: sid, prompt },
      {
        idleMs: PROMPT_IDLE_MS,
        capMs: PROMPT_CAP_MS,
        firstFrameMs: firstFrameMs(ag),
      },
    );
    const txt = acpTurnText(turn, sid);
    // 成功回合才登记：轮次 +1、刷新最近使用、首次写入标题（用户消息前 30 字；纯图片消息没有文字 → 留给下一次）
    // 标题取**剥掉交接前缀**后的正文：不然列表里全是「【交接摘要 · 来自 …】」，用户认不出哪条是哪条。
    touchEntry(ag.name, userId, sid, { title: titleOf(stripHandoffPrefix(message)) });
    const turnPerf = {
      mcpCount: sessionPerf.get(sid)?.mcpCount ?? 0,
      firstFrameMs: acpTurnFirstFrameMs(turn),
    };
    log.info(
      `prompt ok ${Date.now() - t0}ms chunks=${acpTurnChunks(turn, sid)} updateTypes=[${[...turn.seenUpdateTypes].join(",")}] ${formatMcpPerf(turnPerf)}`,
    );
    for (const warning of mcpPerfWarnings(turnPerf)) log.warn(warning);
    return txt;
  } catch (e) {
    const chunks = acpTurnChunks(turn, sid);
    const sinceFrame = rpcState.lastFrameAt ? Date.now() - rpcState.lastFrameAt : -1;
    log.warn(
      `prompt FAIL ${Date.now() - t0}ms chunks=${chunks} lastFrameAgo=${sinceFrame}ms err=${String(e)} -> rebuild`,
    );
    reset(); // 自愈：杀掉可能假死的进程，下条消息重建并 session/load 恢复
    throw e;
  } finally {
    endAcpTurn(turn, sid);
  }
}

/** 用户主动开新会话：丢弃旧 session（含磁盘映射），重建一个全新 session。 */
export async function newSession(userId: string, opts: { deadline?: number } = {}): Promise<void> {
  await waitWhileSwitching();
  await withBrainOp(async () => {
    if (expired(opts.deadline)) throw new Error(EXPIRED_MSG);
    const ag = getAgent("brain");
    const map = loadSessionMap(ag);
    delete map[keyOf(ag, userId)]; // 只清当前 agent 的；换大脑前那个 agent 的上下文仍保留
    saveSessionMap(map);
    userSessions.delete(userId);
    await ensureProcess(ag);
    await ensureSession(ag, userId);
  });
}

/**
 * 「恢复会话」：把某条**已有的**会话切回当前，**严格恢复**——只认真接上的 load/resume，
 * 接不上就如实报错，**绝不**回退成 session/new（那会让用户以为上下文回来了，其实是一张白纸），
 * 也**不改**当前会话记录（当前会话原样保留，用户还能继续用）。
 * 成功才动磁盘：userSessions + 当前会话表（`<agent>:<userId>` → 这条）。
 */
export async function resumeSession(
  userId: string,
  sessionId: string,
  opts: { deadline?: number } = {},
): Promise<{ ok: true } | { ok: false; problem: string }> {
  await waitWhileSwitching();
  return withBrainOp(async () => {
    if (expired(opts.deadline)) throw new Error(EXPIRED_MSG);
    const ag = getAgent("brain");
    const short = sessionId.slice(0, 8);
    await ensureProcess(ag);
    const rt = agentRuntime("brain", ag);
    const mcpServers = ag.mcpViaAcp && rt.mode !== "direct" ? activeMcpServers(ag) : [];
    const savedCwd = getSessionCwd(ag.name, sessionId);
    const cwd = savedCwd ?? rt.cwd;
    const methods: Array<"load" | "resume"> =
      ag.restore === "resume" ? ["resume"] : ["load", "resume"];
    let lastErr = "";
    for (const method of methods) {
      try {
        const restored = await requestAcp(
          host,
          `session/${method}`,
          { sessionId, cwd, mcpServers },
          REQ_TIMEOUT,
        );
        await drainAcpReplay(host, ag);
        await applyAcpModel(host, ag, sessionId, REQ_TIMEOUT);
        await applyAcpSessionMode(host, ag, sessionId, availableAcpModes(restored), REQ_TIMEOUT);
        userSessions.set(userId, sessionId);
        if (!savedCwd) setSessionCwd(ag.name, sessionId, cwd);
        const map = loadSessionMap(ag);
        map[keyOf(ag, userId)] = sessionId;
        saveSessionMap(map);
        log.info(`resume ok ${sessionId}`);
        return { ok: true };
      } catch (e) {
        lastErr = String(e);
        log.error(`resume session/${method} failed (${lastErr})`);
      }
    }
    return {
      ok: false,
      problem: `接不上会话 ${short}（该 agent 不支持恢复，或这条会话已被它自己清理）。当前会话没变，可以继续用；要开新的就发「新会话」。${lastErr ? `\n（原因：${lastErr.slice(0, 120)}）` : ""}`,
    };
  });
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

/**
 * MCP 激活集变更后用：切换进行中先等它结束（有界），再重启——否则会把正在预热的新大脑杀在半路。
 * 返回 false 表示切换在等待上限内仍未结束，这次没有重启（避免留下一个半截的新大脑）。
 */
export async function restartForMcpChange(): Promise<boolean> {
  if (switching && !(await drainSwitch(SWITCH_WAIT_MS))) return false;
  if (isTurnInFlight()) {
    pendingReload = true;
    log.info("MCP/config 已变更：等当前回合结束再重启大脑（不打断正在生成的回复）");
    return true;
  }
  pendingReload = false;
  restart();
  return true;
}

/** 当前大脑是否接受图片输入（配置里的能力；默认 true）。 */
export function supportsImages(): boolean {
  return getAgent("brain").images;
}

/** 当前 agent 的静默期心跳覆盖（默认 undefined → 15s）。按回合取：热切换后心跳随之改变。 */
export function heartbeatMs(): number | undefined {
  return getAgent("brain").heartbeatMs;
}
