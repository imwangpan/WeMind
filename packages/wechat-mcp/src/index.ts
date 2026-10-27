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

/**
 * 关于工具 description 为什么保持英文（不要改成中文）：
 *
 * 1. **约定俗成**：MCP 生态里（官方 server、Claude Desktop、Cursor、OpenCode）的工具说明一律英文，本包是发布到 public npm 的公开包，混入中文会与生态不一致，也不利于非中文用户。
 * 2. **提示词遵循度**：这段文字会原样拼进调用方模型的工具定义。实测中英文混排或整段中文时，部分模型对 `MUST` / `wait=true` / 步骤顺序这类强制约束的遵循度会下降——而 `get_messages` 那段工作流一旦被忽略，用户就看不到「正在输入」、甚至收不到回复。
 *
 * 注意分工：description 只给**模型**读，用户永远看不到它。用户能看到的文案在 `tools/*.ts` 的 `message` 字段（那些是中文）。
 *
 * 格式约定（6 个工具统一）：首句「做什么」→ 其次「何时调用 / 返回什么」→ 最后写硬约束。
 */
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

// 【登录第一步】取二维码。返回三种展示形式（URL / PNG / 终端文本），并强制 Agent 自己 cat 终端二维码。
server.registerTool(
  "login_qrcode",
  {
    description: `Get a WeChat login QR code. Scan it with WeChat to connect the bot.

Returns the QR code in three forms: the image URL, a PNG file, and a terminal-renderable text file. You MUST show all three to the user, then call check_qrcode_status to verify the login.`,
    inputSchema: loginQrcodeSchema,
  },
  async () => {
    return await loginQrcode();
  },
);

// 【登录第二步】轮询扫码状态。status 可能是 wait/scaned/confirmed/expired，或 need_verifycode / scaned_but_redirect 这类 MCP 流程不支持的态（会明确指路 CLI）。
server.registerTool(
  "check_qrcode_status",
  {
    description: `Check whether the QR code from login_qrcode has been scanned and confirmed.

Call this repeatedly until it returns status 'confirmed'. If it returns 'expired', call login_qrcode again for a fresh code. If it returns 'need_verifycode' or an IDC-redirect status, the MCP login flow cannot complete — tell the user to run the "wemind login" CLI command instead.`,
    inputSchema: checkQrcodeStatusSchema,
  },
  async () => {
    return await checkQrcodeStatus();
  },
);

// 【登出】通知服务端下线 + 清凭证/状态/扫码态。用户明确要求退出、或要换号重登时调用。
server.registerTool(
  "logout",
  {
    description: `Log out the current WeChat bot session.

Notifies the iLink server that the bot is going offline, then clears saved credentials, runtime state and any pending QR login. Only call this when the user asks to log out or wants to switch accounts.`,
    inputSchema: logoutSchema,
  },
  async () => {
    return await logout();
  },
);

// 【收消息】最核心的工具。wait=true 是长轮询，必须配套下面的 typing 工作流，否则微信用户在整个处理期间看不到「正在输入」。
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

// 【发消息】只能在已有会话内回复（iLink 不允许主动发起），to 取自 get_messages 返回的 from_user_id。
server.registerTool(
  "send_text_message",
  {
    description: `Send a text message to a WeChat user.

The 'to' field is the from_user_id from a message you received via get_messages. iLink bots cannot initiate conversations: if you have never received a message from that user, this call fails.`,
    inputSchema: sendTextMessageSchema,
  },
  async (input) => {
    return await sendTextMessage(input);
  },
);

// 【正在输入】配合 get_messages 的 4 步工作流。typing 显示、cancel 取消；处理耗时较长时需每 15-20 秒续发一次保活（微信侧指示器会自动过期）。
server.registerTool(
  "send_typing",
  {
    description: `Show or cancel the "typing..." indicator for a WeChat user.

Status 'typing' shows the indicator, status 'cancel' stops it. The 'to' field is the from_user_id from a message you received via get_messages. While you are still working, re-send status 'typing' every 15-20 seconds, because the indicator expires on its own.`,
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
      `[wemind/wechat-mcp] Connected. Logged in as bot ${account.botId}, user ${account.userId}`,
    );
    void notifyStart({
      baseUrl: account.baseUrl,
      token: account.botToken,
    }).catch(() => {});
  } else {
    console.error("[wemind/wechat-mcp] Connected. Not logged in. Call login_qrcode to start.");
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
  console.error("[wemind/wechat-mcp] Fatal error:", err);
  process.exit(1);
});
