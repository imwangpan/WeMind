---
description: English documentation for WeMind — turn WeChat into an input/output channel for AI agents.
---

# WeMind Docs

WeMind turns a **personal WeChat account** into an input/output channel for AI agents. Messages are received by a program on your own machine and handed to the agent you choose.

## Choose one route

| Route | Best for | Entry point |
| --- | --- | --- |
| **MCP Server** | You already use Claude Desktop, Cursor, OpenCode, or another MCP client | `npx -y @wemind/wechat-mcp` |
| **daemon** | You want WeChat connected to a local agent 24/7, with brain switching and remote tasks | `npm i -g @wemind/cli`, then `wemind` |

> One bot token can only be polled by one program at a time. Do not run the MCP server and the daemon together.

## Start here

- [Getting Started](./getting-started.md)
- [Commands](./commands.md)
- [Sessions](./sessions.md)
- [Tasks](./tasks.md)
- [Agents](./brain.md)
- [Connect an Agent](./agents.md)
- [FAQ](./faq.md)

## Requirements

- A personal WeChat account.
- **Node.js 24.11 or newer**.
- An ACP-capable agent (daemon route only).
