# WeMind

> _Your AI mind, reachable on WeChat. —— 你的 AI 大脑，在微信上随时可达。_

> **适用版本**：WeMind 1.0.1 ｜ **最后核对**：2026-10-24 ｜ 代码以当前 `main` 为准；接入类结论请看对应文档的「实测/假设」标注。

WeMind 让任何 AI Agent 都能通过「个人微信」收发消息。它把腾讯官方的 iLink / 微信 ClawBot 渠道封装成两种可消费形态：一个 MCP Server 子包（`@wemind/wechat-mcp`，**已发布到 npm**），和一个常驻守护进程（**未发布**，从源码运行）。

> 🚀 **第一次用？** 看 **[新手教程](docs/新手教程.md)** —— 从零一步步搭起你的微信 AI（两种用法：接入现有 AI 客户端 / 常驻自动助手）。
>
> 🤖 **AI agent / 新协作者**：先读 **[AGENTS.md](AGENTS.md)**，再按需看 **[docs/ai/README.md](docs/ai/README.md)**（压缩上下文 + 任务配方）。

## 📖 文档 / RepoWiki

想深入理解架构、协议与运行机制，请看 **[docs/repowiki/](docs/repowiki/README.md)** —— 一份依据源码整理的完整技术 wiki（含 Mermaid 架构图）：

| 入口                                                     | 内容                                                    |
| -------------------------------------------------------- | ------------------------------------------------------- |
| [AGENTS.md](AGENTS.md)                                   | **AI 首轮入口**：30 秒定位、硬约束、改哪里、已知坑     |
| [docs/ai/README.md](docs/ai/README.md)                   | AI 上下文包：术语、数据流、事实状态表、任务配方         |
| [RepoWiki 首页](docs/repowiki/README.md)                 | 按角色的阅读导航 + 章节目录                             |
| [系统架构](docs/repowiki/02-系统架构.md)                 | 三包协作、两种接入形态、poller/worker 解耦、双 ACP 进程 |
| [iLink 协议内核](docs/repowiki/03-iLink-协议内核.md)     | HTTP 客户端、协议类型、错误码、收发图加解密             |
| [守护进程 Daemon](docs/repowiki/05-守护进程-Daemon.md)   | 消息路由、回合编排、连续发送上限管理                    |
| [ACP 大脑与沙箱](docs/repowiki/06-ACP-大脑与沙箱.md)     | 常驻 ACP 进程、MCP 沙箱、记忆继承、换大脑               |
| [远程任务 Worker](docs/repowiki/07-远程任务-Worker.md)   | 受控工作机、任务状态机、微信/本地双入口                 |
| [配置项与环境变量](docs/repowiki/09-配置项与环境变量.md) | 全部 env 速查表                                         |
| [llms.txt](llms.txt)                                     | 机器可读文档索引                                        |

> 本 README 是面向用户的使用说明；RepoWiki 是面向开发者的深度技术文档，两者互补。

## 功能

- **6 个 MCP 工具**：登录、消息轮询、文本发送、打字状态
- **扫码登录**：生成终端文本二维码、PNG 图片、URL 链接三种方式
- **长轮询监听**：阻塞等待新消息，最长可等待 7 天
- **打字状态**：Agent 处理消息时自动显示"对方正在输入..."
- **状态持久化**：重启不丢失登录凭证和消息游标
- **独立运行**：无需 OpenClaw 框架，开箱即用

## 环境要求

