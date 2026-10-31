#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  getUpdates,
  sendMessage,
  sendTyping,
  getConfig,
  notifyStart,
  generateId,
  SESSION_EXPIRED_ERRCODE,
  isSessionPaused,
  pauseSession,
  getRemainingPauseMs,
  loadAccount,
  loadState,
  saveState,
  DATA_DIR,
  MessageItemType,
  MessageState,
  MessageType,
  downloadImage,
  sendImage,
  sendFile,
  ILinkError,
  classifyTransportError,
  isAllowed,
  addAllowFrom,
  readAllowFrom,
} from "@wemind/wechat-ilink-core";
import type {
  AccountData,
  ServerState,
  WeixinMessage,
  SendMessageReq,
  ImageItem,
} from "@wemind/wechat-ilink-core";
import {
  askBrain,
  newSession,
  restart,
  resumeSession,
  supportsImages,
  heartbeatMs,
} from "./acp-brain.js";
import {
  agentProblem,
  authHint,
  BRAIN_CONFIG_EXIT_CODE,
  presetAvailable,
  presetNames,
  resolvePresetByName,
} from "./brain-agents.js";
import type { ResolvedAgent } from "./brain-agents.js";
import { agentConfigFor, loadBrainConfig } from "./brain-config.js";
import { getAgent, seedSlots, setAgent } from "./agent-slot.js";
import { preflightSwitch, switchBrain, switchInFlightTarget } from "./brain-switch.js";
import { writeBrainState } from "./brain-state.js";
import {
  isOwnerOnly,
  renderHelp,
  parseChatCommand,
  parseTaskCommand,
  type ChatCommand,
  type TaskCommand,
} from "./chat-commands.js";
import { ensureBrainHome, addMcp, removeMcp, listMcp } from "./mcp-sandbox.js";
import {
  deleteSessionCmd,
  newSessionCmd,
  renameSessionCmd,
  resumeSessionCmd,
  sessionsCmd,
  type SessionCtx,
} from "./session-manager.js";
import { syncFromPointerMap, currentSessionIdOf } from "./session-registry.js";
import {
  clearControlDirs,
  controlInboxDir,
  markBridgeReady,
  readControlInbox,
  writeControlResponse,
  type ControlRequest,
} from "./control-bridge.js";
import {
  HANDOFF_PROMPT,
  HANDOFF_TTL_MS,
  HANDOFF_VERSION,
  clearHandoff,
  handoffPrefix,
  loadHandoff,
  saveHandoff,
  takeHandoffFor,
} from "./handoff.js";
import { extractImages, resolveImageBytes } from "./image-reply.js";
import { LONG_REPLY_THRESHOLD, buildMdReply } from "./md-reply.js";
import { PENDING_PUSH_MAX_TRIES, PendingPushes } from "./pending-push.js";
import {
  dispatchTask,
  injectTask,
  stopTask,
  hasActiveTask,
  awaitingTasks,
  interruptedTasks,
  looksLikeResume,
  renderTaskList,
  initTasks,
  setTaskPush,
  setTaskTyping,
  setTaskStateSink,
  setTaskAckSink,
  taskPoolSummary,
  providerIssue,
  type TaskStateSnapshot,
} from "./task-manager.js";
import { clearTaskDirs, taskInboxDir, writeTaskAck } from "./task-inbox.js";
import {
  killAll as killWorkerPool,
  killIdle as killIdleConns,
  sweep as sweepWorkerPool,
} from "./worker-pool.js";
import { ensureWorkerHome } from "./worker-sandbox.js";

