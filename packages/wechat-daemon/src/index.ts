#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  getUpdates, sendMessage, sendTyping, getConfig, notifyStart, generateId,
  SESSION_EXPIRED_ERRCODE, isSessionPaused, pauseSession, getRemainingPauseMs,
  loadAccount, loadState, saveState, DATA_DIR,
  MessageItemType, MessageState, MessageType,
  downloadImage, sendImage,
} from "@wemind/wechat-ilink-core";
import type { AccountData, ServerState, WeixinMessage, SendMessageReq, ImageItem } from "@wemind/wechat-ilink-core";
import { askBrain, newSession, restart } from "./acp-brain.js";
import { ensureBrainHome, addMcp, removeMcp, listMcp } from "./mcp-sandbox.js";
import { extractImages, resolveImageBytes } from "./image-reply.js";

const log = (...a: unknown[]) => console.error("[daemon]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function extractText(msg: WeixinMessage): string {
  return (msg.item_list ?? [])
    .filter((it) => it.type === MessageItemType.TEXT)
    .map((it) => it.text_item?.text ?? "")
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
    case "read": return "📄";
    case "search": return "🔍";
    case "execute": return "⌨️";
    case "fetch": return "🌐";
    case "edit":
    case "write": return "✏️";
    case "delete": return "🗑️";
    default: return "🔧";
  }
}

type Ctrl = { kind: "list" } | { kind: "new" } | { kind: "add"; name: string } | { kind: "remove"; name: string };

/** 解析控制指令（命中则由 daemon 直接处理，不转发给 brain）。 */
function parseControl(text: string): Ctrl | null {
  const t = text.trim();
  if (/^(\/?mcp|列出\s*mcp|mcp\s*list)$/i.test(t)) return { kind: "list" };
  if (/^(新会话|重置|清空上下文|\/new|new\s*session)$/i.test(t)) return { kind: "new" };
  let m = t.match(/^(?:加载|load)\s+(\S+)$/i);
  if (m) return { kind: "add", name: m[1] };
  m = t.match(/^(?:卸载|unload)\s+(\S+)$/i);
  if (m) return { kind: "remove", name: m[1] };
  return null;
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
  account: AccountData, to: string, ctx: string | undefined, status: 1 | 2,
): Promise<void> {
  if (!ctx) return;
  try {
    const cfg = await getConfig({
      baseUrl: account.baseUrl, token: account.botToken, ilinkUserId: to, contextToken: ctx,
    });
    await sendTyping({
      baseUrl: account.baseUrl, token: account.botToken,
      body: { ilink_user_id: to, typing_ticket: cfg.typing_ticket, status },
    });
  } catch { /* best-effort */ }
}

async function reply(account: AccountData, to: string, ctx: string | undefined, text: string): Promise<void> {
  const req: SendMessageReq = {
    msg: {
      from_user_id: "", to_user_id: to, client_id: generateId("daemon"),
      message_type: MessageType.BOT, message_state: MessageState.FINISH,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
      context_token: ctx,
    },
  };
  await sendMessage({ baseUrl: account.baseUrl, token: account.botToken, body: req });
}

