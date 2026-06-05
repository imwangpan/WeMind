#!/usr/bin/env node
import {
  getUpdates, sendMessage, sendTyping, getConfig, notifyStart, generateId,
} from "../api/client.js";
import {
  SESSION_EXPIRED_ERRCODE, isSessionPaused, pauseSession, getRemainingPauseMs,
} from "../api/session-guard.js";
import { loadAccount, loadState, saveState } from "../store/account.js";
import { MessageItemType, MessageState, MessageType } from "../api/types.js";
import type { AccountData, ServerState, WeixinMessage, SendMessageReq } from "../api/types.js";
import { askKiroForUser, newSession, restart } from "./acp-brain.js";
import { ensureBrainHome, addMcp, removeMcp, listMcp } from "./mcp-sandbox.js";

const log = (...a: unknown[]) => console.error("[daemon]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function extractText(msg: WeixinMessage): string {
  return (msg.item_list ?? [])
    .filter((it) => it.type === MessageItemType.TEXT)
    .map((it) => it.text_item?.text ?? "")
    .join("\n")
    .trim();
}

/** 工具标题中文化（用于微信进度提示）。 */
function zhTool(t: string): string {
  return t
    .replace(/^Searching the web for:?\s*/i, "联网搜索：")
    .replace(/^Running:?\s*/i, "执行：")
    .replace(/^Reading\s+/i, "读取 ")
    .replace(/^Writing\s+/i, "写入 ");
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

async function handleMessage(account: AccountData, ctx: string | undefined, to: string, text: string): Promise<void> {
  await setTyping(account, to, ctx, 1);
  // 处理期间每 8s 续发"正在输入"，避免长任务时指示消失、用户以为卡了
  const keepAlive = setInterval(() => { void setTyping(account, to, ctx, 1).catch(() => {}); }, 8000);
  let answer: string;
  let step = 0;
  try {
    answer = await askKiroForUser(to, text, (title) => {
      step += 1;
      void reply(account, to, ctx, `🔧 步骤 ${step}：${zhTool(title)}`).catch(() => {});
    });
  } catch (e) {
    log("brain error:", String(e));
    answer = "（我这边处理出错了，稍后再发一次试试）";
  } finally {
    clearInterval(keepAlive);
  }
  await setTyping(account, to, ctx, 2);
  try {
    await reply(account, to, ctx, answer || "（没有内容）");
    log(`replied to ${to}: ${answer.slice(0, 60)}`);
  } catch (e) {
    log("send error:", String(e));
  }
}

async function main(): Promise<void> {
  const account = loadAccount();
  if (!account?.botToken) {
    log("not logged in; run the MCP login_qrcode flow first.");
    process.exit(1);
  }
  const owner = process.env.WECHAT_OWNER_ID?.trim() || account.userId; // 发件人白名单：默认仅本人
  ensureBrainHome(); // 准备 brain 沙箱（默认空 MCP）
  log(`up. bot=${account.botId} owner=${owner}`);
  await notifyStart({ baseUrl: account.baseUrl, token: account.botToken }).catch(() => {});

  const state: ServerState = loadState();
  while (true) {
    if (isSessionPaused(account.botId)) {
      await sleep(Math.min(getRemainingPauseMs(account.botId), 60_000) || 60_000);
      continue;
    }
    let resp;
    try {
      resp = await getUpdates({
        baseUrl: account.baseUrl, token: account.botToken,
        updatesBuf: state.updatesBuf, timeoutMs: 25_000,
      });
    } catch (e) {
      log("getUpdates error:", String(e));
      await sleep(2000);
      continue;
    }
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
      (m) => m.message_type === MessageType.USER && m.message_id && m.message_id > state.lastMessageId,
    );
    for (const msg of news) {
      state.lastMessageId = Math.max(state.lastMessageId, msg.message_id ?? 0);
      const from = msg.from_user_id ?? "";
      if (msg.context_token) state.contextTokens[`${account.botId}:${from}`] = msg.context_token;
      saveState(state);
      if (from !== owner) { log("ignore non-owner sender:", from); continue; }
      const text = extractText(msg);
      if (!text) { log("skip non-text message"); continue; }
      const ctx = state.contextTokens[`${account.botId}:${from}`];
      const ctrl = parseControl(text);
      if (ctrl) {
        let r: string;
        try { r = await handleControl(ctrl, from); }
        catch (e) { r = "处理指令出错：" + String(e); }
        log("control:", JSON.stringify(ctrl), "->", r.replace(/\n/g, " | "));
        await reply(account, from, ctx, r).catch((e) => log("send error:", String(e)));
        continue;
      }
      await handleMessage(account, ctx, from, text);
    }
    saveState(state);
  }
}

main().catch((err) => {
  console.error("[daemon] fatal:", err);
  process.exit(1);
});