const log = (...a: unknown[]) => console.error("[wemind/wechat-daemon]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 分类大脑错误：backend=模型后端瞬时错误(可多重试)；timeout=超时/卡死；other=其它。 */
function classifyBrainError(e: unknown): "timeout" | "backend" | "other" {
  const s = String(e instanceof Error ? e.message : e);
  if (
    /-32603|internal error|please try again|response stream|overloaded|rate.?limit|\b(429|503)\b/i.test(
      s,
    )
  )
    return "backend";
  if (/idle timeout|no-first-frame|cap timeout|timeout/i.test(s)) return "timeout";
  return "other";
}
/**
 * 一次大脑失败该怎么处置：provider 侧（余额/额度、密钥鉴权、计费、模型不存在）是**永久**错误——
 * 重试只是又白失败一轮，何况每次重试都要先冷启动一个 agent 进程；这类只试 1 次，直接把原因告诉用户。
 * 其余沿用老规矩：backend（`-32603`/限流等瞬时错误）3 次，timeout/其它 2 次。
 */
export function brainFailurePlan(e: unknown): { attemptLimit: number; category: string } {
  const prov = providerIssue(e);
  if (prov) return { attemptLimit: 1, category: `provider：${prov}` };
  const cat = classifyBrainError(e);
  return { attemptLimit: cat === "backend" ? 3 : 2, category: cat };
}
/** 按错误类型给用户的失败提示。`agentName` 用于给特定 agent 补专属建议（如 Cline 的自定义 provider 要设环境变量）。 */
export function brainErrorMessage(e: unknown, agentName?: string): string {
  const prov = providerIssue(e);
  if (prov) {
    // 余额/计费在 provider 侧处理完，重发消息即可（daemon 不用重启）；
    // 密钥/模型类常常是刚在本机改过登录态或 brain.json——运行中的 daemon 不重读配置、也不重新同步凭据（槽位启动时种入），
    // 必须重启一次才生效，所以这句提示要说全，否则用户会陷入「改了、重发、还是错」。
    // Cline 是例外：自定义 provider 只认启动环境里的 CLINE_PROVIDER/CLINE_API_KEY，重启不带变量照样失败——
    // 用 agent 专属提示顶掉通用那句（`authHint`）。
    const auth = agentName ? authHint(agentName, String(e instanceof Error ? e.message : e)) : "";
    const hint = auth
      ? ` ${auth}`
      : prov === "密钥/鉴权有问题" || prov === "模型不可用"
        ? "若刚在本机改过登录态或模型配置，还要重启一次 daemon（wemind stop && wemind start）才会读到。"
        : "";
    return `（这次没答上来：${prov}。这类问题重试不会好——把账号/模型处理好后把消息再发一次就行。${hint}）`;
  }
  switch (classifyBrainError(e)) {
    case "backend":
      return "（模型后端临时出错了，自动重试多次仍失败，请稍后把消息再发一次）";
    case "timeout":
      return "（这次处理超时/卡住被中断了，重试也没成功——可把任务拆小一点再发）";
    default:
      return "（处理出错了，请把消息再发一次试试）";
  }
}

function extractText(msg: WeixinMessage): string {
  return (msg.item_list ?? [])
    .map((it) => {
      if (it.type === MessageItemType.TEXT) return it.text_item?.text ?? "";
      if (it.type === MessageItemType.VOICE) return it.voice_item?.text ?? ""; // 微信侧语音转文字（省事路）
      return "";
    })
    .filter((s) => s)
    .join("\n")
    .trim();
}

/** 工具标题中文化（无 purpose 时的兜底）。 */
function zhTool(t: string): string {
  return t
    .replace(/^Searching the web for:?\s*/i, "联网搜索：")
    .replace(/^Running:?\s*/i, "执行：")
    .replace(/^Reading\s+/i, "读取 ")
    .replace(/^Writing\s+/i, "写入 ")
    .replace(/^Finding\s+/i, "查找 ");
}

/** 按工具类型给图标。 */
function toolIcon(kind?: string): string {
  switch (kind) {
    case "read":
      return "📄";
    case "search":
      return "🔍";
    case "execute":
      return "⌨️";
    case "fetch":
      return "🌐";
    case "edit":
    case "write":
      return "✏️";
    case "delete":
      return "🗑️";
    default:
      return "🔧";
  }
}

/**
 * 解析控制指令（命中则由 daemon 直接处理，不转发给 brain）。
 * 表与解析逻辑都在 chat-commands.ts（`manage.ts` 也要用它渲染 `wemind help`，故不能留在这里）。
 */
export function parseControl(text: string): ChatCommand | null {
  return parseChatCommand(text);
}

/** 解析「明确发给 worker」指令：任务 [agent：]正文 / >xxx / #编号 正文 / 任务列表 / 结束任务 [编号]。 */
export function parseTaskControl(text: string): TaskCommand | null {
  return parseTaskCommand(text);
}

/** 解析「明确问大脑」逃逸前缀：问大脑 xxx / 问大脑：xxx。命中返回去前缀后的文本（强制走 brain，即使 worker 在等你）。 */
export function parseBrainEscape(text: string): string | null {
  const m = text.trim().match(/^问大脑[:：]?\s*([\s\S]+)$/);
  return m ? m[1].trim() : null;
}

/** 切脑结果/来源的中文说法（`AI` 总览与答复共用一套词，避免两处说法不一致）。 */
const SOURCE_LABEL: Record<ResolvedAgent["source"], string> = {
  env: "环境变量",
  file: "brain.json",
  auto: "自动探测",
};

function agentLine(ag: ResolvedAgent): string {
  return `${ag.name}（来源：${SOURCE_LABEL[ag.source]}）`;
}

/** `AI` / `/ai`：可选 agent（带「装了没」）+ 当前对话大脑/默认任务大脑 + 池中进程。 */
function agentOverview(): string {
  const cfg = loadBrainConfig();
  const brain = getAgent("brain");
  const worker = getAgent("worker");
  const list = presetNames()
    .map((k) => `${k}${presetAvailable(k, cfg) ? "✅" : "❌"}`)
    .join("、");
  const pool = taskPoolSummary();
  const lines = [
    "🤖 AI 配置",
    `对话大脑：${agentLine(brain)}`,
    `默认任务大脑：${agentLine(worker)}${worker.name === brain.name ? "（随对话大脑）" : ""}`,
    pool.length
      ? `池中 worker：${pool.map((p) => `${p.agent} 忙${p.busy}${p.taskIds.length ? `(#${p.taskIds.join("/")})` : ""}/闲${p.idle}`).join(" ｜ ")}`
      : undefined,
    `可选 agent：${list}、auto`,
    "切换：`切换大脑 <agent 名>` ｜ `切换任务大脑 <agent 名>`",
  ].filter((x): x is string => x !== undefined);
  return lines.join("\n");
}

/**
 * 切对话大脑：先回 ack，启动新大脑在后台跑、结果补发（决策⑦：切换可能要几十秒，不能让用户干等等不到一句回话）。
 * 这里**不** await 整段切换——启动新大脑期间的入站消息会自己在 acp-brain 门口等新大脑就绪（有界），不会双起进程。
 */
async function switchBrainAck(target: string, userId: string, ctx: ControlCtx): Promise<string> {
  const running = switchInFlightTarget();
  if (running) return `正在切到「${running}」，等它完成后再发一次。`;
  const pre = preflightSwitch(target, DATA_DIR);
  if (!pre.ok) return `❌ ${pre.problem}`;
  if (pre.already) {
    // 已经是它（只是把选择落到 brain.json）：亚毫秒级，直接等它，不用 ack/补发两段
    const out = await switchBrain(target, { userId, dir: DATA_DIR });
    return out.ok ? out.notice : `❌ ${out.problem}`;
  }
  void switchBrain(target, { userId, dir: DATA_DIR })
    .then((out) => (out.ok ? out.notice : `❌ ${out.problem}`))
    .catch((e) => `❌ 切换出错：${String(e)}`)
    .then(async (r) => {
      log("brain switch:", r.replace(/\n/g, " | "));
      await ctx.notify(r).catch((e) => log("switch notice failed:", String(e)));
    });
  return `⏳ 正在切到「${pre.agent.name}」…（正在启动新大脑，成功或失败稍后补发消息；这期间发来的消息会等新大脑就绪）`;
}

/** `切换任务大脑`：只改本进程的默认任务大脑（本次运行内一直生效，不写 brain.json）。 */
function setTaskBrain(target: string): string {
  const key = target.trim().toLowerCase();
  const cfg = loadBrainConfig(DATA_DIR);
  const r = resolvePresetByName(key, agentConfigFor(cfg, "worker"));
  if (!r.ok) return `❌ ${r.problem}`;
  const cur = getAgent("worker");
  // 与 brain-switch 的 sameAgent 同一条判据（name/bin/args/model）：任一项不同都算一次真切换，
  // 否则「改完再切」会被判成「已经是它」，新任务继续用旧二进制/旧参数/旧模型。
  if (
    cur.name === r.agent.name &&
    cur.bin === r.agent.bin &&
    cur.args.join("\u0000") === r.agent.args.join("\u0000") &&
    cur.model === r.agent.model
  )
    return `默认任务大脑已经是「${r.agent.name}」，无需切换。`;
  setAgent("worker", r.agent);
  const busy = hasActiveTask();
  killIdleConns(); // 池里的空闲连接属于旧默认：留着没用（下次按新 agent 取），有任务在跑的那些不动
  const note = "（不写 brain.json，重启后回到配置里的默认）";
  return busy
    ? `✅ 默认任务大脑：${cur.name} → ${r.agent.name}${note}。\n在跑的任务继续用它自己起的 agent 跑完；**之后的新任务**用新大脑。`
    : `✅ 默认任务大脑：${cur.name} → ${r.agent.name}${note}。`;
}

type ControlCtx = {
  /** 登录者 id（帮助文案据此裁剪）。 */
  owner: string;
  /** 补发一条「必须送达」的消息（用于切脑的 ack/结果两段答复）。 */
  notify: (text: string) => Promise<void>;
  /** 补发一份长内容（交接摘要这类「要给用户留着」的文本走 .md 文件，不刷屏）。 */
  notifyFile?: (text: string) => Promise<void>;
};

/**
 * `交接`：让当前大脑把上下文写成摘要，写入磁盘 + 回复给用户（长则另发 .md）。
 * 先回一条「在做」的提示：写摘要要走一整个模型回合（可能一两分钟），没有进度提示会让人以为卡死。
 */
async function runHandoff(userId: string, ctx: ControlCtx): Promise<string> {
  const from = getAgent("brain").name;
  if (!currentSessionIdOf(from, userId, DATA_DIR))
    return "ℹ️ 当前大脑还没有和你的对话记录，没什么可交接的。先聊几句再来交接。";
  await ctx
    .notify(`⏳ 正在让「${from}」把当前上下文写成交接摘要…（可能要一两分钟）`)
    .catch(() => {});
  let text: string;
  try {
    text = (await askBrain(userId, HANDOFF_PROMPT)).trim();
  } catch (e) {
    return `❌ 生成交接摘要失败：${String(e)}`;
  }
  if (!text) return "❌ 大脑这次没给出摘要内容（空回复），没有保存。可以再试一次。";
  const now = Date.now();
  saveHandoff(
    {
      version: HANDOFF_VERSION,
      fromAgent: from,
      userId,
      text,
      createdAt: now,
      expiresAt: now + HANDOFF_TTL_MS,
    },
    DATA_DIR,
  );
  const head =
    `✅ 交接摘要已保存（${text.length} 字，来自「${from}」）。\n` +
    `切到别的大脑后，你发的第一条消息会自动带上它（答完即用掉，只带一次；切回「${from}」不带上）。`;
  if (text.length > LONG_REPLY_THRESHOLD && ctx.notifyFile) {
    await ctx.notifyFile(text).catch((e) => log("handoff md send failed:", String(e)));
    return `${head}\n（摘要较长，已另发 .md 文件。）`;
  }
  return `${head}\n\n${text}`;
}

async function handleControl(c: ChatCommand, userId: string, ctx: ControlCtx): Promise<string> {
  if (c.kind === "list") return listMcp();
  // 会话类指令的共用上下文：谁、当前对话大脑、数据目录（登记表按 agent 分开存，切换后自然按新大脑列）
  const sc = (): SessionCtx => ({ agent: getAgent("brain").name, userId, dir: DATA_DIR });
  if (c.kind === "new") return await newSessionCmd({ ...sc(), name: c.name, create: newSession });
  if (c.kind === "sessions") return sessionsCmd({ ...sc(), page: c.page });
  if (c.kind === "resume") return await resumeSessionCmd({ ...sc(), resume: resumeSession }, c.ref);
  if (c.kind === "rename") return renameSessionCmd(sc(), c.ref, c.name);
  if (c.kind === "delete") return deleteSessionCmd(sc(), c.ref);
  if (c.kind === "add") {
    const r = addMcp(c.name);
    restart(); // 重启 acp 进程，使其按新沙箱 mcp.json 重新加载
    return r;
  }
  if (c.kind === "remove") {
    const r = removeMcp(c.name);
    restart();
    return r;
  }
  if (c.kind === "ai") return agentOverview();
  if (c.kind === "brain")
    return c.target
      ? await switchBrainAck(c.target, userId, ctx)
      : `当前对话大脑：${agentLine(getAgent("brain"))}。切换用 \`切换大脑 <agent 名>\`（可选：${presetNames().join("、")}、auto）。`;
  if (c.kind === "workerBrain")
    return c.target
      ? setTaskBrain(c.target)
      : `当前默认任务大脑：${agentLine(getAgent("worker"))}。切换用 \`切换任务大脑 <agent 名>\`。`;
  if (c.kind === "help") return renderHelp(userId === ctx.owner ? "owner" : "user", "wechat");
  if (c.kind === "handoff") return await runHandoff(userId, ctx);
  // 兜底：指令表新增了 kind 但这里还没接通时（正常情况下 TS 会先把这里判成不可达），别静默吞掉
  return `「${(c as { kind: string }).kind}」这条指令还没接通（当前版本请先用 CLI 对应命令）。`;
}

async function setTyping(
  account: AccountData,
  to: string,
  ctx: string | undefined,
  status: 1 | 2,
): Promise<void> {
  if (!ctx) return;
  try {
    const cfg = await getConfig({
      baseUrl: account.baseUrl,
      token: account.botToken,
      ilinkUserId: to,
      contextToken: ctx,
    });
    await sendTyping({
      baseUrl: account.baseUrl,
      token: account.botToken,
      body: { ilink_user_id: to, typing_ticket: cfg.typing_ticket, status },
    });
  } catch (e) {
    // typing 是体验增强（best-effort 不阻断），但失败要留痕：区分「偶发网络失败」与「ticket 拿不到」
    log(`setTyping(${status}) failed:`, String(e));
  }
}

async function reply(
  account: AccountData,
  to: string,
  ctx: string | undefined,
  text: string,
  state: number = MessageState.FINISH,
  fallbackToken?: string,
): Promise<void> {
  const send = (token: string | undefined) => {
    const req: SendMessageReq = {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateId("wemind/wechat-daemon"),
        message_type: MessageType.BOT,
        message_state: state,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
        context_token: token,
      },
    };
    return sendMessage({ baseUrl: account.baseUrl, token: account.botToken, body: req });
  };
  try {
    await send(ctx);
  } catch (e) {
    // ret=-2 既可能是「限流」(rapid sends)也可能是「context_token 失效/不匹配」(参数错误)。
    // 两者都靠：退避 ~1.5s 后重试一次——限流靠等待恢复，失效 token 则换用该用户最新缓存 token。
    if (e instanceof ILinkError && e.kind === "param_error") {
      log("send -2(限流或token失效) → 退避 1.5s 后重试");
      await new Promise((r) => setTimeout(r, 1500));
      await send(fallbackToken && fallbackToken !== ctx ? fallbackToken : ctx);
      return;
    }
    // 传输层错误（网络抖动 fetch failed/ECONNRESET/超时等）：可重试类退避 1.5s 后重试一次
    if (!(e instanceof ILinkError)) {
      const t = classifyTransportError(e);
      if (t.retryable) {
        log(`send 传输错误(${t.kind}) → 退避 1.5s 后重试`);
        await new Promise((r) => setTimeout(r, 1500));
        await send(ctx);
        return;
      }
    }
    throw e;
  }
}

