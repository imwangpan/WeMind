---
description: 从零安装 WeMind，扫码登录，并发出第一条微信消息。
---

# 快速开始

这一页带你从零跑通：选形态 → 安装 → 扫码 → 发第一条消息。全程不需要服务器。

## 0. 先确认三件事

1. **Node.js 24.11+**：`node -v`。
2. **一个个人微信**：扫码登录用，不需要公众号。
3. **只选一种形态**：MCP Server 或 daemon。同一个 bot token 不能同时被两个程序长轮询。

```bash
node -v
# v24.11.0 或更高
```

## 路线一：MCP Server

适合已经在用 MCP 客户端的人。WeMind 作为 MCP server 跑在客户端里，客户端负责长轮询和回复。

```bash
npx -y @wemind/wechat-mcp
```

在客户端里加一个 stdio MCP server，命令填：

```text
npx -y @wemind/wechat-mcp
```

重启客户端后，让它登录并读取消息。不同客户端的配置位置不同，按你的客户端文档放即可。

## 路线二：daemon 常驻助手

适合想让微信 24 小时连着本机 Agent 的人。

```bash
npm i -g @wemind/cli
wemind login --label 工作号 --start
```

`--label` 只是给人看的别名，不是账号 ID。扫码完成后：

```bash
wemind list          # 看账号和运行状态
wemind log           # 看这个账号的日志
```

第一次登录后，WeMind 会按内置顺序自动探测一个可用的 Agent 作为「大脑」。想指定：

```bash
wemind brain set opencode
wemind brain check
```

`brain check` 会真起一次 ACP 握手，确认这个 Agent 能接进来。

## 发出第一条消息

用登录的那个微信，给这个 bot 发一句：

```text
你好
```

- 如果一切正常，你会收到 Agent 的回复。
- 如果没有回复，先看 `wemind log --errors`，再查[常见问题](../faq/)。

## 两种形态不要同时跑

MCP 形态和 daemon 形态都会长轮询同一个 bot。同时跑会互相抢消息，表现为「有时回、有时不回」，甚至回环。

切换形态前，先停掉另一个：

```bash
wemind stop
```

## 接下来

- [命令速查](./commands.md)
- [切换大脑](./brain.md)
- [远程任务](./tasks.md)
- [开机自启](./autostart.md)
- [Agent 总览](../agents/)
