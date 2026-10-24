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
import { askBrain, newSession, restart, supportsImages, heartbeatMs } from "./acp-brain.js";
import { resolveAgent, agentProblem, BRAIN_CONFIG_EXIT_CODE } from "./brain-agents.js";
import { loadBrainConfig } from "./brain-config.js";
import { ensureBrainHome, addMcp, removeMcp, listMcp } from "./mcp-sandbox.js";
import { extractImages, resolveImageBytes } from "./image-reply.js";
import { LONG_REPLY_THRESHOLD, buildMdReply } from "./md-reply.js";
import {
  dispatchTask,
  injectTask,
  stopTask,
  hasActiveTask,
  isAwaiting,
  setTaskPush,
  setTaskTyping,
  setTaskStateSink,
  type TaskStateSnapshot,
} from "./task-manager.js";
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
/** 按错误类型给用户的失败提示。 */
function brainErrorMessage(e: unknown): string {
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

type Ctrl =
  | { kind: "list" }
  | { kind: "new" }
  | { kind: "add"; name: string }
  | { kind: "remove"; name: string };

/** 解析控制指令（命中则由 daemon 直接处理，不转发给 brain）。 */
export function parseControl(text: string): Ctrl | null {
  const t = text.trim();
  if (/^(\/?mcp|列出\s*mcp|mcp\s*list)$/i.test(t)) return { kind: "list" };
  if (/^(新会话|重置|清空上下文|\/new|new\s*session)$/i.test(t)) return { kind: "new" };
  let m = t.match(/^(?:加载|load)\s+(\S+)$/i);
  if (m) return { kind: "add", name: m[1] };
  m = t.match(/^(?:卸载|unload)\s+(\S+)$/i);
  if (m) return { kind: "remove", name: m[1] };
  return null;
}

type TaskCmd = { kind: "toWorker"; text: string } | { kind: "stop" };
/** 解析「明确发给 worker」指令：任务：xxx / 任务 xxx / >xxx（toWorker：无任务则启动、有任务则注入）；结束任务/停止任务 → stop。 */
export function parseTaskControl(text: string): TaskCmd | null {
  const t = text.trim();
  if (/^(结束任务|停止任务|\/stop)$/i.test(t)) return { kind: "stop" };
  let m = t.match(/^(?:任务|task)[:：]\s*([\s\S]+)$/i);
  if (m) return { kind: "toWorker", text: m[1].trim() };
  m = t.match(/^>\s*([\s\S]+)$/); // 快捷别名：> 开头即明确发给 worker
  if (m) return { kind: "toWorker", text: m[1].trim() };
  return null;
}

/** 解析「明确问大脑」逃逸前缀：问大脑 xxx / 问大脑：xxx。命中返回去前缀后的文本（强制走 brain，即使 worker 在等你）。 */
export function parseBrainEscape(text: string): string | null {
  const m = text.trim().match(/^问大脑[:：]?\s*([\s\S]+)$/);
  return m ? m[1].trim() : null;
}

async function handleControl(c: Ctrl, userId: string): Promise<string> {
  if (c.kind === "list") return listMcp();
  if (c.kind === "new") {
    await newSession(userId);
    return "已开启新会话（上下文已清空）。";
  }
  if (c.kind === "add") {
    const r = addMcp(c.name);
    restart(); // 重启 acp 进程，使其按新沙箱 mcp.json 重新加载
    return r;
  }
  const r = removeMcp(c.name);
  restart();
  return r;
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
// 两条发送之间的最小间隔：iLink 对 bot 发送有速率限流（rapid sends → ret=-2 "rate limited"，导致消息丢失，
// 见 NousResearch/hermes-agent#21011）。全局节流主动规避。
const MIN_SEND_GAP_MS = Number(process.env.WECHAT_MIN_SEND_GAP_MS) || 1500;

// iLink 在用户回复前能连续发送的消息数上限（实测约 10，可调）。
const CONSEC_SEND_LIMIT = Number(process.env.WECHAT_CONSEC_SEND_LIMIT) || 10;
// 静默期心跳：默认 15s；预设可放宽（如 DSH committed-only，但仍会发 thought/usage 帧）。
const HEARTBEAT_MS = Number(process.env.WECHAT_BRAIN_HEARTBEAT_MS) || heartbeatMs() || 15_000;
// 「距该用户上一条消息以来」bot 已连续发送的条数 + 是否处于"等待继续"段。按用户(to)维护、**跨回合持续**，
// 仅在该用户发来任何消息时重置（镜像服务端"任何用户消息都重置连续发送配额"的规则）。
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
// 当前进行中回合（worker 串行，只有一个）：记录发往用户与所用 token（token 可被「继续」更新）。
let activeTurn: { from: string; token: string | undefined } | null = null;
function sendOrdered(
  account: AccountData,
  to: string,
  ctx: string | undefined,
  text: string,
  state: number = MessageState.FINISH,
  fallbackToken?: string,
): Promise<void> {
  replyChain = replyChain.then(async () => {
    const wait = MIN_SEND_GAP_MS - (Date.now() - lastSendAt);
    if (wait > 0) await sleep(wait);
    await reply(account, to, ctx, text, state, fallbackToken).catch((e) =>
      handleSendError(e, account),
    );
    lastSendAt = Date.now();
  });
  return replyChain;
}

/** 把长回复作为 .md 文件发送（走同一串行链+节流）；发文件失败则兜底回退为文本。 */
function sendMdOrdered(
  account: AccountData,
  to: string,
  ctx: string | undefined,
  finalText: string,
  fallbackToken?: string,
): Promise<void> {
  replyChain = replyChain.then(async () => {
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
  });
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

async function handleMessage(
  account: AccountData,
  ctx: string | undefined,
  to: string,
  text: string,
  imageItems: ImageItem[],
  createTimeMs?: number,
  latestToken?: () => string | undefined,
): Promise<void> {
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
  // iLink 限制 bot 在用户回复前连续发送的消息数（实测约 10，超出被 ret=-2 拒）。计数按用户跨回合维护(budgetOf)。
  // 当已发到「上限-2」(默认第8条)后，下一条进度改为「即将达上限」提示并进入等待，把最后一条额度留给最终答案；
  // 用户回复「继续」(或发任何消息)会重置计数恢复发送（见 poller）。
  const sendProgress = (msg: string) => {
    lastProgressAt = Date.now();
    const b = budgetOf(to);
    if (b.awaiting) return; // 等待「继续」期间不发任何进度
    // 发出一条文本会把客户端刚显示的「正在输入」顶掉 → 消息送达后立刻补发一次 typing，
    // 否则快回合（回复 < 旧 8s 续发间隔）全程看不到指示。
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
  // 即时回执：收到即给一条友好提示，保证用户看到的第一条文本不是 15s 兜底心跳。
  // （有图片时，下面的"🖼️ 收到 N 张图片…"已充当即时回执，不再重复发）
  if (imageItems.length === 0) {
    const t = cx();
    log(`turn start to=${to} msgAge=${msgAge()} usingCtx=…${t ? t.slice(-12) : "NONE"}`);
    sendProgress("🤖 收到，正在处理…");
  }
  // 心跳：仅当 brain 真正静默(无任何帧)超过 HEARTBEAT_MS 才提示——首条用友好措辞，后续才带计时
  let hbCount = 0;
  let answerNoticeSent = false; // "正在整理回复"只发一次
  const heartbeat = setInterval(() => {
    if (Date.now() - lastProgressAt >= HEARTBEAT_MS) {
      hbCount += 1;
      sendProgress(
        hbCount === 1
          ? "🤔 还在思考/检索中…"
          : `⏳ 仍在处理中…（已 ${Math.round((Date.now() - t0) / 1000)} 秒）`,
      );
    }
  }, HEARTBEAT_MS);

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
    return;
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

  // 带分类的重试：backend(模型后端瞬时错误 -32603 等)最多 3 次；timeout/other 最多 2 次
  const runWithRetry = async (promptText: string, imgs: typeof images): Promise<string> => {
    let n = 0;
    while (true) {
      n++;
      try {
        return await attempt(promptText, imgs);
      } catch (e) {
        const cat = classifyBrainError(e);
        log(`brain error (try ${n}, ${cat}): ${String(e)}`);
        const maxAttempts = cat === "backend" ? 3 : 2;
        if (n < maxAttempts) {
          sendProgress(
            cat === "backend" ? "⚠️ 模型后端临时出错，正在重试…" : "⏳ 响应中断了，正在自动重试…",
          );
          continue;
        }
        throw e;
      }
    }
  };

  let answer: string;
  try {
    answer = await runWithRetry(text, images);
  } catch (e2) {
    answer = brainErrorMessage(e2);
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
}

// ===== 解耦：拉取器(poller) 与 处理器(worker) 通过队列协作 =====
// 大脑(ACP session)严格串行，但「拉取消息/抓 token」无需串行。把两者解耦：
// poller 持续 getUpdates、实时更新 token、把消息入队，永不被大脑阻塞；
// worker 串行从队列取消息喂大脑（尊重 kiro-cli 串行约束），发送时取最新 token，规避 ret=-2。
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

/** 发件人鉴权：账号本人(owner，始终允许，作安全兜底) 或 在 allowFrom 授权清单中。 */
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
        if (m.context_token) state.contextTokens[`${account.botId}:${f}`] = m.context_token;
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
        // 服务端按「距用户上一条消息」计连续发送数 → 任何来自 owner 的消息都重置服务端配额，故同步重置该用户计数 + 退出等待段。
        const b = budgetOf(from);
        const wasAwaiting = b.awaiting;
        b.count = 0;
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
      saveState(state);
      if (enq) notifyWorker();
    } catch (e) {
      log("poller error:", e instanceof Error ? e.stack || e.message : String(e));
    }
  }
}

async function workerLoop(account: AccountData, state: ServerState): Promise<void> {
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
      let r: string;
      try {
        r = await handleControl(ctrl, from);
      } catch (e) {
        r = "处理指令出错：" + String(e);
      }
      log("control:", JSON.stringify(ctrl), "->", r.replace(/\n/g, " | "));
      await reply(account, from, token, r, MessageState.FINISH, latestToken()).catch((e) =>
        handleSendError(e, account),
      );
      continue;
    }

    // ── 任务路由 ──
    // 1) 结束任务 / 明确发给 worker（任务：、>）
    const tcmd = item.text ? parseTaskControl(item.text) : null;
    if (tcmd?.kind === "stop") {
      const r = stopTask(from);
      log("task: stop ->", r);
      await reply(account, from, token, r, MessageState.FINISH, latestToken()).catch((e) =>
        handleSendError(e, account),
      );
      continue;
    }
    if (tcmd?.kind === "toWorker") {
      // 明确发给 worker：无活跃任务 → 启动；有 → 注入/追加（running 暂存、waiting 喂下一轮）
      if (hasActiveTask(from)) {
        log("task: inject(explicit):", tcmd.text.slice(0, 40));
        injectTask(from, tcmd.text);
      } else {
        const r = dispatchTask(from, tcmd.text);
        await reply(account, from, token, r, MessageState.FINISH, latestToken()).catch((e) =>
          handleSendError(e, account),
        );
      }
      continue;
    }
    // 2) 明确「问大脑」逃逸前缀 → 去前缀后强制走 brain（即使 worker 在等你）
    const brainEscape = item.text ? parseBrainEscape(item.text) : null;
    // 3) 无前缀 + worker 正等你回 + 非图片 → 默认注入 worker；其余（running / 无任务 / 逃逸 / 图片）→ brain
    if (!brainEscape && item.imageItems.length === 0 && isAwaiting(from)) {
      log("task: inject(awaiting):", item.text.slice(0, 40));
      injectTask(from, item.text);
      continue;
    }

    const brainText = brainEscape ?? item.text;
    try {
      await handleMessage(
        account,
        token,
        from,
        brainText,
        item.imageItems,
        item.createTimeMs,
        latestToken,
      );
    } catch (e) {
      log("handleMessage error:", e instanceof Error ? e.stack || e.message : String(e));
      await reply(
        account,
        from,
        token,
        "处理这条消息时出错了，请再发一次试试。",
        MessageState.FINISH,
        latestToken(),
      ).catch((e2) => handleSendError(e2, account));
    }
  }
}

