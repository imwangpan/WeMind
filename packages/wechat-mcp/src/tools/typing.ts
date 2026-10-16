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

export const sendTypingSchema = z.object({
  to: z.string().min(1).describe("The WeChat user ID to send the typing indicator to."),
  status: z
    .enum(["typing", "cancel"])
    .optional()
    .default("typing")
    .describe("'typing' to show typing indicator, 'cancel' to stop it."),
});

export async function sendTypingIndicator(input: {
  to: string;
  status?: "typing" | "cancel";
}): Promise<{
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

  const state = loadState();
  const ctxKey = `${account.botId}:${input.to}`;
  const contextToken = state.contextTokens[ctxKey];

  if (!contextToken) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `No conversation found with user ${input.to}. Send or receive a message first.`,
    );
  }

  const configResp = await getConfig({
    baseUrl: account.baseUrl,
    token: account.botToken,
    ilinkUserId: input.to,
    contextToken,
  });

  if (configResp.errmsg || !configResp.typing_ticket) {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `getConfig failed: ${configResp.errmsg ?? "no typing_ticket (likely ret!=0)"}`,
    );
  }

  if (input.status === "cancel") {
    await sendTyping({
      baseUrl: account.baseUrl,
      token: account.botToken,
      body: {
        ilink_user_id: input.to,
        typing_ticket: configResp.typing_ticket,
        status: TypingStatus.CANCEL,
      },
    });
  } else {
    await sendTyping({
      baseUrl: account.baseUrl,
      token: account.botToken,
      body: {
        ilink_user_id: input.to,
        typing_ticket: configResp.typing_ticket,
        status: TypingStatus.TYPING,
      },
    });
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            status: input.status === "cancel" ? "typing_cancelled" : "typing",
            message:
              input.status === "cancel" ? "Typing indicator stopped." : "Typing indicator sent.",
            to: input.to,
          },
          null,
          2,
        ),
      },
    ],
  };
}
