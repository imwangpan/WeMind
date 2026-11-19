# WeMind 文档总索引

> **最后核对**：2026-11-18
>
> 全库文档按**读者与场景**分组。不知道从哪开始，就按下面的「你是」表选入口；要找某个具体机制，看「按主题」。

---

## 按读者

| 你是 | 先读 | 说明 |
| --- | --- | --- |
| **第一次用 WeMind** | [新手教程](使用指南/新手教程.md) → [速查：数据目录与环境变量](使用指南/速查-数据目录与环境变量.md) | 从扫码登录到微信聊天，一步步来 |
| **只想用 MCP 形态** | [packages/wechat-mcp/README.md](../packages/wechat-mcp/README.md) → [repowiki 04](repowiki/04-MCP-Server.md) | 挂到 Claude Desktop / Cursor / OpenCode |
| **想用常驻 daemon** | [packages/wechat-daemon/README.md](../packages/wechat-daemon/README.md) → [使用指南-远程任务](使用指南/使用指南-远程任务（worker）.md) | `npm i -g @wemind/cli`，命令 `wemind` |
| **想换 AI 大脑** | [接入其它 ACP Agent](接入方案/接入其它-ACP-Agent.md) → 各 agent 的接入文档 | 10 个内置预设 + 通用接入流程 |
| **要部署 / 长期运维** | [daemon 常驻原理](部署与运维/daemon-常驻原理.md) → [开机自启](部署与运维/开机自启.md) → [跨平台常驻（pm2）](部署与运维/跨平台常驻-pm2.md) → [repowiki 10](repowiki/10-部署与运维.md) | 后台守护、开机自启、多账号、日志轮转 |
| **要改这个仓库** | [AGENTS.md](../AGENTS.md) → [repowiki 11 开发指南](repowiki/11-开发指南.md) → [系统架构](repowiki/02-系统架构.md) | 硬约束、构建、测试、代码地图 |
| **要发版** | [如何发布新版本](发布与变更记录/如何发布新版本.md) | 两个包的版本号、CI、验收与常见坑 |
| **AI 编码助手** | [AGENTS.md](../AGENTS.md) → [docs/ai/README.md](ai/README.md) → [术语表](ai/术语表.md) → [任务配方](ai/recipes/) | 压缩上下文、术语口径、按任务的操作步骤 |

---

## 按主题

### 使用指南（面向用户）

- [新手教程](使用指南/新手教程.md) —— 从零开始（扫码、启动、微信指令、常见问题）
- [使用指南-远程任务（worker）](使用指南/使用指南-远程任务（worker）.md) —— 多任务、指定 agent、续跑
- [速查-数据目录与环境变量](使用指南/速查-数据目录与环境变量.md) —— 一页纸速查

### 接入方案（面向想换大脑的用户 / 维护者）

- [接入其它-ACP-Agent](接入方案/接入其它-ACP-Agent.md) —— **先读这篇**：判断某个 agent 能不能接、通用配置方式、10 个内置预设总表；另有 [Copilot CLI 专页](接入方案/接入-Copilot.md)
- 各 agent 实测： [Kiro](接入方案/接入-Kiro.md) · [OpenCode](接入方案/接入-OpenCode.md) · [DeepSeek](接入方案/接入-DeepSeek.md) · [Qoder](接入方案/接入-Qoder.md) · [Cline](接入方案/接入-Cline.md) · [Gemini](接入方案/接入-Gemini.md) · [Claude Code](接入方案/接入-ClaudeCode.md) · [Codex](接入方案/接入-Codex.md) · [pi](接入方案/接入-pi.md)

### RepoWiki（面向开发者的完整技术 wiki）

[RepoWiki 首页](repowiki/README.md) 有阅读导航与章节目录。11 章依次是：项目概览、系统架构、iLink 协议内核、MCP Server、daemon、ACP 大脑与副本、远程任务 Worker、数据存储与多账号、配置项与环境变量、部署与运维、开发指南。

### 部署与运维

- [daemon 常驻原理](部署与运维/daemon-常驻原理.md) —— 三层进程、后台守护、单实例、自愈
- [开机自启](部署与运维/开机自启.md) —— **现行方案**：`wemind autostart`、系统触发器 + 内置 watchdog、PM2 优先
- [跨平台常驻（pm2）](部署与运维/跨平台常驻-pm2.md) —— Windows / Linux / macOS 统一常驻

### 发布与变更

- [如何发布新版本](发布与变更记录/如何发布新版本.md) —— **唯一发版手册**（两个包的版本号、CI、验收、回滚、一致性约束、首次发布留档）
- [CHANGELOG](发布与变更记录/CHANGELOG.md)

### AI 上下文

- [docs/ai/README.md](ai/README.md) —— 压缩上下文、数据流、事实状态表、按任务的源码地图
- [docs/ai/代码地图.md](ai/代码地图.md) —— 约 35 个关键文件的单文件职责（从 AGENTS.md §2 拆出）
- [docs/ai/已知坑.md](ai/已知坑.md) —— 从 AGENTS.md §6 拆出；按关键词检索，不需要通读
- [docs/ai/验收清单.md](ai/验收清单.md) —— 从 AGENTS.md §7 拆出；按改动类型查表
- [docs/ai/术语表.md](ai/术语表.md) —— 术语含义与中英写作口径
- [docs/ai/recipes/](ai/recipes/) —— 任务配方（加 agent / 加 MCP / 排障 / 端到端验收）