- [Node.js](https://nodejs.org/) >= 20（已在 Node 24 验证）
- 仍兼容 Bun（可选）

## 项目结构（npm workspaces 三包）

本仓库是一个 monorepo，按职责拆为三个包，共享同一套 iLink 协议内核：

| 包                          | 路径                         | 说明                                                                                         | 发布                            |
| --------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------- |
| `@wemind/wechat-ilink-core` | `packages/wechat-ilink-core` | iLink 协议内核：HTTP 客户端、类型、会话守卫、账号/状态持久化、收图解密。不依赖任何「消费方」 | 私有（内联进 mcp-server）       |
| `@wemind/wechat-mcp`        | `packages/wechat-mcp`        | MCP server：把内核能力暴露为 MCP 工具，供任意 MCP 客户端接入                                 | **已发布**（bin: `wemind-mcp`） |
| `wemind`                    | `packages/wechat-daemon`     | 独立常驻守护进程：长轮询 + 常驻 ACP 大脑自动收发                                             | 未发布（bin: `wemind`）         |

> 📌 上表「发布」列指的是**该子包**是否发布到 npm，不代表整个 WeMind 项目——目前只有 `@wemind/wechat-mcp` 一个包对外发布。

`mcp-server` 发布时用 [tsdown](https://tsdown.dev/)（rolldown + oxc）把 `core` **内联**进单一产物，因此对外只需发布这一个自包含的包；`daemon` 在本仓库内通过 workspace 直接引用 `core` 源码，永不发布。

## 快速开始

> **接入形态**：`@wemind/wechat-mcp` 已发布到 npm，可直接通过 `npx -y @wemind/wechat-mcp` 接入。以下配置适用于 Claude Desktop、OpenCode、Cursor 等 MCP 客户端。本地开发时也可以构建后直接运行 `packages/wechat-mcp/dist/index.js`。

### Claude Desktop

在 `claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "wechat": {
      "command": "npx",
      "args": ["-y", "@wemind/wechat-mcp"]
    }
  }
}
```

### OpenCode

在 `opencode.json` 中添加（V2 格式：MCP server 定义在 `mcp.servers` 下）：

```json
{
  "mcp": {
    "servers": {
      "wechat": {
        "type": "local",
        "command": ["npx", "-y", "@wemind/wechat-mcp"]
      }
    }
  }
}
```

### Cursor / 其他 MCP 客户端

Cursor 等客户端用与 Claude Desktop 相同的 `mcpServers` 结构（Cursor 的配置文件为 `~/.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "wechat": { "command": "npx", "args": ["-y", "@wemind/wechat-mcp"] }
  }
}
```

## 使用方法

### 1. 扫码登录

AI Agent 调用 `login_qrcode` 生成二维码，你可以通过以下方式扫码：

- 在终端运行 `cat ~/.wemind/default/qrcode.txt` 查看二维码
- 打开图片文件 `~/.wemind/default/qrcode.png`
- 将链接复制到微信中打开

> **提示**：如果手机扫码后页面一直加载，请切换到**移动数据网络**（关闭 WiFi）。

### 2. 确认登录

Agent 调用 `check_qrcode_status` 确认登录状态。

### 3. 开始聊天

登录成功后，Agent 会自动执行以下流程：

1. 调用 `get_messages` 轮询新消息
2. 收到消息后调用 `send_typing` 显示"正在输入..."
3. 处理完成后调用 `send_text_message` 回复
4. 回复完毕后调用 `send_typing` 取消打字状态

## 工具列表

| 工具                  | 说明                                           |
| --------------------- | ---------------------------------------------- |
| `login_qrcode`        | 生成微信登录二维码                             |
| `check_qrcode_status` | 检查二维码是否已扫码确认                       |
| `logout`              | 退出登录并清除凭证                             |
| `get_messages`        | 拉取新消息（`wait=true` 阻塞等待直到收到消息） |
| `send_text_message`   | 发送文本消息                                   |
| `send_typing`         | 发送或取消"正在输入"状态                       |

## 数据存储

运行时状态保存在 **`~/.wemind/<account>/`** 下(默认账号 `default`，即 `~/.wemind/default/`)。该目录**独立于代码仓库**——改名/重装/重新 clone 代码都不影响登录态。

| 文件/目录                                     | 说明                                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `account.json`                                | Bot Token、botId、userId、baseUrl（POSIX 下权限 600；**Windows 下为明文**，见「安全说明」）                 |
| `state.json`                                  | 长轮询游标（`updatesBuf`）、各会话 `context_token`、`lastMessageId`（去重）                                 |
| `qr_login.json` / `qrcode.png` / `qrcode.txt` | 扫码登录临时态与二维码（登录后即失效）                                                                      |
| `brain-sessions.json`                         | `userId → ACP sessionId` 映射；daemon 重启后据此尝试 `session/load` 或 `session/resume` 恢复多轮上下文（agent 不支持则新建） |
| `brain-mcps.json`                             | brain 当前激活的 MCP 集（默认空）                                                                           |
| `brain-home/`                                 | brain 沙箱（由预设的 `homeEnvVar` 指向它；kiro 是 `KIRO_HOME`，opencode 是 `XDG_CONFIG_HOME`），含 agent 配置与 ACP 会话 |
| `worker-sessions.json`                        | worker（远程任务）单任务 `ACP sessionId` 映射，daemon 重启后据此 `load`/`resume` 续传                      |
| `worker-home/`                                | worker 沙箱（同 brain 机制；MCP 继承**全量除 `wechat`** ＋ 记忆/技能/settings）                              |
| `worker.pid`                                  | worker 大脑进程 pid（与 brain/用户会话区分、便于精确清理）                                                  |

**多账号**：每个微信账号一份独立子目录。用 `WECHAT_ACCOUNT=<名>` 切换（→ `~/.wemind/<名>/`），或用 `WECHAT_DATA_DIR=<完整路径>` 指定任意目录。不同账号 = 不同目录 = 完全隔离，可各自登录、各跑一个 daemon。

> **重置**：删 `account.json`+`state.json` = 退出登录重新扫码；删 `brain-sessions.json`+`brain-home/sessions/` = 清空对话记忆。

> 📄 **速查**：改数据目录 / 迁移数据 / 环境变量用法（`WEMIND_HOME`、`WECHAT_DATA_DIR` 等，含初次运行指定路径与运行后迁移） → [docs/速查-数据目录与环境变量.md](docs/速查-数据目录与环境变量.md)。

## 本地开发

```bash
git clone https://github.com/imwangpan/WeMind.git
cd WeMind
npm install
npm run build      # 按 core → daemon/mcp-server 顺序构建各包
npm start          # 运行 node packages/wechat-mcp/dist/index.js
npm test           # 运行单元测试
npm run dev -w @wemind/wechat-mcp   # tsx 热重载开发 mcp-server（可选）
```

## 安全说明

- **凭证存储**：`account.json` 含 Bot Token。POSIX 系统会设为权限 `600`；**Windows 上 `chmod` 无效，文件以明文存放且不受权限限制**——启动保存时会有一次性告警。请用文件夹权限或磁盘加密保护 `~/.wemind/default/` 目录。
- **隐私**：消息经由腾讯 iLink 渠道与本地 Agent 流转，涉及对话内容外发，请自行评估。

## 关于 iLink 渠道与限制

- 后端为腾讯官方 **iLink / 微信 ClawBot** 接口（`ilinkai.weixin.qq.com`），面向**个人微信账号**，区别于企业微信。按官方用途使用，不存在逆向 bot 那类封号风险。
- **不能主动发起对话**：只能在收到用户消息后、于该会话上下文内回复（发送依赖收消息得到的 `context_token`）。
- **服务稳定性**：这是腾讯新开放的插件功能，官方条款保留随时停服的权利，请勿用于关键业务。
- 需要较新的微信客户端并启用 ClawBot 插件。

## 守护进程（daemon）：脱离 IDE/终端常驻自动收发

> 📦 **作为 `wemind` CLI 使用**：本守护进程已打包为 **`wemind`** 命令（`wemind login` / `start` / `list` / `task`，常驻委托 pm2）——**尚未发布到 npm**，当前请按下文从源码运行（发布后 `npm i -g wemind` 即可全局使用）。面向最终用户的一步步指引见 **[新手教程](docs/新手教程.md)**。

`packages/wechat-daemon/` 提供一个独立守护进程：自己长轮询 iLink 收消息 →
调 **常驻 ACP agent**（JSON-RPC over stdio；未配置时 `auto` 探测 kiro/opencode/gemini/deepseek/qoder）当大脑生成回复 → 自动回发。
进程常驻、原生多轮记忆，回复从 `agent_message_chunk` 流式拼接（天然无 ANSI/工具旁白）；
带**存活检测**（进程不在自动重启）。它**只依赖内核包 `@wemind/wechat-ilink-core`**，不碰 MCP 那层，是一个完全独立、可单独运行的包。

```bash
npm run build
npm run daemon      # 前台运行；需先完成扫码登录（见上文）
```

> ⚠️ **安全（务必读）**：kiro 预设用 `--trust-all-tools`，意味着**任何能给这个微信 ClawBot 会话发消息的人，都能让 Kiro 在运行 daemon 的电脑上执行任意工具（含 shell / 写文件）**。其它 agent 的批准策略不同，但同理要假设「它能执行工具」。
> 唯一的安全闸是**发件人授权**：daemon 默认只处理**已授权用户**的消息，其余忽略。**不要关掉它。**
>
> **配对授权（allowFrom）**：授权用户存于每账号的 `~/.wemind/<account>/allowFrom.json`。**扫码登录者会被自动授权**（`finalize`/`adopt` 时加入；daemon 启动也会把账号本人种入，老账号自动迁移），通常**无需任何手动配置**。管理命令：`allowlist <key|label>` 查看、`allow <key|label> <userId>` 授权、`revoke <key|label> <userId>` 撤销（增删即时生效，无需重启 daemon）。鉴权 = 账号本人(始终允许) 或 在 allowFrom 中；`WECHAT_OWNER_ID` 仍可作覆盖。

环境变量：

| 变量                                                    | 说明                                                                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `WECHAT_OWNER_ID`                                       | 发件人授权覆盖（默认登录账号本人 user id；常规用配对授权 allowFrom，见上）                                                          |
| `WECHAT_ACCOUNT`                                        | 账号标识，决定状态子目录 `~/.wemind/<account>/`（默认 `default`）。多账号用不同值隔离                                               |
| `WECHAT_DATA_DIR`                                       | 直接指定完整状态目录路径，覆盖 `~/.wemind/<account>` 规则                                                                           |
| `WEMIND_HOME`                                           | 数据根目录（默认 `~/.wemind`）                                                                                                      |
| `WECHAT_BRAIN_HOME`                                     | brain 沙箱目录（默认 `<数据目录>/brain-home`）                                                                                      |
| `WECHAT_BRAIN_IDLE_MS` / `WECHAT_BRAIN_CAP_MS`          | 大脑单回合空闲/硬超时（默认 120000 / 900000；重任务实测需 ~6.5min）                                                                 |
| `WECHAT_BRAIN_FIRST_FRAME_MS`                           | 首帧超时：prompt 发出后多久仍无任何帧判「开局即卡死」并快速重试（默认 25000）                                                       |
| `WECHAT_CONSEC_SEND_LIMIT`                              | bot 在用户回复前可连续发送的消息数上限（默认 10）。达「上限-2」后发提示并等待「继续」，留最后一条给答案                             |
| `WECHAT_MIN_SEND_GAP_MS`                                | 两条发送之间的最小间隔，规避发送限流（默认 1500）                                                                                   |
| `WECHAT_REPLY_FILE_THRESHOLD`                           | 回复正文超过此字符数则转 .md 文件发送（默认 1500）                                                                                  |
| `WEMIND_ILINK_BASE`                                     | iLink API / 登录基础 URL（默认 `https://ilinkai.weixin.qq.com`）                                                                    |
| `WECHAT_CDN_BASE_URL`                                   | 媒体 CDN 基础 URL（默认 `https://novac2c.cdn.weixin.qq.com/c2c`）                                                                   |
| `ILINK_CLIENT_VERSION`                                  | 对外声明的 iLink 客户端版本（默认 `2.4.3`，随官方升级可改，免动代码）                                                               |
| `ILINK_APP_ID`                                          | iLink App Id（默认 `bot`）                                                                                                          |
| `WEMIND_WORKER_CWD`                                     | worker（远程任务）工作目录（默认用户主目录；本地命令派发后可取命令所在目录）                                                        |
| `WEMIND_WORKER_HOME`                                    | worker 沙箱配置目录（默认 `<数据目录>/worker-home`）                                                                                |
| `WEMIND_WORKER_MCP_EXCLUDE`                             | worker 不继承的 MCP（逗号分隔；`wechat` 始终强制排除，防回环）                                                                      |
| `WEMIND_WORKER_IDLE_MS` / `_CAP_MS` / `_FIRST_FRAME_MS` | worker 单轮空闲/硬上限/首帧超时（默认 180000 / 1800000 / 30000，比对话大脑宽松）                                                    |
| `WEMIND_WORKER_PROGRESS`                                | 是否推送 worker 全程文字进度（默认 `0` 安静；`1` 开启。「正在输入中」始终有）                                                       |
| `WEMIND_TASK_SCAN_MS`                                   | daemon 扫描本地命令收件箱 `task-inbox/` 的间隔毫秒（默认 1000）                                                                     |
| 大脑 agent 选择 / 记忆继承                              | 见下方「切换大脑 Agent」与 [docs/接入其它-ACP-Agent.md](docs/接入其它-ACP-Agent.md)（`WEMIND_BRAIN*`、`WEMIND_BRAIN_REAL_HOME` 等） |

限制：

- **只在电脑开机且 daemon 运行时在线**（不是云端常驻）；
- **不能主动发起对话**（iLink 限制），需你先发消息；
- iLink 会话超时（errcode `-14`）会进入 1 小时冷却，重发消息恢复。

### 远程任务（worker）：把漫长任务交给微信遥控

> 📖 完整使用方法（微信 + 本地终端两入口、典型流程、FAQ）见 **[docs/使用指南-远程任务（worker）.md](docs/使用指南-远程任务（worker）.md)**。

除了「对话大脑」，daemon 还能把**漫长任务**交给一个**受控的 ACP worker 进程**跑——你在电脑上派发任务后离开，它在「需要你决策」（如列方案让你选）或「中断」时把情况推到微信，你回一句就能让它续跑（远程 human-in-the-loop）。

worker 与对话大脑是**两个独立的 ACP 进程，互不干扰**；worker 跑在任务工作目录、继承所用 agent 真实配置目录的**全量 MCP（除 `wechat`）＋ 记忆/技能/模型**（kiro 即 `~/.kiro`，opencode 即 `~/.config/opencode`）。

**指令集**：

| 你发的消息                        | 去向                                                               |
| --------------------------------- | ------------------------------------------------------------------ |
| `任务：xxx` / `>xxx`              | 明确发给 worker：没任务时**启动**新任务，有任务时**追加/回复**给它 |
| `问大脑 xxx`                      | 明确发给对话大脑（worker 正等你时也能临时插话问大脑）              |
| `结束任务` / `停止任务`           | 终止当前 worker 任务                                               |
| worker 刚问你后，直接回（无前缀） | 注入 worker（最自然的决策回复）                                    |
| worker 埋头跑时，直接发（无前缀） | 走对话大脑（任务不受影响）                                         |

- worker 只在 **waiting（刚停下问你）** 时才默认接管你的无前缀消息；它埋头跑时大脑照常可用。
- worker 每轮输出带 `🤖【任务】` 标记；跑一轮期间持续「正在输入中」（typing 不占连续发送上限）。
- 中断（崩溃/超时）靠 `session/load`（不支持时 `session/resume`）恢复——回「继续」即从中断处续跑；两者都不可用时只能重开。
- 详见 [docs/方案C-MVP-远程human-in-the-loop.md](docs/方案C-MVP-远程human-in-the-loop.md)。

**本地终端入口**（与微信并列、管同一任务，**不依赖微信**）：在电脑前用 `wemind` 直接管 worker 任务，适合开任务时贴长描述 / 指定工作目录，或专注电脑工作不想掏手机时。

| 命令（`wemind …`）                            | 作用                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `task "<描述>" [--cwd <目录>] [<key\|label>]` | 本地派发任务（默认 cwd=终端当前目录，可指定项目目录——微信入口做不到） |
| `task-status [<key\|label>]`                  | 查看任务状态 + 轮次 + 最近输出（读本地 `task-state.json`）            |
| `task-reply "<内容>" [<key\|label>]`          | 回复/注入当前任务（`task-reply 继续` = 续跑）                         |
| `task-stop [<key\|label>]`                    | 结束当前任务                                                          |

机制为**文件桥**：CLI 原子写 `task-inbox/*.json`，daemon 独立定时器扫描分发到同一套 task-manager，状态写 `task-state.json` 供 `task-status` 读。详见 [docs/本地双入口-命令派发与看敲.md](docs/本地双入口-命令派发与看敲.md)。

### 进度提示与连续发送上限

iLink 限制 bot 在用户回复前能**连续发送的消息数**（实测约 10；超出服务端以 `ret=-2` 拒绝，导致消息丢失）。daemon 据此管理发送：

- **进度/状态消息**（都计入上限）：`🤖 收到，正在处理…`（即时回执）→ `🔧 步骤 N：…`（工具调用，首条即发、其后每 ≥15s 一条）→ `🤔 还在思考/检索中…`（静默满 15s 第 1 次）→ `⏳ 仍在处理中…（已 X 秒）`（静默第 2 次起）→ `✍️ 正在整理回复…`（开始输出正文）。"正在输入中"（typing）**不计入**上限。
- **接近上限**：发到「上限-2」（默认第 8 条）仍无最终答案时，第 9 条改发 `⚠️ 接近微信连续消息上限…回复「继续」`，随后暂停进度（靠 typing 撑存活）、把最后一条额度留给最终答案。
- **「继续」**：回复「继续」即重置配额、恢复发送（长任务可多次）。**你发任何消息都会重置**该计数（服务端按"距上一条用户消息"计数）。
- 相关变量：`WECHAT_CONSEC_SEND_LIMIT`（默认 10）、`WECHAT_MIN_SEND_GAP_MS`（默认 1500，两条发送最小间隔）。
- 超长任务需放宽大脑超时：`WECHAT_BRAIN_CAP_MS`（默认 15min）、`WECHAT_BRAIN_IDLE_MS`（默认 120s）。

### MCP 沙箱与对话式加载

brain 跑在独立的 `KIRO_HOME` 沙箱（`WECHAT_BRAIN_HOME`）里，**默认不加载任何 MCP**——既快又杜绝 `wechat` 自身回环（内置工具如 `web_search` 仍可用）。

> **继承你的记忆与规则**：沙箱会用目录 junction 把所用 agent 真实配置目录里的「知识/记忆」类子目录链进来，让微信里的大脑和你日常使用读到**同样的记忆、规则、技能**。`settings/` 里**除 `mcp.json` 外**的文件（尤其 `cli.json`，含 `chat.defaultModel` 等——这决定大脑用哪个模型！）也会同步过来，**只有 `mcp.json` 隔离 curated**（防 `wechat` 回环）；`sessions`（brain 自有会话）保持沙箱本地。**按 agent 配置驱动**（`brain-agents.ts` 预设的 `realHome`/`inheritDirs`）：kiro 已预置（继承 `~/.kiro` 的 `steering`/`memories`/`skills`/`agents`/`powers`/`tasks`/`extensions` + `settings`(非 mcp)）；非空目录（如 kiro 自建 agents 脚手架）会补拷缺失文件。其它 agent 记忆机制不同，默认不继承，需要时填预设或用 `WEMIND_BRAIN_REAL_HOME`/`WEMIND_BRAIN_INHERIT_DIRS` 配置。`WEMIND_BRAIN_INHERIT=0` 可关闭。**注意：换模型后旧 ACP 会话可能仍绑旧模型，需在微信发「新会话」重建。** 需要某个 MCP 时，直接**在微信里发指令**（daemon 拦截处理，不进 brain）：

| 指令                        | 作用                                            |
| --------------------------- | ----------------------------------------------- |
| `MCP` / `列出 MCP`          | 列出可选 MCP（来自全局 `mcp.json`）与当前已激活 |
| `加载 <名>` / `load <名>`   | 把指定 MCP 加入激活集（`wechat` 永久禁止）      |
| `卸载 <名>` / `unload <名>` | 移除                                            |
| `新会话` / `重置` / `/new`  | 开启新 ACP 会话（清空多轮上下文）               |

加载/卸载 MCP 后 daemon 会**重启 ACP 进程**以按新沙箱配置重载，下一条消息生效。激活的 MCP 等于对白名单发件人全权开放（kiro 预设是 `--trust-all-tools`；其它 agent 按其批准策略），按需加载、用完可卸载。

### 切换大脑 Agent（通用化）

daemon 的大脑通过 **ACP（Agent Client Protocol，JSON-RPC over stdio）** 驱动，未配置时默认 `auto`（按 `kiro → opencode → gemini → deepseek → qoder` 探测已安装者）。**多数原生 ACP agent 可以零代码接入**；但若它缺 `session/load`、会发反向请求、没有 activity 帧或图片能力不同，就需要协议层适配（见 `packages/wechat-daemon/src/brain-agents.ts` 与 [docs/接入其它-ACP-Agent.md](docs/接入其它-ACP-Agent.md) §9）。

| 环境变量                | 作用                                                | 默认         |
| ----------------------- | --------------------------------------------------- | ------------ |
| `WEMIND_BRAIN`          | 选预设（如 `kiro`、`opencode`、`auto`）             | `auto`       |
| `WEMIND_BRAIN_BIN`      | 覆盖二进制（绝对路径或 PATH 上的名字）              | 预设自动解析 |
| `WEMIND_BRAIN_ARGS`     | 覆盖进入 ACP 模式的启动参数（空格分隔）             | 预设值       |
| `WEMIND_BRAIN_HOME_ENV` | 覆盖「agent 配置目录环境变量名」（指向 brain 沙箱） | 预设值       |
| `KIRO_CLI_BIN`          | 旧的 kiro 专用二进制覆盖（仍兼容）                  | —            |

`kiro` 预设 = `kiro-cli acp --trust-all-tools` + `KIRO_HOME` 指向沙箱。要接入新 agent，在 `ACP_AGENT_PRESETS` 加一条预设、或直接用上面四个变量。**ACP 是「最小方法集」而非完全统一**：`session/load`、`session/resume`、`image`、MCP 传输、反向请求都按 agent 而异，接入前先跑能力探针。

> 详细步骤、各 agent 需确认的 4 件事、MCP 沙箱差异、验证方法见 [docs/接入其它-ACP-Agent.md](docs/接入其它-ACP-Agent.md)。
>
> **OpenCode 已内置预设**：`WEMIND_BRAIN=opencode` 即可让 `opencode acp` 当大脑（自动用 `XDG_CONFIG_HOME` 隔离配置目录、curated MCP、继承记忆/技能）。完整设计、M1 实测与风险见 **[docs/接入-OpenCode.md](docs/接入-OpenCode.md)**。
>
> **DeepSeek 已接入（官方 DSH，微信 brain + worker E2E 已通）**：`wemind brain set deepseek --bin "<...>\dsh.cmd"` 即用 `dsh --profile acp` 当大脑；预设已处理 `DSH_HOME` 沙箱、`.credentials.yaml`、`model=deepseek-account/deepseek-flash`、`session/resume`、**动态 MCP（`加载/卸载` 经 ACP `mcpServers` 生效）**、图片拦截。实测与限制见 **[docs/接入-DeepSeek.md](docs/接入-DeepSeek.md)**，M3–M5 结果见 **[docs/待办-DeepSeek-M3-M5.md](docs/待办-DeepSeek-M3-M5.md)**。

> **Qoder 已内置预设（M1 已完成）**：`wemind brain set qoder` 即用 `qodercli --acp --yolo` 当大脑；预设处理 `QODER_CONFIG_DIR` 沙箱、`.auth/user` + `.auth/machine_id` 登录态同步、`settings.json` 基底（剥离 `providers`/`model`、关自动更新）、文件式 MCP。需先 `qoder login`。实测与限制见 **[docs/接入-Qoder.md](docs/接入-Qoder.md)**。

### 收发图片

- **收图**（用户发图 → 大脑看图）：daemon 下载并 AES-128-ECB 解密入站图片，作为 ACP image 块喂给大脑——**前提是该 agent `initialize` 广告了 `promptCapabilities.image:true`**（kiro/opencode 支持；DSH 官方 0.2.1-rc.2 实测为 `false`，带图会 `-32602`）。
- **发图**（大脑发图 → 用户）：大脑在回复里用 **Markdown 图片语法 `![](图片的 http 链接或本地文件绝对路径)`**，或直接给出**裸图片 URL**，daemon 会自动把它下载/读取后作为图片消息发出，并把剩余文字另发。大脑本身不会文生图，但能发：联网搜到的图、本地已有的图、自己用代码渲染保存的图表。底层走 `getUploadUrl` + AES-128-ECB 加密上传 CDN（`no_need_thumb`，免缩略图）。
- **发文件 / 视频**：core `sendFile` 按扩展名自动判类型（图/视频/文件），组装 `image_item / video_item / file_item`，上传链路与发图同构。
- **收语音**（语音输入）：用户发语音 → 直接取 `voice_item.text`（微信侧已做语音转文字）当文本喂大脑，**零依赖**（无需 SILK 解码/外接 ASR）。**发语音**（bot 语音回复）暂不做（需 TTS + SILK，且语音回复体验通常不如文本）。

### 长回复自动转 .md 文件

- 当大脑最终回复正文**超过阈值**（默认 1500 字，`WECHAT_REPLY_FILE_THRESHOLD` 可覆盖）时，daemon 不再把长文拆成多条文本，而是作为**单个 `.md` 文件**发送：一条消息、规避连续发送上限、阅读完整。
- 文件名由**内容生成合适标题**（取首个 Markdown 标题或首个非空行，清洗为合法文件名）；正文若无标题则在文件内前置一个 H1。发文件失败时**兜底回退为文本**。

### Windows 登录自启

优先用计划任务（PS7 全路径、登录触发、崩溃重拉由 `scripts/run-daemon.ps1` 的循环负责）：

```powershell
$pwsh = "C:\Program Files\PowerShell\7\pwsh.exe"
$wrapper = "<仓库绝对路径>\scripts\run-daemon.ps1"
$action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapper`""
Register-ScheduledTask -TaskName "wemind-daemon" -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew) -Force
```

若环境禁止创建计划任务（提示「拒绝访问」），改用**启动文件夹**自启：在
`shell:startup`（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`）放一个
`.vbs`，用 `WScript.Shell.Run` 以隐藏窗口调用上面的 `pwsh ... -File scripts/run-daemon.ps1`。

> **注意 · node 由版本管理器管理时**：若 `node` 由 **fnm / nvm / Volta** 这类「只往交互 shell 注入 PATH」的工具管理，登录任务/服务（`-NoProfile`、无 shell 注入）的持久 PATH 里通常**没有 node**：wrapper 会找不到它，且 daemon 拉起的大脑（如 `opencode acp`）也解析不到。`scripts/run-daemon.ps1` 已内置回退（fnm `%APPDATA%\fnm\aliases\default`、Volta、`C:\Program Files\nodejs`）并把命中目录**前置进 PATH**；若安装位置不在其中，请改脚本候选或直接用绝对路径的 node 启动。另：PS7 若只以 WindowsApps 别名存在（无 `C:\Program Files\PowerShell\7\pwsh.exe`），优先走上面的 VBS 退路。

> 常驻底层原理（三层进程树、wrapper 看门狗循环、单实例 Mutex、开机自启、多账号隔离、pid 链与故障恢复）详见 [docs/daemon-常驻原理.md](docs/daemon-常驻原理.md)。
>
> **跨平台（Windows/Linux/macOS）常驻**：用 pm2 + 根目录 `ecosystem.config.cjs` 即可，详见 [docs/跨平台常驻-pm2.md](docs/跨平台常驻-pm2.md)。上面的 PowerShell 方案为 Windows 专用，二者对同一账号**只用一套**。

## 多账号管理

支持登录多个微信账号，每个账号一份独立目录 `~/.wemind/<key>/`，`key` 由微信 **botId** 派生（唯一、自动获取；当前 iLink 接口不返回昵称/微信号，故用 botId，另存可编辑的 `label` 别名）。账号清单记录在 `~/.wemind/accounts.json`。不同账号 = 不同 token = 各跑一个 daemon，互不冲突。

> **key vs label**：`key`（botId 派生）是唯一标识、也是目录名，系统据它区分；`label` 是人类可读别名（可改、可重复）。下列命令多数 **可用 key 或 label 选择账号**（label 唯一匹配时）。

**新增一个账号（推荐：一条命令）** —— 在终端跑：

```powershell
wemind login --label 工作号 --start
```

它会：自动生成二维码（**过期自动刷新**、终端直接显示 + 自动打开 PNG）→ 你用要登录的微信扫码确认 → 自动按 botId 归档登记 → `--start` 顺带启动该账号 daemon。整条命令在你终端里跑，二维码原生渲染、不怕过期。

管理命令（`wemind <command>`）：

| 命令                           | 作用                                                                    |
| ------------------------------ | ----------------------------------------------------------------------- |
| `login [--label 名] [--start]` | **一条命令完成扫码登录**：自刷新二维码 + 自动归档（`--start` 顺带启动） |
| `list`                         | 列出账号、别名、botId、运行状态                                         |
| `start <key\|label>`           | 启动某账号的 daemon                                                     |
| `logout <key\|label>`          | 停 daemon + 通知下线 + 清凭证（保留目录，可重登）                       |
| `delete <key\|label>`          | 停 daemon + 删除目录 + 移除注册                                         |
| `label <key\|label> <新别名>`  | 改别名                                                                  |
| `set-default <key\|label>`     | 设默认账号                                                              |
| `adopt <key> [--label 名]`     | 把已存在的账号目录登记进注册表                                          |
| `allowlist <key\|label>`       | 查看该账号的授权用户清单（allowFrom）                                   |
| `allow <key\|label> <userId>`  | 授权某用户可驱动该账号 bot                                              |
| `revoke <key\|label> <userId>` | 撤销某用户的授权                                                        |

**自启全部账号**：`scripts/run-all-daemons.ps1` 读注册表为每个账号起一个 daemon（各账号单实例守卫，重复运行安全）。Windows 启动文件夹的 VBS 已指向它，开机自动拉起所有已登记账号。

## 致谢

- Fork 自 [Howardzhangdqs/mcp-wechat-server](https://github.com/Howardzhangdqs/mcp-wechat-server)（MIT）。
- iLink 协议细节、session-guard 与上下线通知实现借鉴自微信官方插件 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）。

## 许可证

[MIT](LICENSE) —— 沿用原项目 [Howardzhangdqs/mcp-wechat-server](https://github.com/Howardzhangdqs/mcp-wechat-server)（同为 MIT）。