/** 统一的发送错误处理：按错误类型分类记录；会话过期则暂停账号。 */
function handleSendError(e: unknown, account: AccountData): void {
  if (e instanceof ILinkError) {
    log("send error:", e.message);
    if (e.kind === "session_expired") {
      pauseSession(account.botId);
      log("会话过期(-14) on send → 该账号暂停 1h，待重新登录");
    }
  } else {
    const t = classifyTransportError(e);
    log(`send error(传输/${t.kind}${t.retryable ? ",可重试" : ""}):`, t.message);
  }
}

// 串行发送队列：保证多条消息（进度/答案）按入队顺序送达，不并发乱序
let replyChain: Promise<void> = Promise.resolve();
let lastSendAt = 0;
// 两条发送之间的最小间隔：iLink 对 bot 发送有速率限流（rapid sends → ret=-2 "rate limited"，导致消息丢失，见 NousResearch/hermes-agent#21011）。全局节流主动规避。
const MIN_SEND_GAP_MS = Number(process.env.WECHAT_MIN_SEND_GAP_MS) || 1500;

// iLink 在用户回复前能连续发送的消息数上限（实测约 10，可调）。
const CONSEC_SEND_LIMIT = Number(process.env.WECHAT_CONSEC_SEND_LIMIT) || 10;
// 静默期心跳默认 15s（配置可放宽，如 DSH 的 60s）；间隔在每回合开头算，见 handleMessage 的 heartbeatMsValue。
const HEARTBEAT_DEFAULT_MS = 15_000;
// 「距该用户上一条消息以来」bot 已连续发送的条数 + 是否处于"等待继续"段。按用户(to)维护、**跨回合持续**，仅在该用户发来任何消息时重置（照抄服务端"任何用户消息都重置连续发送配额"的规则）。
// 这样即使 A 任务期间你发了 B、A 又继续发了几条，B 任务接手时计数是延续的，不会误以为"还能再发10条"而撞上限。
type SendBudget = { count: number; awaiting: boolean };
const sendBudget = new Map<string, SendBudget>();
function budgetOf(to: string): SendBudget {
  let b = sendBudget.get(to);
  if (!b) {
    b = { count: 0, awaiting: false };
    sendBudget.set(to, b);
  }
  return b;
}
// 重启后旧 token 期间「必须送达」外发的挂起队列：任务结果、CLI 指令答复在用户发来下一条消息之前必然 -2（重试也还是旧 token），消息直接丢。先挂起，新 token 一到按序补发（见 poller 登记最新 token 的地方）。
const pendingPushes = new PendingPushes();
// 本进程**收到过**该用户消息 = 手里是这一进程拿到的 token。只有在这之前的 -2 才是「旧 token」；之后的 -2 属于限流，不该挂起（挂起只会把过时的答复拖到用户下一条消息，反而更乱）。
const freshTokenUsers = new Set<string>();
// 已入 replyChain、还没发完的外发条数（按收件人）。用户发来消息会重置连发计数，但这些「排在消息之后才上线路」的发送仍占服务端的额度，重置时不能一并清零（否则本回合会误以为额度还满，把最终的答案挤到限流上）。
const inflightSends = new Map<string, number>();
function trackInflight(to: string, delta: number): void {
  const n = (inflightSends.get(to) ?? 0) + delta;
  if (n > 0) inflightSends.set(to, n);
  else inflightSends.delete(to);
}
// 一次补发最多几条：连发额度约 10 条，补发太多会把它吃光、把用户这条消息的正常答复挤到限流上；剩下的留给后续消息继续补。
const PENDING_PUSH_BATCH = 5;

/** -2（param_error）：既可能是限流、也可能是 token 还是旧的——两者都值得「等该用户下一条消息再试」。 */
const isParamError = (e: unknown): boolean => e instanceof ILinkError && e.kind === "param_error";

/** 一条外发失败 → 若是「重启后旧 token」造成的 -2（该用户还没在本进程发过消息），挂起等新 token 补发；限流与其它错误照旧只记日志。 */
function holdUndelivered(to: string, text: string, e: unknown): void {
  if (!isParamError(e) || freshTokenUsers.has(to)) return;
  const n = pendingPushes.push(to, text);
  log(`send -2（旧 token）→ 挂起，累计 ${n} 条，等该用户下一条消息补发（${to}）`);
}

/** 补发又失败：重新挂起，等该用户下一条消息再试（传输错误也重挂——这条还没送达）；试够 PENDING_PUSH_MAX_TRIES 次就放弃——防一条永远被服务端拒绝的内容每次发消息都拖着 replyChain。 */
function requeueHeld(to: string, text: string, tries: number, e: unknown): void {
  const n = tries + 1;
  if (n >= PENDING_PUSH_MAX_TRIES) {
    log(
      `补发 ${n} 次仍失败 → 放弃这条挂起的推送（${to}）：${text.slice(0, 40)}（原因：${e instanceof Error ? e.message : String(e)}）`,
    );
    return;
  }
  const size = pendingPushes.push(to, text, n);
  log(`补发 ${n} 次仍失败 → 重新挂起，累计 ${size} 条（${to}）`);
}

