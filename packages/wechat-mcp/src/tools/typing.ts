import { z } from "zod";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

import {
  sendTyping,
  getConfig,
  loadAccount,
  loadState,
  isSessionPaused,
  TypingStatus,
} from "@wemind/wechat-ilink-core";

import { sessionExpiredResult } from "./session-result.js";
import { jsonResult, type ToolResult } from "./tool-result.js";

export const sendTypingSchema = z.object({
  to: z.string().min(1).describe("The WeChat user ID to send the typing indicator to."),
  status: z
    .enum(["typing", "cancel"])
    .optional()
    .default("typing")
    .describe("'typing' to show typing indicator, 'cancel' to stop it."),
});

/** 工具入参：status 在 schema 层有默认值，函数层按可选处理（便于直接调用/测试）。 */
type SendTypingInput = { to: string; status?: "typing" | "cancel" };

export async function sendTypingIndicator(input: SendTypingInput): Promise<ToolResult> {
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

  const contextToken = loadState().contextTokens[`${account.botId}:${input.to}`];
  if (!contextToken) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `与用户 ${input.to} 之间没有会话记录，请先收一条该用户的消息，或先发送一条消息。`,
    );
  }

  // typing_ticket 与 context_token 绑定，每次都要现取；拿不到就不能带空 ticket 硬发（服务端会拒）。
  const configResp = await getConfig({
    baseUrl: account.baseUrl,
    token: account.botToken,
    ilinkUserId: input.to,
    contextToken,
  });
  if (!configResp.typing_ticket) {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `获取 typing_ticket 失败：${configResp.errmsg ?? "服务端未返回 typing_ticket"}`,
    );
  }

  const cancel = input.status === "cancel";
  await sendTyping({
    baseUrl: account.baseUrl,
    token: account.botToken,
    body: {
      ilink_user_id: input.to,
      typing_ticket: configResp.typing_ticket,
      status: cancel ? TypingStatus.CANCEL : TypingStatus.TYPING,
    },
  });

  return jsonResult({
    status: cancel ? "typing_cancelled" : "typing",
    message: cancel ? "已取消「正在输入」状态。" : "已显示「正在输入」状态。",
    to: input.to,
  });
}