// 串行发送队列：保证多条消息（进度/答案）按入队顺序送达，不并发乱序
let replyChain: Promise<void> = Promise.resolve();
function sendOrdered(account: AccountData, to: string, ctx: string | undefined, text: string): Promise<void> {
  replyChain = replyChain.then(() => reply(account, to, ctx, text).catch((e) => log("send error:", String(e))));
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

async function handleMessage(account: AccountData, ctx: string | undefined, latestCtx: () => string | undefined, to: string, text: string, imageItems: ImageItem[]): Promise<void> {
  // 始终用该用户「最新」context_token 发送：长回合中旧 token 会被顶替/失效，
  // 若进度/心跳/出错通知仍用回合开始的旧 token，会全部 ret=-2 被拒，用户那头全程静默、像卡住。
  const cx = () => latestCtx() ?? ctx;
  await setTyping(account, to, cx(), 1);
  // 处理期间每 8s 续发"正在输入"，避免长任务时指示消失、用户以为卡了
  const keepAlive = setInterval(() => { void setTyping(account, to, cx(), 1).catch(() => {}); }, 8000);

  const t0 = Date.now();
  let lastProgressAt = Date.now();
  const sendProgress = (msg: string) => { lastProgressAt = Date.now(); void sendOrdered(account, to, cx(), msg); };
  // 即时回执：收到即给一条友好提示，保证用户看到的第一条文本不是 15s 兜底心跳。
  // （有图片时，下面的"🖼️ 收到 N 张图片…"已充当即时回执，不再重复发）
  if (imageItems.length === 0) sendProgress("🤖 收到，正在处理…");
  // 心跳：仅当 brain 真正静默(无任何帧)超过 15s 才提示——首条用友好措辞，后续才带计时
  let hbCount = 0;
  const heartbeat = setInterval(() => {
    if (Date.now() - lastProgressAt >= 15000) {
      hbCount += 1;
      sendProgress(hbCount === 1 ? "🤔 还在思考/检索中…" : `⏳ 仍在处理中…（已 ${Math.round((Date.now() - t0) / 1000)} 秒）`);
    }
  }, 15000);

  // 收图：下载并解密（失败的跳过）
  const images: Array<{ data: string; mimeType: string }> = [];
  if (imageItems.length > 0) {
    sendProgress(`🖼️ 收到 ${imageItems.length} 张图片，下载识别中…`);
    for (const im of imageItems) {
      try {
        const buf = await downloadImage(im);
        images.push({ data: buf.toString("base64"), mimeType: sniffMime(buf) });
      } catch (e) { log("image download failed:", String(e)); }
    }
  }

  // 一次尝试：带进度（步骤编号每次尝试重置）
  const attempt = (): Promise<string> => {
    let step = 0;
    return askBrain(to, text, (ev) => {
      if (ev.type === "tool") {
        step += 1;
        const desc = ev.purpose || (ev.title ? zhTool(ev.title) : "") || "调用工具";
        sendProgress(`${toolIcon(ev.kind)} 步骤 ${step}：${desc}`);
      } else if (ev.type === "thinking") {
        sendProgress("🧠 正在思考…");
      } else if (ev.type === "answer") {
        sendProgress("✍️ 正在整理回复…");
      } else {
        // activity：brain 产出任意帧 → 静默刷新心跳基线，避免流式输出期间误报"仍在处理"
        lastProgressAt = Date.now();
      }
    }, images);
  };

  let answer: string;
  try {
    try {
      answer = await attempt();
    } catch (e1) {
      log("brain error (try 1):", String(e1));
      sendProgress("⏳ 这次响应超时了，正在自动重试…");
      answer = await attempt();
    }
  } catch (e2) {
    log("brain error (try 2):", String(e2));
    answer = "（这次联网检索超时/卡住被中断了，自动重试也没成功，把刚才的消息再发一次试试）";
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
      await sendImage({ baseUrl: account.baseUrl, token: account.botToken, to, image: buf, contextToken: cx() });
      log(`sent image: ${im.src.slice(0, 80)}`);
    } catch (e) { log("send image failed:", im.src, String(e)); failedImgs.push(im.src); }
  }
  let finalText = cleaned;
  if (failedImgs.length) {
    const note = `（有 ${failedImgs.length} 张图片我没能下载下来，附原链接：\n${failedImgs.join("\n")}）`;
    finalText = finalText ? `${finalText}\n\n${note}` : note;
  }
  if (!finalText && !replyImages.length) finalText = "（没有内容）";
  if (finalText) await sendOrdered(account, to, cx(), finalText);
  log(`replied to ${to}: ${(answer || "").slice(0, 60)}`);
}

// ===== 解耦：拉取器(poller) 与 处理器(worker) 通过队列协作 =====
// 大脑(ACP session)严格串行，但「拉取消息/抓 token」无需串行。把两者解耦：
// poller 持续 getUpdates、实时更新 token、把消息入队，永不被大脑阻塞；
// worker 串行从队列取消息喂大脑（尊重 kiro-cli 串行约束），发送时取最新 token，规避 ret=-2。
type QueuedMsg = { from: string; text: string; imageItems: ImageItem[] };
const msgQueue: QueuedMsg[] = [];
let wakeWorker: (() => void) | null = null;
function notifyWorker(): void { const w = wakeWorker; wakeWorker = null; if (w) w(); }

async function pollerLoop(account: AccountData, owner: string, state: ServerState): Promise<void> {
  while (true) {
    if (isSessionPaused(account.botId)) {
      await sleep(Math.min(getRemainingPauseMs(account.botId), 60_000) || 60_000);
      continue;
    }
    let resp;
    try {
      resp = await getUpdates({ baseUrl: account.baseUrl, token: account.botToken, updatesBuf: state.updatesBuf, timeoutMs: 25_000 });
    } catch (e) { log("getUpdates error:", String(e)); await sleep(2000); continue; }
    try {
      if (resp.errcode === SESSION_EXPIRED_ERRCODE) {
        log("session expired (-14); pausing 1h. Send a WeChat message to revive after re-login.");
        pauseSession(account.botId); continue;
      }
      if (resp.errcode) { log("server error:", resp.errcode, resp.errmsg); await sleep(2000); continue; }
      if (resp.get_updates_buf) state.updatesBuf = resp.get_updates_buf;

      const news = (resp.msgs ?? []).filter(
        (m) => m.message_type === MessageType.USER && m.message_id && m.message_id > state.lastMessageId,
      );
      // 先登记本批所有最新 token（worker 发送时取最新）
      for (const m of news) {
        const f = m.from_user_id ?? "";
        if (m.context_token) state.contextTokens[`${account.botId}:${f}`] = m.context_token;
      }
      let enq = false;
      for (const msg of news) {
        state.lastMessageId = Math.max(state.lastMessageId, msg.message_id ?? 0);
        const from = msg.from_user_id ?? "";
        if (from !== owner) { log("ignore non-owner sender:", from); continue; }
        const text = extractText(msg);
        const imageItems = (msg.item_list ?? [])
          .filter((it) => it.type === MessageItemType.IMAGE && it.image_item)
          .map((it) => it.image_item as ImageItem);
        if (!text && imageItems.length === 0) { log("skip empty/unsupported message"); continue; }
        msgQueue.push({ from, text, imageItems });
        enq = true;
      }
      saveState(state);
      if (enq) notifyWorker();
    } catch (e) { log("poller error:", e instanceof Error ? (e.stack || e.message) : String(e)); }
  }
}

