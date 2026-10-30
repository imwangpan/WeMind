# WeMind RepoWiki

> *Your AI mind, reachable on WeChat.*
>
> 基于 MCP (Model Context Protocol) 的微信 AI 机器人 —— 让任何 AI Agent 都能收发微信消息。
>
> **适用版本**：WeMind 1.2.0 ｜ **最后核对**：2026-10-30 ｜ 各篇若有「实测/假设」差异，以篇内标注为准。

这是 WeMind 仓库的完整技术 wiki，面向想深入理解项目架构、协议、运行机制与扩展方式的开发者。内容依据源码与真机实测整理；**接入类结论会标注「实测 / 假设」**，不要把通用 ACP 说法当成某个 agent 的事实。

> 🤖 **只要快速上手？** 先读 [AGENTS.md](../../AGENTS.md) 和 [docs/ai/README.md](../ai/README.md)；本 wiki 用于深读。

---

## 这是什么

WeMind 把「个人微信」变成一个 AI Agent 的输入输出通道。它基于腾讯官方的 **iLink / 微信 ClawBot** 接口（面向个人微信号的官方插件渠道），对外提供两种完全不同的接入形态：

1. **MCP Server**（`@wemind/wechat-mcp`）—— 把「收发微信」封装成 6 个 MCP 工具，任何兼容 MCP 的客户端（Claude Desktop、Cursor、Kiro 等）都能驱动微信收发消息。这是**请求驱动**的：由 MCP 客户端自己编排长轮询和回复节奏。

2. **常驻 daemon**（`wemind`）—— 一个脱离任何 IDE、自己长轮询收消息、调用常驻 AI 大脑生成回复、自动回发的后台进程。这是**事件驱动 + 全自动**的，还支持远程任务（worker）、多账号、收发图片等。

两者共享同一套 iLink 协议内核（`@wemind/wechat-ilink-core`）。

---

## 阅读导航

按角色推荐的阅读路径：

- **第一次了解项目** → 先读 [1. 项目概览](01-项目概览.md) 和 [2. 系统架构](02-系统架构.md)。
- **想用 MCP 接入自己的 Agent** → [4. MCP Server](04-MCP-Server.md)。
- **想跑常驻自动收发 bot** → [5. daemon](05-daemon.md) + [10. 部署与运维](10-部署与运维.md)。
- **想接入非 kiro 的 AI 大脑** → [6. ACP 大脑与沙箱](06-ACP-大脑与沙箱.md)。
- **想理解远程任务遥控** → [7. 远程任务 Worker](07-远程任务-Worker.md)。
- **要排查协议/错误码问题** → [3. iLink 协议内核](03-iLink-协议内核.md)。

## 章节目录

| # | 章节 | 内容 |
|---|------|------|
| 1 | [项目概览](01-项目概览.md) | 项目定位、Fork 由来与改动、核心功能、技术栈、目录结构 |
| 2 | [系统架构](02-系统架构.md) | monorepo 三包、两种接入形态、端到端数据流、进程模型 |
| 3 | [iLink 协议内核](03-iLink-协议内核.md) | HTTP 客户端、协议类型、错误码、会话守卫、存储层、收发图加解密 |
| 4 | [MCP Server](04-MCP-Server.md) | 6 个 MCP 工具、登录流程、Agent 工作流约定、打包发布 |
| 5 | [daemon](05-daemon.md) | poller/worker 解耦、消息路由、回合编排、连续发送上限、进度节流 |
| 6 | [ACP 大脑与沙箱](06-ACP-大脑与沙箱.md) | 常驻 ACP 进程、会话持久化、MCP 沙箱、记忆继承、接入其它 Agent |
| 7 | [远程任务 Worker](07-远程任务-Worker.md) | 受控 ACP 工作机、任务状态机、微信/本地双入口、中断恢复 |
| 8 | [数据存储与多账号](08-数据存储与多账号.md) | 数据目录布局、账号注册表、授权清单、文件清单速查 |
| 9 | [配置项与环境变量](09-配置项与环境变量.md) | 全部环境变量分类速查表 |
| 10 | [部署与运维](10-部署与运维.md) | 常驻三层进程树、后台守护进程、Windows 自启、pm2 跨平台、多账号 |
| 11 | [开发指南](11-开发指南.md) | 构建顺序、测试、CI、代码约定、贡献流程 |

> 📄 **一页速查**：数据目录改根/迁移、`WEMIND_HOME` / `WECHAT_DATA_DIR` 等环境变量的具体操作（含初次运行指定路径、运行后迁移） → [速查-数据目录与环境变量.md](../速查-数据目录与环境变量.md)（对应 [第 8 章](08-数据存储与多账号.md)、[第 9 章](09-配置项与环境变量.md)）。

---

## 快速事实

| 项目 | 值 |
|------|-----|
| 仓库名 | WeMind（Fork 自 [Howardzhangdqs/mcp-wechat-server](https://github.com/Howardzhangdqs/mcp-wechat-server)） |
| 语言 / 运行时 | TypeScript / Node.js >= 20（Node 24 验证，兼容 Bun） |
| 仓库结构 | npm workspaces monorepo（3 个 package） |
| 后端渠道 | 腾讯 iLink / 微信 ClawBot（`ilinkai.weixin.qq.com`） |
| 默认 AI 大脑 | `auto`：按 `kiro → opencode → gemini → deepseek → qoder → cline` 探测；写入磁盘在 `<数据目录>/brain.json` |
| 数据目录 | `~/.wemind/<account>/`（独立于代码仓库） |
| 许可证 | MIT |

> 注：本 wiki 中数据目录统一以源码实际值 `~/.wemind/` 为准。