// ===== 本地命令入口（文件桥）：CLI 写 task-inbox/*.json，daemon 扫描分发到 task-manager =====
const TASK_INBOX_DIR = path.join(DATA_DIR, "task-inbox");
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
    let cmd: { kind?: string; text?: string; cwd?: string };
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
        log(
          "local task dispatch:",
          dispatchTask(owner, String(cmd.text ?? ""), cmd.cwd ? String(cmd.cwd) : undefined).slice(
            0,
            50,
          ),
        );
      } else if (cmd.kind === "reply") {
        injectTask(owner, String(cmd.text ?? ""));
        log("local task reply:", String(cmd.text ?? "").slice(0, 40));
      } else if (cmd.kind === "stop") {
        log("local task stop:", stopTask(owner));
      } else {
        log("unknown task-inbox cmd:", cmd.kind);
      }
    } catch (e) {
      log("task-inbox dispatch error:", String(e));
    }
  }
}

export async function runDaemon(): Promise<void> {
  // 启动即校验大脑：早失败、说人话——避免「进程看着正常、直到第一条消息才炸」
  // （历史上表现为反复「⏳ 响应中断了，正在自动重试…」，实为默认大脑的二进制没装）。
  const agent = resolveAgent(loadBrainConfig());
  const brainProblem = agentProblem(agent);
  if (brainProblem) {
    log(`FATAL 大脑不可用：${brainProblem}`);
    process.exit(BRAIN_CONFIG_EXIT_CODE); // 看门狗据此停止自动重启（配置错误重拉无益）
  }
  log(
    `brain=${agent.name} bin=${agent.bin} args=[${agent.args.join(" ")}] shell=${agent.shell} (source: ${agent.source})`,
  );
  const account = loadAccount();
  if (!account?.botToken) {
    log("not logged in; run the MCP login_qrcode flow first.");
    process.exit(1);
  }
  const owner = process.env.WECHAT_OWNER_ID?.trim() || account.userId; // 账号本人：始终授权（安全兜底）
  if (owner) addAllowFrom(owner, DATA_DIR); // 种入授权清单(自动迁移老账号)；新登录在 finalize 已配对
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
  process.on("exit", cleanupPid);
  process.on("SIGINT", () => {
    cleanupPid();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanupPid();
    process.exit(0);
  });
  // 防御：任何未捕获的 promise 拒绝/异常（多为瞬时网络 fetch failed 或回合内 send 被拒）只记录、不退出，
  // 避免 daemon 崩溃丢掉在途回合、用户卡在心跳。此前的 code=1 崩溃即源于此类未捕获拒绝。
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
    // task 推送也占用连续发送额度（与 brain 回合共用 budgetOf）：task 在后台运行，可能与 brain 回合并发，
    // 若不计数，本地 budget 会低估服务端真实连续发送数 → brain 的 sendProgress 误判「还能发」→ 撞 ret=-2 限流、结果丢失。
    // 注：task 推送是「本轮结果」（必须送达），故只累加计数、不被 awaiting 暂停（暂停只作用于可丢弃的 brain 进度提示）。
    budgetOf(to).count += 1;
    void sendOrdered(account, to, tok, text, MessageState.FINISH, tok);
  });
  // worker 跑一轮期间持续「正在输入中」（typing 不占连续发送上限），避免长任务静默让用户以为卡了
  setTaskTyping((to) => {
    void setTyping(account, to, state.contextTokens[`${account.botId}:${to}`], 1);
  });
  // 任务状态落盘：worker 状态快照原子写 task-state.json，供本地 `manage.js task-status` 读
  setTaskStateSink((snap: TaskStateSnapshot) => {
    try {
      const tmp = `${TASK_STATE_FILE}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), "utf-8");
      fs.renameSync(tmp, TASK_STATE_FILE);
    } catch {
      /* best-effort */
    }
  });
  // 本地命令入口：启动清空收件箱（作废重启前残留命令、防重放），再起独立定时器扫描分发（不挂 poller，避免被 25s 长轮询阻塞）
  try {
    fs.rmSync(TASK_INBOX_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    fs.mkdirSync(TASK_INBOX_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  setInterval(() => scanTaskInbox(owner), TASK_SCAN_MS);
  // 解耦运行：拉取器持续抓消息(永不被大脑阻塞)，处理器串行喂大脑
  void pollerLoop(account, owner, state);
  await workerLoop(account, state);
}

// daemon 本体由 cli.ts 的 `wemind daemon` 调用 runDaemon() 启动，此处不再顶层自启。
