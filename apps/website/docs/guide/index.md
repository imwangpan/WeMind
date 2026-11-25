---
description: WeMind 中文文档入口：把个人微信变成 AI Agent 的输入输出通道。
---

# WeMind 文档

WeMind 把**个人微信**变成 AI Agent 的输入输出通道。你不需要换聊天工具，也不用把微信交给云端；消息由你本机的程序接住，再交给你选择的 Agent。

## 先选一条路线

| 路线 | 适合谁 | 入口 |
| --- | --- | --- |
| **MCP Server** | 已经在用 Claude Desktop、Cursor、OpenCode 等 MCP 客户端，想让客户端收发微信 | `npx -y @wemind/wechat-mcp` |
| **daemon（常驻助手）** | 想让微信 24 小时连着本机 Agent，能切大脑、跑远程任务、开机自启 | `npm i -g @wemind/cli`，命令是 `wemind` |

> 同一个 bot token 同时只能有一个程序收消息。MCP 形态和 daemon 形态**二选一**，不要同时跑。

## 从这里开始

- [快速开始](./getting-started.md)：装好、扫码、发出第一条消息。
- [命令速查](./commands.md)：最常用的 CLI 命令。
- [会话](./sessions.md)：新会话、恢复、重命名、删除。
- [远程任务](./tasks.md)：把长任务交给另一个 Agent，在微信里回。
- [切换大脑](./brain.md)：换一个 Agent 接手。
- [图片、文件与语音](./media.md)：收发附件、语音转写、敏感文件。
- [开机自启](./autostart.md)：让 daemon 在登录后自己起来。
- [Agent 总览](../agents/)：内置 10 个预设，以及接入条件。
- [参考](../reference/)：CLI、微信指令、环境变量、数据目录。
- [常见问题](../faq/)：扫码、超时、Windows 凭据、任务卡住。

## 你需要准备

- 一个**个人微信**账号（不需要公众号或企业微信）。
- **Node.js 24.11 或更高版本**。
- 一个能通过 ACP 接入的 Agent（只有 daemon 路线需要）。

> WeMind 不会替你申请 bot，也不要求你交出微信密码。登录靠扫码，凭证只保存在本机。
