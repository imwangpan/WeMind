import { z } from "zod";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

import {
  sendMessage,
  generateId,
  loadAccount,
  loadState,
  MessageItemType,
  MessageState,
  MessageType,
  isSessionPaused,
  ILinkError,
} from "@wemind/wechat-ilink-core";
import type { SendMessageReq } from "@wemind/wechat-ilink-core";

import { sessionExpiredResult } from "./session-result.js";
import { jsonResult, type ToolResult } from "./tool-result.js";

export const sendTextMessageSchema = z.object({
  to: z.string().min(1).describe("The WeChat user ID to send the message to."),
  text: z.string().min(1).describe("The text message to send."),
  state: z
    .enum(["finish", "generating"])
    .optional()
    .describe(
      "Use 'generating' for interim/progress messages and 'finish' (default) for your final reply. Each call is a separate WeChat message.",
    ),
});

export async function sendTextMessage(input: {
  to: string;
  text: string;
  state?: "finish" | "generating";
}): Promise<ToolResult> {
  const account = loadAccount();
  if (!account?.botToken) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "尚未登录，请先调用 login_qrcode 完成登录。",
    );
  }
  if (isSessionPaused(account.botId)) {
    return sessionExpiredResult(account.botId);
  }

  const state = loadState();
  const contextToken = state.contextTokens[`${account.botId}:${input.to}`];
  if (!contextToken) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `与用户 ${input.to} 之间没有会话记录。iLink 机器人不能主动发起对话，需要先收到该用户的消息。`,
    );
  }

  const req: SendMessageReq = {
    msg: {
      from_user_id: "",
      to_user_id: input.to,
      client_id: generateId("wemind/wechat-mcp"),
      message_type: MessageType.BOT,
      message_state: input.state === "generating" ? MessageState.GENERATING : MessageState.FINISH,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: input.text } }],
      context_token: contextToken,
    },
  };

  const send = () =>
    sendMessage({
      baseUrl: account.baseUrl,
      token: account.botToken,
      body: req,
    });
  try {
    await send();
  } catch (e) {
    // ret=-2 既可能是限流（等一会儿就好），也可能是 context_token 失效（等多久都没用）：
    // 与 daemon 一样先退避重试一次；仍失败就把两种可能都告诉 agent，别让它以为已经发出去了。
    if (!(e instanceof ILinkError) || e.kind !== "param_error") throw e;
    await new Promise((r) => setTimeout(r, 1500));
    try {
      await send();
    } catch (e2) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `发送被服务端拒绝（ret=-2，可能是限流或 context_token 失效）。已自动重试一次仍失败：${e2 instanceof Error ? e2.message : String(e2)}。稍后再试；若持续失败，让用户先给你发一条消息刷新 token。`,
      );
    }
  }

  return jsonResult({
    status: "sent",
    message: "消息已发送。",
    to: input.to,
    text: input.text,
    client_id: req.msg?.client_id,
  });
}