/** 新 token 到了：把该收件人挂起的文本按序补发；剩下的留给后续消息。补发量受两重限制：单轮 PENDING_PUSH_BATCH 条、且不越过本回合留给答复的连发额度（否则补发自己就会撞限流、还会把用户的答案挤掉）。 */
function flushHeldPushes(account: AccountData, to: string, token: string): void {
  // 给最终答案留最后两条额度（sendProgress 在 count ≥ 上限-2 时才发「接近上限」提示并停下，答案再占一条）。
  const room = Math.max(0, CONSEC_SEND_LIMIT - 2 - budgetOf(to).count);
  if (room === 0) {
    log(`挂起 ${pendingPushes.size(to)} 条，但本回合连发额度已不够 → 留给后续消息补发（${to}）`);
    return;
  }
  const held = pendingPushes.take(to, Math.min(PENDING_PUSH_BATCH, room));
  if (held.length === 0) return;
  const rest = pendingPushes.size(to);
  log(
    `新 token 已到 → 补发挂起消息 ${held.length} 条（${to}）${rest > 0 ? `，还有 ${rest} 条排在后续消息` : ""}`,
  );
  for (const item of held) {
    budgetOf(to).count += 1;
    void sendOrdered(account, to, token, item.text, MessageState.FINISH, token, (e) =>
      requeueHeld(to, item.text, item.tries, e),
    );
  }
}
// 当前进行中回合（worker 串行，只有一个）：记录发往用户与所用 token（token 可被「继续」更新）。
let activeTurn: { from: string; token: string | undefined } | null = null;
// onError：「必须送达」的调用方（任务推送、指令答复）用它接管 -2 —— 没有更新的 token 时挂起，等用户下一条消息补发；不传则维持原来的「记日志就丢」。
function sendOrdered(
  account: AccountData,
  to: string,
  ctx: string | undefined,
  text: string,
  state: number = MessageState.FINISH,
  fallbackToken?: string,
  onError?: (e: unknown) => void,
): Promise<void> {
  trackInflight(to, 1);
  replyChain = replyChain
    .then(async () => {
      const wait = MIN_SEND_GAP_MS - (Date.now() - lastSendAt);
      if (wait > 0) await sleep(wait);
      await reply(account, to, ctx, text, state, fallbackToken).catch((e) => {
        handleSendError(e, account);
        onError?.(e);
      });
      lastSendAt = Date.now();
    })
    .finally(() => trackInflight(to, -1));
  return replyChain;
}

/**
 * 发一条「必须送达」的答复（控制指令答复、任务答复、任务结束确认、出错提示）。
 *
 * 与 sendOrdered 的唯一差别：**先计入连发额度**。服务端按「距用户上一条消息」计连续发送数，这类答复确实占额度；只发不计数会让 brain 回合的 budgetOf 低估真实值 → 误判「还能发」→ 撞 ret=-2 限流、结果丢失。计数后仍走同一条 replyChain，保证与进度/答案不乱序、遵守最小间隔。
 * 与 `setTaskPush` 同一套语义：task 推送也是「必须送达、只计数不被 awaiting 暂停」。
 */
function sendNotice(
  account: AccountData,
  to: string,
  ctx: string | undefined,
  text: string,
  fallbackToken?: string,
): Promise<void> {
  budgetOf(to).count += 1;
  return sendOrdered(account, to, ctx, text, MessageState.FINISH, fallbackToken, (e) =>
    holdUndelivered(to, text, e),
  );
}

/** 把长回复作为 .md 文件发送（走同一串行链+节流）；发文件失败则兜底回退为文本。 */
function sendMdOrdered(
  account: AccountData,
  to: string,
  ctx: string | undefined,
  finalText: string,
  fallbackToken?: string,
): Promise<void> {
  trackInflight(to, 1);
  replyChain = replyChain
    .then(async () => {
      const wait = MIN_SEND_GAP_MS - (Date.now() - lastSendAt);
      if (wait > 0) await sleep(wait);
      const { fileName, data } = buildMdReply(finalText);
      try {
        await sendFile({
          baseUrl: account.baseUrl,
          token: account.botToken,
          to,
          data,
          fileName,
          kind: "file",
          contextToken: ctx,
        });
        log(`final as md file: ${fileName} (${finalText.length} chars)`);
      } catch (e) {
        log("send md file failed, fallback to text:", String(e));
        await reply(account, to, ctx, finalText, MessageState.FINISH, fallbackToken).catch((er) =>
          handleSendError(er, account),
        );
      }
      lastSendAt = Date.now();
    })
    .finally(() => trackInflight(to, -1));
  return replyChain;
}

/** 从解密后的字节嗅探图片 MIME。 */
function sniffMime(b: Buffer): string {
  const h = b.subarray(0, 4).toString("hex");
  if (h.startsWith("89504e47")) return "image/png";
  if (h.startsWith("47494638")) return "image/gif";
  if (h.startsWith("52494646")) return "image/webp";
  return "image/jpeg";
}

/**
 * 处理一条发给大脑的消息。返回**是否真的答成了**（`brainErrorMessage` 兜底算没答成）——
 * 交接摘要的消费就靠这个返回值：只有答成了才把摘要删掉（失败留着，下次还能用）。
 */