async function workerLoop(account: AccountData, state: ServerState): Promise<void> {
  while (true) {
    if (isSessionPaused(account.botId)) {
      await sleep(Math.min(getRemainingPauseMs(account.botId), 30_000) || 30_000);
      continue;
    }
    if (msgQueue.length === 0) {
      await new Promise<void>((r) => { wakeWorker = r; if (msgQueue.length > 0) { wakeWorker = null; r(); } });
      continue;
    }
    const item = msgQueue.shift() as QueuedMsg;
    const from = item.from;
    const latestCtx = () => state.contextTokens[`${account.botId}:${from}`];

    // 控制指令：单独处理
    const ctrl = item.text ? parseControl(item.text) : null;
    if (ctrl) {
      let r: string;
      try { r = await handleControl(ctrl, from); }
      catch (e) { r = "处理指令出错：" + String(e); }
      log("control:", JSON.stringify(ctrl), "->", r.replace(/\n/g, " | "));
      await reply(account, from, latestCtx(), r).catch((e) => log("send error:", String(e)));
      continue;
    }

    try {
      // 合并：把队列中紧随其后、同一用户、非控制指令的消息并入本轮（连发更自然、更省）
      let text = item.text;
      const imageItems = [...item.imageItems];
      while (msgQueue.length > 0 && msgQueue[0].from === from && !(msgQueue[0].text && parseControl(msgQueue[0].text))) {
        const nxt = msgQueue.shift() as QueuedMsg;
        if (nxt.text) text = text ? `${text}\n${nxt.text}` : nxt.text;
        imageItems.push(...nxt.imageItems);
      }
      await handleMessage(account, latestCtx(), latestCtx, from, text, imageItems);
    } catch (e) {
      log("handleMessage error:", e instanceof Error ? (e.stack || e.message) : String(e));
      await reply(account, from, latestCtx(), "处理这条消息时出错了，请再发一次试试。").catch(() => {});
    }
  }
}

async function main(): Promise<void> {
  const account = loadAccount();
  if (!account?.botToken) {
    log("not logged in; run the MCP login_qrcode flow first.");
    process.exit(1);
  }
  const owner = process.env.WECHAT_OWNER_ID?.trim() || account.userId; // 发件人白名单：默认仅本人
  // 写 PID 文件，供管理命令（logout/delete）精确定位并停止本账号的 daemon
  const pidFile = path.join(DATA_DIR, "daemon.pid");
  try { fs.writeFileSync(pidFile, String(process.pid), "utf-8"); } catch { /* best-effort */ }
  const cleanupPid = () => { try { fs.unlinkSync(pidFile); } catch { /* ignore */ } };
  process.on("exit", cleanupPid);
  process.on("SIGINT", () => { cleanupPid(); process.exit(0); });
  process.on("SIGTERM", () => { cleanupPid(); process.exit(0); });
  // 防御：任何未捕获的 promise 拒绝/异常（多为瞬时网络 fetch failed 或回合内 send 被拒）只记录、不退出，
  // 避免 daemon 崩溃丢掉在途回合、用户卡在心跳。此前的 code=1 崩溃即源于此类未捕获拒绝。
  process.on("unhandledRejection", (reason) => {
    log("unhandledRejection:", reason instanceof Error ? (reason.stack || reason.message) : String(reason));
  });
  process.on("uncaughtException", (err) => {
    log("uncaughtException:", err?.stack || String(err));
  });
  ensureBrainHome(); // 准备 brain 沙箱（默认空 MCP）
  log(`up. bot=${account.botId} owner=${owner}`);
  await notifyStart({ baseUrl: account.baseUrl, token: account.botToken }).catch(() => {});

  const state: ServerState = loadState();
  // 解耦运行：拉取器持续抓消息(永不被大脑阻塞)，处理器串行喂大脑
  void pollerLoop(account, owner, state);
  await workerLoop(account, state);
}

main().catch((err) => {
  console.error("[daemon] fatal:", err);
  process.exit(1);
});