### 机制与协议（现行）

- [本地双入口：命令派发 + 命令式查看/回复](机制与协议说明/本地双入口-命令派发与查看回复.md) —— CLI ↔ daemon 的**文件桥协议**（`task-inbox/` `task-out/` 与控制桥），正文含 2026-06 / 2026-10 演进时间线

### 设计与开发（现行）

- [文档守卫设计](设计文档/文档守卫设计.md) —— 四个守卫脚本（doc-impact / check-agent-docs / gen-docs-tables / check-user-copy）的设计、运行方式、已知边界与维护指南；`doc-impact` 另有内容级校验（`STALE_FACTS`），逐行拦截已废弃结论
- [WeMind 接入本机 Agent 工作模式设计与实现](设计文档/WeMind-接入本机-Agent-工作模式设计与实现.md) —— 让 daemon / worker 直接使用本机 Agent 的真实配置、技能、记忆与会话；`direct`（默认）/ `managed` 两种模式、微信 overlay、工作区、MCP 策略、yolo、迁移与验收
- [远程任务（Worker）human-in-the-loop 设计与实现](<设计文档/远程任务（Worker）human-in-the-loop 设计与实现.md>) —— 把漫长任务交给受控 ACP worker 进程：单任务单进程 → 多任务 + 进程池 + 重启续跑；消息路由与状态机、会话恢复、配置与权限、进度反馈、双入口、边界
- [Agent 接入：配置化与插件化设计与实现](设计文档/Agent-接入配置化与插件化设计与实现.md) —— 把「接入新 ACP Agent」从改 TS + 发版变成加一份定义（必要时加一个插件）：定义放 `~/.wemind/.agents/`、来源优先级、adapter hook 边界、探针与自助接入、`agent add/remove` 分发（**P0–P4 已实现**）
- [远程任务（Worker）接收、发送非文本消息设计与实现](<设计文档/远程任务（Worker）接收、发送非文本消息设计与实现.md>) —— 两个方向：用户把图片/文件/视频/语音发给任务（收件人模式 + 待投递队列、共享入站媒体与 prompt 媒体层、路由与 TTL），任务结果把图片/文件/视频发回微信（出站语法、共用管线、额度、安全闸、可发现性）

### 历史归档（明确标注，不作为现行说明）

- [设计文档](设计文档/) —— 历史文档：[受控 ACP 工作机（Worker）设计文档](<设计文档/受控 ACP 工作机（Worker）设计文档.md>)、[WeMind CLI 化设计](设计文档/wemind-CLI化设计.md)（均已加存档声明）；现行的《文档守卫设计》《远程任务（Worker）human-in-the-loop 设计与实现》《WeMind 接入本机 Agent 工作模式设计与实现》《Agent 接入配置化与插件化设计与实现》《远程任务（Worker）接收、发送非文本消息设计与实现》见上一节
- [源码目录分层设计](设计文档/源码目录分层设计.md) —— 2026-11-06 的目录分层实施记录（历史）；其中 `agents/brain-presets.ts` 已在 2026-11-16 被 `agents/definitions/*.json` + `agent-registry.ts` 取代，现行目录与文件职责见 [`ai/代码地图.md`](ai/代码地图.md)
- [审查与质量记录](审查与质量记录/) —— [2026-11-02 全局审查快照](审查与质量记录/审查-2026-11-02.md)、[2026-11-04 归档清单](审查与质量记录/历史文档清单-2026-11-04.md)、[2026-11-05 审计经验](审查与质量记录/审查-2026-11-05-经验与约束.md)、[2026-11-18 worker 媒体真机实测](审查与质量记录/实测-worker媒体-2026-11-18.md)
- [待办与后续计划](待办与后续计划/) —— 暂缓项（[任务编号与记录体积](待办与后续计划/待办-任务编号与记录体积.md)、[引用消息正文缓存](待办与后续计划/待办-引用消息缓存.md)、[自带管理 MCP](待办与后续计划/待办-自带管理-MCP.md)、[出站媒体支持 URL 直发](待办与后续计划/待办-出站媒体支持URL直发.md)、[帮助文案与指令书写规范](待办与后续计划/待办-帮助文案与指令书写规范.md)）

---

## 文档约定

1. **每篇现行文档头部写「最后核对」日期**（接入类另写「实测范围 / 环境」）；全库文档描述**当前分支的最新代码**，不绑定已发布版本号。
2. **「实测」与「假设」分开写**：接入类结论给命令、版本、日期；不确定的标「假设 / 待实测」。
3. **改代码时同一次改完代码 + 测试 + 文档**（硬性要求，见 [AGENTS.md](../AGENTS.md) §4.15）。
4. 内部链接一律用相对路径；新增/移动文档后跑 `pwsh -NoProfile -File scripts/check-docs.ps1`。
5. 历史文档保留原文与设计背景，只在顶部加存档声明、修确定错误——**不重写历史**。
