#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { loadAccount, notifyStart, notifyStop } from "@wemind/wechat-ilink-core";
import { VERSION } from "./version.js";
import {
  loginQrcode,
  checkQrcodeStatus,
  loginQrcodeSchema,
  checkQrcodeStatusSchema,
  logoutSchema,
  logout,
} from "./tools/login.js";
import { getMessages, getMessagesSchema } from "./tools/messages.js";
import { sendTextMessage, sendTextMessageSchema } from "./tools/send.js";
import { sendTypingIndicator, sendTypingSchema } from "./tools/typing.js";

const server = new McpServer(
  {
    name: "wemind",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.registerTool(
  "login_qrcode",
  {
    description:
      "Get a WeChat login QR code. Scan it with WeChat to connect the bot. Returns the QR code URL. Call check_qrcode_status afterwards to verify.",
    inputSchema: loginQrcodeSchema,
  },
  async () => {
    return await loginQrcode();
  },
);

server.registerTool(
  "check_qrcode_status",
  {
    description:
      "Check if the QR code (from login_qrcode) has been scanned and confirmed. Call this repeatedly until status is 'confirmed'.",
    inputSchema: checkQrcodeStatusSchema,
  },
  async () => {
    return await checkQrcodeStatus();
  },
);

server.registerTool(
  "logout",
  {
    description: "Log out the current WeChat bot session and clear all saved credentials.",
    inputSchema: logoutSchema,
  },
  async () => {
    return await logout();
  },
);

server.registerTool(
  "get_messages",
  {
    description: `Poll for new WeChat messages. Always call with wait=true to block until a message arrives.

IMPORTANT BEHAVIOR — you MUST follow this workflow:
1. Call get_messages with wait=true and a very large timeout (e.g. 60000). This is a long-polling call that blocks until a message arrives. Set your tool call timeout to at least 120 seconds to avoid premature cancellation.
2. When you receive a message and start processing it (thinking, generating a reply, etc.), immediately call send_typing with status="typing" and to=<from_user_id> to show the user that you are typing.
3. While you are still processing the request, keep calling send_typing with status="typing" periodically (every 15-20 seconds) to keep the typing indicator alive.
4. Once you have finished processing and sent your reply via send_text_message, call send_typing with status="cancel" and to=<from_user_id> to stop the typing indicator.

This ensures the WeChat user sees a "typing..." indicator while you are working on their request.`,
    inputSchema: getMessagesSchema,
  },
  async (input, ctx) => {
    return await getMessages(input, ctx?.mcpReq.signal);
  },
);

server.registerTool(
  "send_text_message",
  {
    description:
      "Send a text message to a WeChat user. The 'to' field is the user ID from a received message.",
    inputSchema: sendTextMessageSchema,
  },
  async (input) => {
    return await sendTextMessage(input);
  },
);

server.registerTool(
  "send_typing",
  {
    description:
      "Send or cancel a typing indicator to a WeChat user. The 'to' field is the user ID from a received message. Status 'typing' shows the indicator, 'cancel' stops it.",
    inputSchema: sendTypingSchema,
  },
  async (input) => {
    return await sendTypingIndicator(input);
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const account = loadAccount();
  if (account?.botToken) {
    console.error(
      `[mcp-wechat] Connected. Logged in as bot ${account.botId}, user ${account.userId}`,
    );
    void notifyStart({
      baseUrl: account.baseUrl,
      token: account.botToken,
    }).catch(() => {});
  } else {
    console.error("[mcp-wechat] Connected. Not logged in. Call login_qrcode to start.");
  }

  // 优雅关停：通知服务端下线（best-effort，notifyStop 内部已吞异常）再退出
  const shutdown = () => {
    const acc = loadAccount();
    const done = () => process.exit(0);
    if (acc?.botToken) void notifyStop({ baseUrl: acc.baseUrl, token: acc.botToken }).finally(done);
    else done();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[mcp-wechat] Fatal error:", err);
  process.exit(1);
});
