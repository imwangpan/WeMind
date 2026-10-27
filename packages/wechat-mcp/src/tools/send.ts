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
} from "@wemind/wechat-ilink-core";
import type { SendMessageReq } from "@wemind/wechat-ilink-core";

import { sessionExpiredResult } from "./session-result.js";
import { jsonResult, type ToolResult } from "./tool-result.js";

export const sendTextMessageSchema = z.object({
  to: z.string().min(1).describe("The WeChat user ID to send the message to."),
  text: z.string().min(1).describe("The text message to send."),
});

export async function sendTextMessage(input: { to: string; text: string }): Promise<ToolResult> {
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
      message_state: MessageState.FINISH,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: input.text } }],
      context_token: contextToken,
    },
  };

  await sendMessage({
    baseUrl: account.baseUrl,
    token: account.botToken,
    body: req,
  });

  return jsonResult({
    status: "sent",
    message: "消息已发送。",
    to: input.to,
    text: input.text,
    client_id: req.msg?.client_id,
  });
}
