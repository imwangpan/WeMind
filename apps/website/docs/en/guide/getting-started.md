---
description: Install WeMind, scan the QR code, and send your first WeChat message.
---

# Getting Started

This guide takes you from zero to your first message. No server required.

## Before you start

1. **Node.js 24.11+**: `node -v`.
2. **A personal WeChat account**: scan-to-login only.
3. **Pick one route**: MCP Server or daemon. The same bot token cannot be polled by both.

## Route 1: MCP Server

Use this if you already have an MCP client.

```bash
npx -y @wemind/wechat-mcp
```

Add a stdio MCP server to your client with:

```text
npx -y @wemind/wechat-mcp
```

Restart the client, then use its MCP tools to log in and read messages. Configuration locations differ by client.

## Route 2: daemon

Use this if you want WeChat connected to a local agent all day.

```bash
npm i -g @wemind/cli
wemind login --label work --start
```

`--label` is only a human-friendly alias. After scanning:

```bash
wemind list
wemind log
```

WeMind auto-detects an available agent as the brain. To choose one:

```bash
wemind brain set opencode
wemind brain check
```

`brain check` performs a real ACP handshake.

## Send your first message

From the WeChat account that scanned the code, send:

```text
hello
```

If nothing comes back, check `wemind log --errors` and the [FAQ](./faq.md).

## Do not run both routes

Both routes poll the same bot. Running both causes messages to be stolen, missed, or looped.

```bash
wemind stop
```

## Next

- [Commands](./commands.md)
- [Sessions](./sessions.md)
- [Tasks](./tasks.md)
- [Agents](./brain.md)
- [Connect an Agent](./agents.md)