async function handleMessage(
  account: AccountData,
  ctx: string | undefined,
  to: string,
  text: string,
  imageItems: ImageItem[],
  createTimeMs?: number,
  latestToken?: () => string | undefined,
): Promise<boolean> {
  const msgAge = () => (createTimeMs ? `${Math.round((Date.now() - createTimeMs) / 1000)}s` : "?"); // 这条消息已存在多久（诊断用）
  // activeTurn 只存当前回合的 from/token；连续发送计数用按用户、跨回合的 budgetOf(to)（不在回合开始清零）。
  activeTurn = { from: to, token: ctx };
  const cx = () => activeTurn?.token ?? ctx;
  await setTyping(account, to, cx(), 1);
  // 处理期间每 5s 续发"正在输入"（sendtyping 不计入连续消息上限），避免长任务时指示消失、用户以为卡了。
  // 间隔需小于客户端对 typing 的自动过期（约 5–8s），否则中间会出现指示闪烁的空洞。
  const keepAlive = setInterval(() => {
    void setTyping(account, to, cx(), 1).catch(() => {});
  }, 5000);

  const t0 = Date.now();
  let lastProgressAt = Date.now();
  // 心跳间隔**每回合**取一次：热切换大脑后新 agent 的心跳覆盖要立刻生效（改造前是 import 期定死的常量，
  // 切到 DSH（heartbeatMs=60s）却还按旧大脑的 15s 发心跳，白占微信连发额度）。
  const heartbeatMsValue =
    Number(process.env.WECHAT_BRAIN_HEARTBEAT_MS) || heartbeatMs() || HEARTBEAT_DEFAULT_MS;
  // iLink 限制 bot 在用户回复前连续发送的消息数（实测约 10，超出被 ret=-2 拒）。计数按用户跨回合维护(budgetOf)。
  // 当已发到「上限-2」(默认第8条)后，下一条进度改为「即将达上限」提示并进入等待，把最后一条额度留给最终答案；用户回复「继续」(或发任何消息)会重置计数恢复发送（见 poller）。
  const sendProgress = (msg: string) => {
    lastProgressAt = Date.now();
    const b = budgetOf(to);
    if (b.awaiting) return; // 等待「继续」期间不发任何进度
    // 发出一条文本会把客户端刚显示的「正在输入」顶掉 → 消息送达后立刻补发一次 typing，否则快回合（回复 < 旧 8s 续发间隔）全程看不到指示。
    const sendWithTyping = (text: string) => {
      void sendOrdered(account, to, cx(), text, MessageState.GENERATING)
        .then(() => setTyping(account, to, cx(), 1))
        .catch(() => {});
    };
    if (b.count >= CONSEC_SEND_LIMIT - 2) {
      b.count += 1;
      b.awaiting = true;
      sendWithTyping(
        "⚠️ 接近微信连续消息上限，我先暂停进度提示、继续在后台处理；完成后会把结果直接发给你。想立刻恢复进度可回复「继续」。",
      );
      return;
    }
    b.count += 1;
    sendWithTyping(msg);
  };
  // 即时答复：收到即给一条友好提示，保证用户看到的第一条文本不是 15s 兜底心跳。
  // （有图片时，下面的"🖼️ 收到 N 张图片…"已充当即时答复，不再重复发）
  if (imageItems.length === 0) {
    const t = cx();
    log(`turn start to=${to} msgAge=${msgAge()} usingCtx=…${t ? t.slice(-12) : "NONE"}`);
    sendProgress("🤖 收到，正在处理…");
  }
  // 心跳：仅当 brain 真正静默(无任何帧)超过心跳间隔才提示——首条用友好措辞，后续才带计时
  let hbCount = 0;
  let answerNoticeSent = false; // "正在整理回复"只发一次
  const heartbeat = setInterval(() => {
    if (Date.now() - lastProgressAt >= heartbeatMsValue) {
      hbCount += 1;
      sendProgress(
        hbCount === 1
          ? "🤔 还在思考/检索中…"
          : `⏳ 仍在处理中…（已 ${Math.round((Date.now() - t0) / 1000)} 秒）`,
      );
    }
  }, heartbeatMsValue);

  // 收图：下载并解密（失败的跳过）
  const images: Array<{ data: string; mimeType: string }> = [];
  if (imageItems.length > 0) {
    sendProgress(`🖼️ 收到 ${imageItems.length} 张图片，下载识别中…`);
    for (const im of imageItems) {
      try {
        const buf = await downloadImage(im);
        images.push({ data: buf.toString("base64"), mimeType: sniffMime(buf) });
      } catch (e) {
        log("image download failed:", String(e));
      }
    }
  }

  // 当前大脑不接受图片（如 DSH 0.2.1-rc.2 image:false）：不要让它以 -32602 失败重试
  if (images.length > 0 && !supportsImages()) {
    clearInterval(keepAlive);
    clearInterval(heartbeat);
    await setTyping(account, to, cx(), 2);
    budgetOf(to).count += 1;
    try {
      await sendOrdered(
        account,
        to,
        cx(),
        "🖼️ 当前大脑暂不支持看图，请改用文字描述，或切换到支持图片的大脑。",
        MessageState.FINISH,
      );
      log("image unsupported by current brain; rejected gracefully");
    } finally {
      activeTurn = null;
    }
    return false; // 没有答成：交接摘要不能被消费掉
  }

  // 一次尝试：带进度（步骤编号每次尝试重置）。进度消息节流：避免一回合刷十几条触发 iLink 发送限流（疑似 ret=-2 主因）
  const attempt = (promptText: string, imgs: typeof images): Promise<string> => {
    let step = 0;
    let lastToolProgressAt = 0;
    return askBrain(
      to,
      promptText,
      (ev) => {
        if (ev.type === "tool") {
          lastProgressAt = Date.now(); // 工具活动刷新心跳基线
          // 首条立即发（让你知道开始干活了），之后每 15s 最多一条，避免刷屏 + 触发限流
          if (Date.now() - lastToolProgressAt >= 15000) {
            lastToolProgressAt = Date.now();
            step += 1; // 只在真正发出时递增，保证步骤号连续（不因节流跳号）
            const desc = ev.purpose || (ev.title ? zhTool(ev.title) : "") || "调用工具";
            sendProgress(`${toolIcon(ev.kind)} 步骤 ${step}：${desc}`);
          }
        } else if (ev.type === "thinking") {
          lastProgressAt = Date.now();
        } else if (ev.type === "answer") {
          if (!answerNoticeSent) {
            answerNoticeSent = true;
            sendProgress("✍️ 正在整理回复…");
          }
        } else {
          // activity：brain 产出任意帧 → 静默刷新心跳基线，避免流式输出期间误报"仍在处理"
          lastProgressAt = Date.now();
        }
      },
      imgs,
    );
  };

  // 带分类的重试：provider 侧永久错误只试 1 次；backend(模型后端瞬时错误 -32603 等)最多 3 次；timeout/other 最多 2 次
  const runWithRetry = async (promptText: string, imgs: typeof images): Promise<string> => {
    let n = 0;
    while (true) {
      n++;
      try {
        return await attempt(promptText, imgs);
      } catch (e) {
        const plan = brainFailurePlan(e);
        log(`brain error (try ${n}, ${plan.category}): ${String(e)}`);
        if (n < plan.attemptLimit) {
          sendProgress(
            plan.category === "backend"
              ? "⚠️ 模型后端临时出错，正在重试…"
              : "⏳ 响应中断了，正在自动重试…",
          );
          continue;
        }
        throw e;
      }
    }
  };

  let answer: string;
  let ok = true;
  try {
    answer = await runWithRetry(text, images);
  } catch (e2) {
    ok = false; // 重试也失败 → 只是把错误提示当回复发出去，不算「答成」（交接摘要据此决定留不留）
    answer = brainErrorMessage(e2, getAgent("brain").name);
  } finally {
    clearInterval(keepAlive);
    clearInterval(heartbeat);
  }
  await setTyping(account, to, cx(), 2);
  // 发图：从回复里提取图片引用（markdown ![](url/路径) 或裸图片 URL），逐个作为图片消息发出，再发剩余文本
  const { images: replyImages, text: cleaned } = extractImages(answer || "");
  const failedImgs: string[] = [];
  for (const im of replyImages) {
    try {
      const buf = await resolveImageBytes(im.src);
      await sendImage({
        baseUrl: account.baseUrl,
        token: account.botToken,
        to,
        image: buf,
        contextToken: cx(),
      });
      log(`sent image: ${im.src.slice(0, 80)}`);
    } catch (e) {
      log("send image failed:", im.src, String(e));
      failedImgs.push(im.src);
    }
  }
  let finalText = cleaned;
  if (failedImgs.length) {
    const note = `（有 ${failedImgs.length} 张图片我没能下载下来，附原链接：\n${failedImgs.join("\n")}）`;
    finalText = finalText ? `${finalText}\n\n${note}` : note;
  }
  if (!finalText && !replyImages.length) finalText = "（没有内容）";
  if (finalText) {
    budgetOf(to).count += 1; // 最终答案占一条额度（等待段预留的最后一条）
    log(`final send: msgAge=${msgAge()} sent=${budgetOf(to).count} len=${finalText.length}`);
    const ft = latestToken ? latestToken() : undefined;
    if (finalText.length > LONG_REPLY_THRESHOLD) {
      await sendMdOrdered(account, to, cx(), finalText, ft); // 长回复 → .md 文件（一条消息）
    } else {
      await sendOrdered(account, to, cx(), finalText, MessageState.FINISH, ft);
    }
  }
  log(`replied to ${to} (msgAge=${msgAge()}): ${(answer || "").slice(0, 60)}`);
  activeTurn = null; // 回合结束（计数 budgetOf 不清零，留待用户下条消息重置）
  return ok;
}

// ===== 解耦：拉取器(poller) 与 处理器(worker) 通过队列协作 =====
// 大脑(ACP session)严格串行，但「拉取消息/抓 token」无需串行。把两者解耦：
// poller 持续 getUpdates、实时更新 token、把消息入队，永不被大脑阻塞；worker 串行从队列取消息喂大脑（尊重 kiro-cli 串行约束），发送时取最新 token，规避 ret=-2。
type QueuedMsg = {
  from: string;
  text: string;
  imageItems: ImageItem[];
  createTimeMs?: number;
  contextToken?: string;
};
const msgQueue: QueuedMsg[] = [];
let wakeWorker: (() => void) | null = null;
function notifyWorker(): void {
  const w = wakeWorker;
  wakeWorker = null;
  if (w) w();
}

/** 发件人鉴权：登录者（owner，始终允许）或在登录者白名单 allowFrom 中——兜底校验（微信平台只发送登录者本人的消息，这道闸防的是发送范围变化/别的入口）。 */
function isAuthorized(from: string, owner: string): boolean {
  return !!from && (from === owner || isAllowed(from));
}

