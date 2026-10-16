import { z } from "zod";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

import {
  getUpdates,
  SESSION_EXPIRED_ERRCODE,
  isSessionPaused,
  pauseSession,
  loadAccount,
  loadState,
  saveState,
  classifyTransportError,
} from "@wemind/wechat-ilink-core";
import type { WeixinMessage } from "@wemind/wechat-ilink-core";

import { sessionExpiredResult } from "./session-result.js";

const LONG_POLL_MS = 25_000;
const POLL_FLOOR_MS = 1000; // wait 模式两次轮询最小间隔，防服务端快速返回空时零间隔请求风暴
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const getMessagesSchema = z.object({
  wait: z
    .boolean()
    .optional()
    .describe(
      "If true, block until at least one new message arrives. May block for a very long time (7 days max). Requires the MCP client to have no tool timeout limit.",
    ),
  timeout: z
    .number()
    .min(1000)
    .max(60000)
    .optional()
    .describe("Long-poll timeout in ms (default: 10000). Ignored when wait=true."),
});

export async function getMessages(
  input: { wait?: boolean; timeout?: number },
  signal?: AbortSignal,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  const account = loadAccount();
  if (!account?.botToken) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "Not logged in. Call login_qrcode first.",
    );
  }

  if (isSessionPaused(account.botId)) {
    return sessionExpiredResult(account.botId);
  }

  const pollMs = input.wait ? LONG_POLL_MS : (input.timeout ?? 10000);
  let state = loadState();
  const deadline = input.wait ? Date.now() + 7 * 24 * 3600_000 : 0;

  while (true) {
    // MCP 客户端取消/断开后，下一轮循环即退出，避免长轮询空转到 7 天 deadline（孤儿长轮询）
    if (signal?.aborted) {
      saveState(state);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ message_count: 0, messages: [], cancelled: true }, null, 2),
          },
        ],
      };
    }
    if (deadline && Date.now() > deadline) {
      saveState(state);
      return {
        content: [
          { type: "text", text: JSON.stringify({ message_count: 0, messages: [] }, null, 2) },
        ],
      };
    }

    const polledAt = Date.now();
    let resp: Awaited<ReturnType<typeof getUpdates>>;
    try {
      resp = await getUpdates({
        baseUrl: account.baseUrl,
        token: account.botToken,
        updatesBuf: state.updatesBuf,
        timeoutMs: pollMs,
      });
    } catch (e) {
      // wait 模式：瞬时网络错误退避重试，不让一次网络抖动终结整个长轮询
      if (input.wait) {
        const cls = classifyTransportError(e);
        if (cls.retryable) {
          await sleep(2000);
          continue;
        }
      }
      throw e;
    }

    if (resp.errcode === SESSION_EXPIRED_ERRCODE) {
      pauseSession(account.botId);
      saveState(state);
      return sessionExpiredResult(account.botId);
    }
    if (resp.errcode) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `Server error: errcode=${resp.errcode} errmsg=${resp.errmsg ?? "unknown"}`,
      );
    }

    if (resp.get_updates_buf) {
      state.updatesBuf = resp.get_updates_buf;
    }

    const newMessages =
      resp.msgs?.filter(
        (m) => m.message_type === 1 && m.message_id && m.message_id > state.lastMessageId,
      ) ?? [];

    if (newMessages.length > 0) {
      const maxId = Math.max(...newMessages.map((m) => m.message_id ?? 0));
      state.lastMessageId = maxId;

      for (const msg of newMessages) {
        const key = `${account.botId}:${msg.from_user_id}`;
        if (msg.context_token) {
          state.contextTokens[key] = msg.context_token;
        }
      }

      saveState(state);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                message_count: newMessages.length,
                messages: newMessages.map(formatMessage),
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (!input.wait) {
      saveState(state);
      return {
        content: [
          { type: "text", text: JSON.stringify({ message_count: 0, messages: [] }, null, 2) },
        ],
      };
    }
    // wait 模式继续前：若本轮服务端快速返回（未 hold 满），补足地板间隔，防零间隔请求风暴
    const elapsed = Date.now() - polledAt;
    if (elapsed < POLL_FLOOR_MS) await sleep(POLL_FLOOR_MS - elapsed);
  }
}

function formatMessage(msg: WeixinMessage) {
  const items = msg.item_list ?? [];
  const textParts: string[] = [];

  for (const item of items) {
    switch (item.type) {
      case 1:
        textParts.push(item.text_item?.text ?? "");
        break;
      case 2:
        textParts.push("[Image]");
        break;
      case 3:
        textParts.push(item.voice_item?.text ? `[Voice: ${item.voice_item.text}]` : "[Voice]");
        break;
      case 4:
        textParts.push(
          item.file_item?.file_name ? `[File: ${item.file_item.file_name}]` : "[File]",
        );
        break;
      case 5:
        textParts.push("[Video]");
        break;
    }
  }

  let text = textParts.join("\n");

  // ref_msg（引用/回复的原消息）挂在 MessageItem 上，不在 WeixinMessage 上。
  // 原实现读 msg.ref_msg 恒为 undefined，是死代码；这里从消息项中取。
  const refMsg = items.find((item) => item.ref_msg)?.ref_msg;
  if (refMsg) {
    const refItem = refMsg.message_item;
    const refText = refItem?.text_item?.text ?? refMsg.title ?? "";
    text = `[Reply to: ${refText}]\n${text}`;
  }

  return {
    message_id: msg.message_id,
    from_user_id: msg.from_user_id,
    to_user_id: msg.to_user_id,
    type: msg.message_type === 1 ? "received" : "sent",
    text,
    context_token: msg.context_token,
    create_time: msg.create_time_ms ? new Date(msg.create_time_ms).toISOString() : undefined,
  };
}