async function pollerLoop(account: AccountData, owner: string, state: ServerState): Promise<void> {
  while (true) {
    if (isSessionPaused(account.botId)) {
      await sleep(Math.min(getRemainingPauseMs(account.botId), 60_000) || 60_000);
      continue;
    }
    let resp;
    try {
      resp = await getUpdates({
        baseUrl: account.baseUrl,
        token: account.botToken,
        updatesBuf: state.updatesBuf,
        timeoutMs: 25_000,
      });
    } catch (e) {
      log("getUpdates error:", String(e));
      await sleep(2000);
      continue;
    }
    try {
      if (resp.errcode === SESSION_EXPIRED_ERRCODE) {
        log("session expired (-14); pausing 1h. Send a WeChat message to revive after re-login.");
        pauseSession(account.botId);
        continue;
      }
      if (resp.errcode) {
        log("server error:", resp.errcode, resp.errmsg);
        await sleep(2000);
        continue;
      }
      if (resp.get_updates_buf) state.updatesBuf = resp.get_updates_buf;

      const news = (resp.msgs ?? []).filter(
        (m) =>
          m.message_type === MessageType.USER && m.message_id && m.message_id > state.lastMessageId,
      );
      // 先登记本批所有最新 token（worker 发送时取最新）
      for (const m of news) {
        const f = m.from_user_id ?? "";
        if (isAuthorized(f, owner))
          log(
            `recv msg id=${m.message_id} ctx=…${m.context_token ? m.context_token.slice(-12) : "NONE"} age=${m.create_time_ms ? Math.round((Date.now() - m.create_time_ms) / 1000) + "s" : "?"}`,
          );
        if (m.context_token) {
          state.contextTokens[`${account.botId}:${f}`] = m.context_token;
          freshTokenUsers.add(f); // 本进程拿到的 token——此后该用户的 -2 不再当「旧 token」挂起
        }
      }
      let enq = false;
      for (const msg of news) {
        state.lastMessageId = Math.max(state.lastMessageId, msg.message_id ?? 0);
        const from = msg.from_user_id ?? "";
        if (!isAuthorized(from, owner)) {
          log("ignore unauthorized sender:", from);
          continue;
        }
        const text = extractText(msg);
        const voiceItem = (msg.item_list ?? []).find(
          (it) => it.type === MessageItemType.VOICE,
        )?.voice_item;
        if (voiceItem)
          log(
            `recv voice: text=${voiceItem.text ? `"${voiceItem.text.slice(0, 30)}"` : "(空,无微信转写)"} playtime=${voiceItem.playtime ?? "?"}`,
          );
        const imageItems = (msg.item_list ?? [])
          .filter((it) => it.type === MessageItemType.IMAGE && it.image_item)
          .map((it) => it.image_item as ImageItem);
        if (!text && imageItems.length === 0) {
          log("skip empty/unsupported message");
          continue;
        }
        // 服务端按「距用户上一条消息」计连续发送数 → 任何来自 owner 的消息都重置该用户计数 + 退出等待段。但已经进了 replyChain、会在本条消息之后才上线路的发送（补发、上一回合没发完的）仍占新窗口的额度，所以不能直接清零，而是把它们算进来。
        const b = budgetOf(from);
        const wasAwaiting = b.awaiting;
        b.count = inflightSends.get(from) ?? 0;
        b.awaiting = false;
        // 「继续」且当前回合正处于「等待继续」段：换用本消息新 token 恢复，且仅作恢复信号、不入队
        if (text.trim() === "继续" && activeTurn && activeTurn.from === from && wasAwaiting) {
          activeTurn.token = msg.context_token ?? activeTurn.token;
          log("收到「继续」(等待中) → 恢复进度、重置计数、换新 token");
          continue;
        }
        msgQueue.push({
          from,
          text,
          imageItems,
          createTimeMs: msg.create_time_ms,
          contextToken: msg.context_token,
        });
        enq = true;
      }
      // 新 token 已到 → 补发旧 token 期间挂起的推送。等本批所有消息的计数重置都做完再补发（否则同一批里后一条消息的 reset 会把补发的计数抹掉）；每个发件人一次，用 state 里该用户最新的 token。补发先进 replyChain，排在本批消息触发的进度/答案之前（该循环全程同步，worker 来不及插进来）。
      const flushTo = new Set<string>();
      for (const msg of news) {
        const from = msg.from_user_id ?? "";
        if (!msg.context_token || flushTo.has(from) || !isAuthorized(from, owner)) continue;
        flushTo.add(from);
        const fresh = state.contextTokens[`${account.botId}:${from}`];
        if (fresh) flushHeldPushes(account, from, fresh);
      }
      saveState(state);
      if (enq) notifyWorker();
    } catch (e) {
      log("poller error:", e instanceof Error ? e.stack || e.message : String(e));
    }
  }
}

async function workerLoop(account: AccountData, state: ServerState, owner: string): Promise<void> {
  while (true) {
    if (isSessionPaused(account.botId)) {
      await sleep(Math.min(getRemainingPauseMs(account.botId), 30_000) || 30_000);
      continue;
    }
    if (msgQueue.length === 0) {
      await new Promise<void>((r) => {
        wakeWorker = r;
        if (msgQueue.length > 0) {
          wakeWorker = null;
          r();
        }
      });
      continue;
    }
    const item = msgQueue.shift() as QueuedMsg;
    const from = item.from;
    const token = item.contextToken; // 用这条消息自己带的 context_token 回复（每条消息各有各的 token）
    const latestToken = () => state.contextTokens[`${account.botId}:${from}`]; // 该用户最新缓存 token（仅作 -2 参数错误时的兜底）

    // 控制指令：单独处理
    const ctrl = item.text ? parseControl(item.text) : null;
    if (ctrl) {
      // owner-only（切脑/交接）：非本人 → 短提示拒绝，**不**转发给大脑（否则大脑可能替用户执行越权动作）
      if (isOwnerOnly(ctrl) && from !== owner) {
        const r = "这条指令仅登录者可用。发送「帮助」看你自己的指令。";
        log("control: denied(not owner)", JSON.stringify(ctrl));
        await sendNotice(account, from, token, r, latestToken());
        continue;
      }
      // 补发用**最新**token（切换可能几十秒，期间用户又发过消息；旧 token 可能已失效）
      const notify = (text: string) =>
        sendNotice(account, from, latestToken() ?? token, text, latestToken());
      const notifyFile = (text: string) => {
        budgetOf(from).count += 1; // .md 也是一条消息，占同一份额度
        return sendMdOrdered(account, from, latestToken() ?? token, text, latestToken());
      };
      let r: string;
      try {
        r = await handleControl(ctrl, from, { owner, notify, notifyFile });
      } catch (e) {
        r = "处理指令出错：" + String(e);
      }
      log("control:", JSON.stringify(ctrl), "->", r.replace(/\n/g, " | "));
      await sendNotice(account, from, token, r, latestToken());
      continue;
    }

    // ── 任务路由 ──
    // 1) 结束任务（可带编号/全部）
    const tcmd = item.text ? parseTaskControl(item.text) : null;
    if (tcmd?.kind === "stop") {
      const r = stopTask(from, tcmd.id);
      log("task: stop ->", r.replace(/\n/g, " | "));
      await sendNotice(account, from, token, r, latestToken());
      continue;
    }
    // 2) 任务列表
    if (tcmd?.kind === "tasks") {
      await sendNotice(account, from, token, renderTaskList(from), latestToken());
      continue;
    }
    // 3) 给指定编号的任务回话
    if (tcmd?.kind === "reply") {
      const r = injectTask(from, tcmd.text, tcmd.id);
      log(`task: inject(#${tcmd.id}):`, tcmd.text.slice(0, 40));
      if (r) await sendNotice(account, from, token, r, latestToken());
      continue;
    }
    // 4) 派发：带 agent 名 = 指定 agent 起一条**新任务**（多任务并行）；不带 = 沿用「有任务就发给它，没有就派发」
    if (tcmd?.kind === "toWorker" && tcmd.agentToken) {
      // 指定的 agent **只对这条任务生效**，不改默认任务大脑：那是账号级状态（`切换任务大脑` 是 owner-only），顺手改会让「派一条任务」变成一次隐形的全局设置变更，也破坏微信与 CLI（`--agent` 只影响那一条任务）两边的对称。
      const r = dispatchTask(from, tcmd.text, { agentKey: tcmd.agentToken });
      log(`task: dispatch(agent=${tcmd.agentToken}):`, r.replace(/\n/g, " | "));
      await sendNotice(account, from, token, r, latestToken());
      continue;
    }
    if (tcmd?.kind === "toWorker") {
      // 明确发给 worker：有活跃任务 → 发给它/追加（唯一一条喂下一轮、running 暂存、多条则回编号提示）；
      // 没有活跃任务 → 派发新任务（不「续跑」已中断的：那是「继续」/`#n 继续` 的事，明确派发就该是新的活）。
      if (hasActiveTask(from)) {
        const r = injectTask(from, tcmd.text);
        log("task: inject(explicit):", tcmd.text.slice(0, 40), "->", r.replace(/\n/g, " | "));
        if (r) await sendNotice(account, from, token, r, latestToken());
      } else {
        const r = dispatchTask(from, tcmd.text);
        log("task: dispatch:", r.replace(/\n/g, " | "));
        await sendNotice(account, from, token, r, latestToken());
      }
      continue;
    }
    // 2) 明确「问大脑」逃逸前缀 → 去前缀后强制走 brain（即使 worker 在等你）
    const brainEscape = item.text ? parseBrainEscape(item.text) : null;
    // 3) 无前缀 + worker 正等你回 + 非图片 → 默认发给 worker（唯一一条 waiting 直接喂；多条 waiting 回编号提示）；
    //    其余（running / 无任务 / 逃逸 / 图片）→ brain
    if (!brainEscape && item.imageItems.length === 0 && awaitingTasks(from).length > 0) {
      const r = injectTask(from, item.text);
      log("task: inject(awaiting):", item.text.slice(0, 40), "->", r.replace(/\n/g, " | "));
      if (r) await sendNotice(account, from, token, r, latestToken());
      continue;
    }
    // 已中断的任务（daemon 重启留下的）：没有活跃任务时**只有「继续」这类短句**才放行进任务表续跑。
    // 为什么还要关键字这层闸：一条陈旧的中断任务会一直躺在表里，若见了消息就放行，「帮我查一下 X」这类日常提问会被它吞掉。
    if (
      !brainEscape &&
      item.imageItems.length === 0 &&
      !hasActiveTask(from) &&
      interruptedTasks(from).length > 0 &&
      looksLikeResume(item.text)
    ) {
      const r = injectTask(from, item.text);
      log("task: resume(interrupted):", item.text.slice(0, 40), "->", r.replace(/\n/g, " | "));
      if (r) await sendNotice(account, from, token, r, latestToken());
      continue;
    }

    const brainText = brainEscape ?? item.text;
    // 交接注入：切换大脑后，发给**新**大脑的第一条消息带上前一个大脑留下的摘要（切回来源大脑、别人、
    // 过期都不带上，规则见 handoff.ts）。作为前缀带上 = 不额外占一个回合、不多一次模型调用。
    // 切换进行中时按**目标**大脑判断（这条消息会在门口等新大脑就绪，实际答话的是它）。
    const pending = loadHandoff(DATA_DIR);
    const goal = switchInFlightTarget() ?? getAgent("brain").name;
    const htext = takeHandoffFor(pending, goal, from);
    const withHandoff =
      pending && htext ? handoffPrefix(pending.fromAgent, htext) + brainText : brainText;
    if (htext) log(`handoff injected from=${pending?.fromAgent} to=${goal} chars=${htext.length}`);
    try {
      const answered = await handleMessage(
        account,
        token,
        from,
        withHandoff,
        item.imageItems,
        item.createTimeMs,
        latestToken,
      );
      // 答成才消费：失败/被图片挡下就留着，下次还能用。
      // 切回来答话（回滚到来源大脑，或切换目标就是它）也不消费——那是它自己写的摘要，留着下次切走时用。
      const answeredBy = getAgent("brain").name;
      if (htext && answered && answeredBy !== pending?.fromAgent && clearHandoff(DATA_DIR))
        log(`handoff consumed by ${answeredBy}`);
    } catch (e) {
      log("handleMessage error:", e instanceof Error ? e.stack || e.message : String(e));
      await sendNotice(
        account,
        from,
        token,
        "处理这条消息时出错了，请再发一次试试。",
        latestToken(),
      );
    }
  }
}

// ===== 本地命令入口（文件桥）：CLI 写 task-inbox/*.json，daemon 扫描分发到 task-manager，结果写回 task-out/*.json =====
const TASK_INBOX_DIR = taskInboxDir(DATA_DIR);
const TASK_STATE_FILE = path.join(DATA_DIR, "task-state.json");
const TASK_SCAN_MS = Number(process.env.WEMIND_TASK_SCAN_MS) || 1000;

/** 扫描 task-inbox：按文件名(时间戳)升序逐个读、分发到 task-manager（dispatch/reply/stop）、删文件。本地命令默认作用于 owner。 */
function scanTaskInbox(owner: string): void {
  let files: string[];
  try {
    files = fs.readdirSync(TASK_INBOX_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  } // 目录不存在/读失败：跳过
  if (!files.length) return;
  files.sort(); // 文件名带时间戳前缀，字典序即时间序
  for (const f of files) {
    const fp = path.join(TASK_INBOX_DIR, f);
    let cmd: {
      kind?: string;
      text?: string;
      cwd?: string;
      agent?: string;
      id?: number | string;
      ack?: string;
    };
    try {
      cmd = JSON.parse(fs.readFileSync(fp, "utf-8"));
    } catch {
      try {
        fs.unlinkSync(fp);
      } catch {
        /* ignore */
      }
      continue;
    } // 坏文件丢弃
    try {
      fs.unlinkSync(fp);
    } catch {
      /* ignore */
    } // 先删，避免重复处理
    try {
      if (cmd.kind === "dispatch") {
        // 答复由 task-manager 在**起进程有结果之后**发（达上限/起不来都是那时才知道），这里只把 ack id 递进去
        log(
          "local task dispatch:",
          dispatchTask(owner, String(cmd.text ?? ""), {
            ...(cmd.cwd ? { cwd: String(cmd.cwd) } : {}),
            ...(cmd.agent ? { agentKey: String(cmd.agent) } : {}),
            ...(cmd.ack ? { ackId: String(cmd.ack) } : {}),
          }).slice(0, 60),
        );
      } else if (cmd.kind === "reply") {
        const id = Number(cmd.id) > 0 ? Number(cmd.id) : undefined;
        const ackId = cmd.ack === undefined ? undefined : String(cmd.ack);
        const r = injectTask(owner, String(cmd.text ?? ""), id, ackId);
        log(
          "local task reply:",
          id ? `#${id}` : "-",
          String(cmd.text ?? "").slice(0, 40),
          r.slice(0, 40),
        );
      } else if (cmd.kind === "stop") {
        log(
          "local task stop:",
          stopTask(
            owner,
            cmd.id === "all" ? "all" : Number(cmd.id) > 0 ? Number(cmd.id) : undefined,
            cmd.ack === undefined ? undefined : String(cmd.ack),
          ),
        );
      } else {
        log("unknown task-inbox cmd:", cmd.kind);
        writeTaskAck(
          DATA_DIR,
          cmd.ack === undefined ? undefined : String(cmd.ack),
          `❌ 不认识的任务命令：${cmd.kind}`,
        );
      }
    } catch (e) {
      log("task-inbox dispatch error:", String(e));
      writeTaskAck(
        DATA_DIR,
        cmd.ack === undefined ? undefined : String(cmd.ack),
        `❌ 命令执行出错：${String(e)}`,
      );
    }
  }
}

/**
 * 执行一条 CLI 桥请求，返回要打印给用户的那句话。
 * 与微信指令**共用同一批实现函数**（switchBrain / session-manager / task-manager），
 * 所以「CLI 与微信行为一致」不是靠约定，而是同一段代码。
 * 这里的 `owner` 就是登录者：本地命令没有「谁发的」的概念，一律作用于本人。
 */
async function handleControlRequest(req: ControlRequest, owner: string): Promise<string> {
  const sc = (): SessionCtx => ({ agent: getAgent("brain").name, userId: owner, dir: DATA_DIR });
  switch (req.kind) {
    case "brain.switch": {
      if (!req.target) return "❌ 用法：brain switch <agent 名|auto>";
      const pre = preflightSwitch(req.target, DATA_DIR);
      if (!pre.ok) return `❌ ${pre.problem}`;
      // 注意：这里**不用** ack/补发两段（那是微信侧的写法）。CLI 在等应答，直接等完整结果更实在。
      const out = await switchBrain(req.target, { userId: owner, dir: DATA_DIR });
      return out.ok ? out.notice : `❌ ${out.problem}`;
    }
    case "brain.worker":
      if (!req.target)
        return `当前默认任务大脑：${agentLine(getAgent("worker"))}。切换用 \`wemind brain switch <agent 名> --worker\`。`;
      return setTaskBrain(req.target);
    case "brain.handoff":
      return await runHandoff(owner, { owner, notify: async () => {} });
    case "session.new":
      return await newSessionCmd({ ...sc(), name: req.name, create: newSession });
    case "session.list":
      return sessionsCmd({ ...sc(), page: req.page });
    case "session.resume":
      if (!req.ref) return "❌ 用法：session resume <序号|名字|id前缀>";
      return await resumeSessionCmd({ ...sc(), resume: resumeSession }, req.ref);
    case "session.rename":
      if (!req.ref || !req.name) return "❌ 用法：session rename <序号|名字> <新名字>";
      return renameSessionCmd(sc(), req.ref, req.name);
    case "session.delete":
      if (!req.ref) return "❌ 用法：session delete <序号|名字|id前缀>";
      return deleteSessionCmd(sc(), req.ref);
    case "task.list":
      return renderTaskList(owner);
    case "task.reply": {
      if (!req.text) return '❌ 用法：task-reply [#编号] "内容"';
      const r = injectTask(
        owner,
        req.text,
        typeof req.taskId === "number" ? req.taskId : undefined,
      );
      return r || "已把这句话发给任务（它继续跑，结果会发到微信）。";
    }
    case "task.stop":
      return stopTask(owner, req.taskId);
  }
}

// ===== 控制桥（CLI ↔ daemon）：CLI 写 control-inbox，这里执行 + 写 control-out =====
let controlBusy = false; // 同时只处理一条：切换/会话恢复本来就要串行（它们争的是同一个 ACP 连接）

/** 扫描控制桥收件箱。异步：brain.switch 要等启动新大脑（最长 ~2 分钟），期间不能再处理下一条。 */
async function scanControlInbox(owner: string): Promise<void> {
  if (controlBusy) return;
  const items = readControlInbox(DATA_DIR);
  if (!items.length) return;
  controlBusy = true;
  try {
    for (const { file, req } of items) {
      try {
        fs.unlinkSync(path.join(controlInboxDir(DATA_DIR), file));
      } catch {
        /* ignore */
      } // 先删，避免重复处理
      if (!req) {
        log("control: 非法请求（未知 kind / 坏 JSON），已丢弃:", file);
        continue;
      }
      log("control(cli):", req.kind, JSON.stringify({ target: req.target, ref: req.ref }));
      let text: string;
      try {
        text = await handleControlRequest(req, owner);
      } catch (e) {
        text = `❌ 处理出错：${String(e)}`;
      }
      // 约定：❌ 开头即失败（CLI 据此定退出码）。应答一定写——不写的话 CLI 会白等到超时。
      writeControlResponse(
        { id: req.id, at: Date.now(), ok: !text.startsWith("❌"), text },
        DATA_DIR,
      );
    }
  } finally {
    controlBusy = false;
  }
}

export async function runDaemon(): Promise<void> {
  // 启动即校验大脑：早失败、说人话——避免「进程看着正常、直到第一条消息才炸」（历史上表现为反复「⏳ 响应中断了，正在自动重试…」，实为默认大脑的二进制没装）。
  // 先种槽位再校验：此后运行期一律从槽位取 agent（热切换会更新它，见 agent-slot.ts），启动期与运行期同一个来源。
  seedSlots(loadBrainConfig());
  const agent = getAgent("brain");
  const brainProblem = agentProblem(agent);
  if (brainProblem) {
    log(`FATAL 大脑不可用：${brainProblem}`);
    process.exit(BRAIN_CONFIG_EXIT_CODE); // 后台守护进程据此停止自动重启（配置错误重拉无益）
  }
  log(
    `brain=${agent.name} bin=${agent.bin} args=[${agent.args.join(" ")}] shell=${agent.shell} (source: ${agent.source})`,
  );
  // 运行时身份：list 在 daemon 活着时据此显示「实际生效的大脑」（brain.pid 要等 ACP 懒启动才有）
  writeBrainState(DATA_DIR, agent);
  const wagent = getAgent("worker");
  if (wagent.name !== agent.name)
    log(
      `worker=${wagent.name} bin=${wagent.bin} args=[${wagent.args.join(" ")}] (source: ${wagent.source})`,
    );
  // 任务大脑不可用只警告、不退出：只聊天的用户不受影响，但派发任务会失败——早说清楚比任务静默失败好。
  const workerProblem = agentProblem(wagent);
  if (workerProblem) log(`WARN 任务大脑不可用（派发任务会失败）：${workerProblem}`);
  const account = loadAccount();
  if (!account?.botToken) {
    log("not logged in; run the MCP login_qrcode flow first.");
    process.exit(1);
  }
  const owner = process.env.WECHAT_OWNER_ID?.trim() || account.userId; // 登录者：始终授权（兜底校验）
  if (owner) addAllowFrom(owner, DATA_DIR); // 种入登录者白名单(自动迁移老账号)；新登录在 finalize 已配对
  // 写 PID 文件，供管理命令（logout/delete）精确定位并停止本账号的 daemon
  const pidFile = path.join(DATA_DIR, "daemon.pid");
  try {
    fs.writeFileSync(pidFile, String(process.pid), "utf-8");
  } catch {
    /* best-effort */
  }
  const cleanupPid = () => {
    try {
      fs.unlinkSync(pidFile);
    } catch {
      /* ignore */
    }
  };
  // 退出时连带收掉池里的全部 worker：Windows 上子进程不会随父进程退出，漏掉就是一堆孤儿 agent 进程。
  // （任务表不在这里改状态：下次启动统一标「已中断」——那才是它真实的处境。）
  const cleanupAll = () => {
    cleanupPid();
    killWorkerPool();
  };
  process.on("exit", cleanupAll);
  process.on("SIGINT", () => {
    cleanupAll();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanupAll();
    process.exit(0);
  });
  // 防御：任何未捕获的 promise 拒绝/异常（多为瞬时网络 fetch failed 或回合内 send 被拒）只记录、不退出，避免 daemon 崩溃丢掉在途回合、用户卡在心跳。此前的 code=1 崩溃即源于此类未捕获拒绝。
  process.on("unhandledRejection", (reason) => {
    log(
      "unhandledRejection:",
      reason instanceof Error ? reason.stack || reason.message : String(reason),
    );
  });
  process.on("uncaughtException", (err) => {
    log("uncaughtException:", err?.stack || String(err));
  });
  ensureBrainHome(); // 准备 brain 沙箱（默认空 MCP）
  ensureWorkerHome(); // 准备 worker 沙箱（继承全量 MCP 除 wechat + 记忆/技能/settings）
  log(`up. bot=${account.botId} owner=${owner} allowFrom=${readAllowFrom(DATA_DIR).length}`);
  await notifyStart({ baseUrl: account.baseUrl, token: account.botToken }).catch(() => {});

  const state: ServerState = loadState();
  // worker 任务推送：用该用户最新 token 经串行发送层发出（与 brain 共用 sendOrdered，保证不乱序）
  setTaskPush((to, text) => {
    const tok = state.contextTokens[`${account.botId}:${to}`];
    // task 推送也占用连续发送额度（与 brain 回合共用 budgetOf）：task 在后台运行，可能与 brain 回合并发，若不计数，本地 budget 会低估服务端真实连续发送数 → brain 的 sendProgress 误判「还能发」→ 撞 ret=-2 限流、结果丢失。
    // 注：task 推送是「本轮结果」（必须送达），故只累加计数、不被 awaiting 暂停（暂停只作用于可丢弃的 brain 进度提示）。
    budgetOf(to).count += 1;
    void sendOrdered(account, to, tok, text, MessageState.FINISH, tok, (e) =>
      holdUndelivered(to, text, e),
    );
  });
  // worker 跑一轮期间持续「正在输入中」（typing 不占连续发送上限），避免长任务静默让用户以为卡了
  setTaskTyping((to) => {
    void setTyping(account, to, state.contextTokens[`${account.botId}:${to}`], 1);
  });
  // 任务状态写入磁盘：worker 状态记录原子写 task-state.json，供本地 `manage.js task-status` 读
  setTaskStateSink((snap: TaskStateSnapshot) => {
    try {
      const tmp = `${TASK_STATE_FILE}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), "utf-8");
      fs.renameSync(tmp, TASK_STATE_FILE);
    } catch {
      /* best-effort */
    }
  });
  setTaskAckSink((id, text) => writeTaskAck(DATA_DIR, id, text)); // 本地命令的回结果通道（`wemind task` 等着的「到底派上了没有」）
  // 本地命令入口：启动清空收件箱与答复目录（作废重启前残留命令、防重放），再起独立定时器扫描分发（不挂 poller，避免被 25s 长轮询阻塞）
  clearTaskDirs(DATA_DIR);
  setInterval(() => scanTaskInbox(owner), TASK_SCAN_MS);
  // 控制桥：同样「启动清空 + 独立定时器扫描」（作废重启前的残留命令，防重放）
  clearControlDirs(DATA_DIR);
  markBridgeReady(DATA_DIR, process.pid); // 凭据：CLI 据此判断「在跑的这个 daemon 认不认识控制桥」
  setInterval(() => void scanControlInbox(owner), TASK_SCAN_MS);
  // 任务表：读回上次的（未完成的标「已中断」，不自动恢复）；编号接着排
  const restored = initTasks(DATA_DIR);
  if (restored.interrupted.length)
    log(`restored tasks: interrupted=[${restored.interrupted.join(",")}]（回「继续」可续跑）`);
  // 会话登记表：把当前会话表里有、登记表里还没有的旧会话补进去（功能上线前的老账号，一次性、幂等）
  const backfilled = syncFromPointerMap(DATA_DIR);
  if (backfilled) log(`session registry backfilled: ${backfilled} 条（来自当前会话表）`);
  // 进程池清扫：空闲超时的 worker 回收（默认 5 分钟）
  const poolSweep = setInterval(() => sweepWorkerPool(), 30_000);
  poolSweep.unref?.();
  // 解耦运行：拉取器持续抓消息(永不被大脑阻塞)，处理器串行喂大脑
  void pollerLoop(account, owner, state);
  await workerLoop(account, state, owner);
}

// daemon 本体由 cli.ts 的 `wemind daemon` 调用 runDaemon() 启动，此处不再顶层自启。
