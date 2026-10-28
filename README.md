# WeMind

> _Your AI mind, reachable on WeChat. —— 你的 AI 大脑，在微信上随时可达。_

WeMind 让任何 AI Agent 都能通过「个人微信」收发消息。它把腾讯官方的 iLink / 微信 ClawBot 渠道封装成两种可消费形态（均已发布到 npm）：一个 MCP Server 子包（`@wemind/wechat-mcp`），和一个常驻守护进程（`@wemind/cli`）。

| 形态 | 怎么装 | 适合 |
| --- | --- | --- |
| **MCP Server**（`wemind-mcp`） | `npx -y @wemind/wechat-mcp` | 在 Claude Desktop / Cursor / OpenCode / Kiro 等已有客户端里让 AI 收发你的微信 |
| **常驻守护进程**（命令 `wemind`） | `npm i -g @wemind/cli` | 要一个自己常驻、7×24 自动回复、还能远程派任务的微信 AI 助手 |

```bash
# 常驻守护进程的典型三步
npm i -g @wemind/cli
wemind login --label 主号 --start    # 微信扫码登录 + 启动常驻
wemind list                          # 查看运行状态
```

> ⚠️ **一个 bot token 只能有一个消费者**：两种形态别同时跑，否则互相抢消息。
> ⚠️ **包名 ≠ 命令名**：装 `@wemind/cli`，敲 `wemind`；`npx` 必须写全包名（`npx -y @wemind/cli`）。

**下一步**：**[新手教程](docs/新手教程.md)**（从零开始，含扫码、开机自启、常见问题）｜ **[安装详解](#安装两种形态二选一)** ｜ 遇到问题看 [常见问题](#常见问题)

### AI 大脑：能接什么 agent

常驻助手需要一个「大脑」——一个**实现 ACP 协议的命令行程序**。内置预设已覆盖 `kiro` / `opencode` / `gemini` / `deepseek`（DSH）/ `qoder`，未配置时按此顺序自动探测。判断某个 agent 能不能用：

| 必要条件 | 说明 | 不满足怎么办 |
| --- | --- | --- |
| 有**可执行入口** | 终端里能直接跑起来，daemon 才能把它启动为子进程 | 纯 HTTP API（OpenAI / Anthropic / Ollama）没有进程可启动，**目前接不了** |
| **实现 ACP**，或有 **ACP 适配器** | 原生：kiro / opencode / gemini / DSH / Qoder；需适配器：Claude Code、Codex | 找一个适配器（如 `claude-code-acp`）即可，无需改 WeMind |
| 覆盖**最小方法集** | 至少 `initialize` + `session/new` + 能流式回包的 `session/prompt` | 跑 `wemind brain check` 实测；缺失即不可用 |
| 能**完成认证** | 模型/登录态就绪，二进制在 PATH 上或用 `--bin` 指定 | 配 `wemind brain set <预设> --bin "<绝对路径>"` |

```bash
wemind brain                 # 看当前用的是哪个大脑
wemind brain check           # 真起一次 ACP 握手，验证能不能用
wemind brain set qoder       # 换大脑（按账号落盘，重启仍生效）
wemind brain switch opencode # 热切换：daemon 在跑就不重启、不打断在途回合；失败自动回滚
wemind session list          # 会话列表（新会话 / 恢复会话 / 重命名 / 删除同名子命令）
```

> **「支持 ACP」不等于能用**：`session/load`、`session/resume`、图片输入、MCP 传输、反向请求都是**可降级项**，各家实现差别很大。完整判断流程、各 agent 实测结论见 **[docs/接入其它-ACP-Agent.md](docs/接入其它-ACP-Agent.md)**。

## 📖 文档导航

按你的身份选入口：

| 你是 | 从这里开始 |
| --- | --- |
| **第一次用** | [新手教程](docs/新手教程.md) —— 一步步搭起你的微信 AI |
| **想直接上手配置** | [安装（两种形态）](#安装两种形态二选一) · [MCP 客户端配置](#快速开始) · [挂到 Claude Desktop](#claude-desktop) · [挂到 Cursor](#cursor--其他-mcp-客户端) |
| **想换 AI 大脑** | [切换大脑 Agent](#切换大脑-agent通用化) · [接入其它 ACP Agent](docs/接入其它-ACP-Agent.md) · [OpenCode](docs/接入-OpenCode.md) · [DeepSeek](docs/接入-DeepSeek.md) · [Qoder](docs/接入-Qoder.md) |
| **想用远程任务** | [使用指南-远程任务](docs/使用指南-远程任务（worker）.md) · [本地双入口](docs/本地双入口-命令派发与看敲.md) |
| **运维 / 部署** | [部署与运维](docs/repowiki/10-部署与运维.md) · [跨平台常驻（pm2）](docs/跨平台常驻-pm2.md) · [数据目录与环境变量速查](docs/速查-数据目录与环境变量.md) |
| **想改这个仓库 / 贡献代码** | [开发指南](docs/repowiki/11-开发指南.md) · [系统架构](docs/repowiki/02-系统架构.md) · [发布流程](docs/发布-wemind-npm.md) |
| **AI 编码助手**（帮我改这个仓库的 agent） | 先读 [AGENTS.md](AGENTS.md) → [docs/ai/README.md](docs/ai/README.md)（含术语表与任务配方） |

深入架构、协议与运行机制：[docs/repowiki/](docs/repowiki/README.md) —— 依据源码整理的完整技术 wiki（含 Mermaid 图）。

| 入口                                                     | 内容                                                    |
| -------------------------------------------------------- | ------------------------------------------------------- |
| [AGENTS.md](AGENTS.md)                                   | **AI 编码助手入口**：30 秒定位、硬约束、改哪里、已知坑 |
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

- **6 个 MCP 工具**：`login_qrcode`（取登录二维码）· `check_qrcode_status`（查扫码状态）· `logout`（登出并清凭证）· `get_messages`（长轮询收消息）· `send_text_message`（发文本）· `send_typing`（打字状态）
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
| `@wemind/cli`               | `packages/wechat-daemon`     | 独立常驻守护进程：长轮询 + 常驻 ACP 大脑自动收发                                             | **已发布**（命令 `wemind`）     |

> 📌 上表「发布」列指的是**该子包**是否发布到 npm：对外发布的是 `@wemind/wechat-mcp`（MCP 形态）与 `@wemind/cli`（完整应用 CLI，命令 `wemind`）两个入口。两者共用同一个 bot token 时**只能二选一**。

`mcp-server` 与 `@wemind/cli` 发布时都用 [tsdown](https://tsdown.dev/)（rolldown + oxc）把 `core` **内联**进单一产物，因此对外只需发布这一个自包含的包；`core` 本身 `private: true`，永不单独发布。发布流程见 [`.github/workflows/wemind-publish.yml`](.github/workflows/wemind-publish.yml) 与 [`docs/发布-wemind-npm.md`](docs/发布-wemind-npm.md)。

## 安装（两种形态，二选一）

| 形态 | 安装 | 命令 | 适用 |
| --- | --- | --- | --- |
| ① MCP Server | `npx -y @wemind/wechat-mcp` | `wemind-mcp` | 已有 AI 客户端（Claude Desktop / Cursor / OpenCode / Kiro） |
| ② 常驻 daemon | `npm i -g @wemind/cli` | `wemind` | 想要一个自己跑、7×24 自动收发 + 远程任务的助手 |

```bash
# ② 常驻助手的典型三步（包名 @wemind/cli，命令是 wemind）
npm i -g @wemind/cli
wemind login --label 主号 --start   # 扫码登录 + 启动常驻
wemind list                          # 查看账号与运行状态
```

> ⚠️ **包名 ≠ 命令名**：装的是 `@wemind/cli`，敲的是 `wemind`。因此 `npx` 必须写全包名（`npx -y @wemind/cli list`），`npx wemind` 不可用；`npm i -g` 后不受影响。
>
> 两个包都发布在 npm：<https://www.npmjs.com/package/@wemind/cli> ｜ <https://www.npmjs.com/package/@wemind/wechat-mcp>

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

| 工具                  | 说明                                                      | 代码 description（注册原文节选）                                                                                                                                                                        |
| --------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login_qrcode`        | 取登录二维码（返回 URL，并在数据目录生成 PNG 与终端文本） | Get a WeChat login QR code. Scan it with WeChat to connect the bot. … You MUST show all three returned forms (image URL / PNG file / terminal text file) to the user.                                   |
| `check_qrcode_status` | 查扫码状态（轮询到 `confirmed` 即登录成功）               | Check whether the QR code from `login_qrcode` has been scanned and confirmed. … If it returns `need_verifycode` or an IDC-redirect status, tell the user to run the `wemind login` CLI command instead. |
| `logout`              | 登出并清除已保存的凭证                                    | Log out the current WeChat bot session. … Clears saved credentials, runtime state and any pending QR login. Only call this when the user asks to log out or wants to switch accounts.                   |
| `get_messages`        | 长轮询收消息（`wait=true` 阻塞直到收到）                  | Poll for new WeChat messages. Always call with `wait=true` to block until a message arrives.（后接 4 步 typing 工作流）                                                                                 |
| `send_text_message`   | 发文本消息                                                | Send a text message to a WeChat user. … iLink bots cannot initiate conversations: if you have never received a message from that user, this call fails.                                                 |
| `send_typing`         | 打字状态（`typing` 显示 / `cancel` 取消）                 | Show or cancel the "typing..." indicator for a WeChat user. … Re-send status `typing` every 15-20 seconds while still working, because the indicator expires on its own.                                |

> description 取自 `packages/wechat-mcp/src/index.ts` 的 `registerTool` 第二参数；`…` 为节选标记（完整原文见源码，仅给代码标识符补了反引号）。
> 6 个工具的 description **一律写英文**——MCP 生态惯例，且模型对 `MUST` / `wait=true` 这类强制约束的英文原文遵循度更高。用户能看到的提示文案在 `tools/*.ts` 的 `message` 字段，均为中文。
> `get_messages` 的完整描述是一段 4 步 `send_typing` 编排指引（收到消息即 `typing`、处理中每 15–20s 续发、回复后 `cancel`），与上文「开始聊天」的流程一致。

## 数据存储

运行时状态保存在 **`~/.wemind/<account>/`** 下(默认账号 `default`，即 `~/.wemind/default/`)。该目录**独立于代码仓库**——改名/重装/重新 clone 代码都不影响登录态。

| 文件/目录                                     | 说明                                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `account.json`                                | Bot Token、botId、userId、baseUrl（POSIX 下权限 600；**Windows 下为明文**，见「安全说明」）                 |
| `state.json`                                  | 长轮询游标（`updatesBuf`）、各会话 `context_token`、`lastMessageId`（去重）                                 |
| `qr_login.json` / `qrcode.png` / `qrcode.txt` | 扫码登录临时态与二维码（登录后即失效）                                                                      |
| `brain-sessions.json`                         | `<agent>:<userId> → ACP sessionId` 映射（按大脑分命名空间，切换 agent 互不覆盖）；daemon 重启后据此尝试 `session/load` 或 `session/resume` 恢复多轮上下文（agent 不支持则新建） |
| `brain-mcps.json`                             | brain 当前激活的 MCP 集（默认空）                                                                           |
| `brain-home/`                                 | brain 沙箱（由预设的 `homeEnvVar` 指向它；kiro 是 `KIRO_HOME`，opencode 是 `XDG_CONFIG_HOME`），含 agent 配置与 ACP 会话 |
| `worker-sessions.json`                        | worker（远程任务）`ACP sessionId` 映射（键 `<agent>:task-<编号>@<userId>`），任务中断后据此 `load`/`resume` 续跑 |
| `worker-home/`                                | worker 沙箱（同 brain 机制；MCP 继承**全量除 `wechat`** ＋ 记忆/技能/settings）                              |
| `workers.pid.json`                            | worker 进程池的**身份记录数组**（每条的 pid / agent / 真实 bin+args / busy\|idle / 任务编号）；`wemind stop` 一次杀光全部，旧账号的裸整数 `worker.pid` 仍兼容读取 |
| `session-registry.json`                       | 会话**登记表**（名字/标题/轮次/最近使用；最多 50 条/人·大脑）——只供列表展示，「当前是哪个」的唯一权威仍是 `brain-sessions.json` |
| `tasks.json`                                  | 任务表（编号/agent/状态/轮次/cwd/最近输出），用于**重启后续跑**：未完成的标「已中断」，回「继续」才续跑；损坏则降级为空表 |
| `handoff.json`                                | 交接摘要（`交接` 生成；TTL 24h，切到别的大脑后第一条消息注入一次即消费）                                     |
| `control-inbox/` `control-out/`               | CLI ↔ daemon **控制桥**（CLI 写请求、daemon 写应答）；`control-out/.bridge` 记着 daemon 自己的 pid——对不上说明它在跑旧版本 |
| `brain.pid` / `daemon.pid`                    | 进程身份的 JSON 记录（含起进程时**真实用的** bin/args）/ 裸整数 pid（供 `wemind list/stop` 精确识别与清理） |
| `pm2.app.json`                                | **仅 `--runner pm2`**：pm2 的 app 声明（5s 重拉 / 最多 50 次 / 退出码 78 停手 / 日志合并到 `daemon.log`）    |

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

> 📦 **作为 `wemind` CLI 使用**：本守护进程已发布为 **`@wemind/cli`**，装完得到 **`wemind`** 命令（`wemind login` / `start` / `list` / `task`；常驻默认用自带看门狗，也可 `--runner pm2`）。`npm i -g @wemind/cli` 后即可全局使用；包名与命令名不同，`npx` 请写 `npx -y @wemind/cli`。发布与版本约定见 [`docs/发布-wemind-npm.md`](docs/发布-wemind-npm.md)；也可以按下文从源码运行。面向最终用户的一步步指引见 **[新手教程](docs/新手教程.md)**。

`packages/wechat-daemon/` 提供一个独立守护进程：自己长轮询 iLink 收消息 →
调 **常驻 ACP agent**（JSON-RPC over stdio；未配置时 `auto` 探测 kiro/opencode/gemini/deepseek/qoder）当大脑生成回复 → 自动回发。
进程常驻、原生多轮记忆，回复从 `agent_message_chunk` 流式拼接（天然无 ANSI/工具旁白）；
带**存活检测**（进程不在自动重启）。运行时只依赖第三方 `qrcode`（登录画码时才加载），内核 `@wemind/wechat-ilink-core` 已内联进产物，不碰 MCP 那层，是一个完全独立、可单独运行的包。

```bash
# 方式一：装好的 CLI（推荐最终用户）
npm i -g @wemind/cli    # 装完命令是 wemind
wemind login --label 主号 --start    # 扫码登录 + 启动常驻
wemind list                          # 账号与运行状态
wemind brain check                   # 验证大脑能说 ACP

# 方式二：从源码跑（开发者）
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
| `WEMIND_WORKER_BRAIN`                                   | 默认任务大脑（预设名；未设则回落 `WEMIND_BRAIN`。两者都是**一次性覆盖**，会压过 brain.json 里的 `worker.agent`）                     |
| `WEMIND_MAX_WORKERS` / `WEMIND_IDLE_MAX`                | 同时运行的任务数上限（默认 3）/ 池中保留的空闲进程数（默认 2）                                                                      |
| `WEMIND_WORKER_REAP_MS`                                 | 空闲 worker 进程回收时间（默认 300000，即 5 分钟；**注意不是** `WEMIND_WORKER_IDLE_MS`——那是单轮 prompt 空闲超时）                   |
| `WEMIND_WORKER_PROGRESS`                                | 是否推送 worker 全程文字进度（默认 `0` 安静；`1` 开启。「正在输入中」始终有）                                                       |
| `WEMIND_TASK_SCAN_MS`                                   | daemon 扫描本地命令收件箱 `task-inbox/` 与控制桥 `control-inbox/` 的间隔毫秒（默认 1000）                                          |
| `WEMIND_SWITCH_DRAIN_MS` / `WEMIND_SWITCH_TIMEOUT_MS`   | 热切换：等在跑的回合结束的上限（默认 30000）/ 新大脑预热（`initialize` + 会话）硬上限（默认 120000）                                 |
| `WEMIND_CONTROL_TIMEOUT_MS`                             | CLI 等 daemon 回话的上限（默认 30000；`brain switch` 自动放大到 warm+drain+15s）                                                    |
| `WEMIND_HANDOFF_TTL_MS`                                 | 交接摘要的有效期（默认 86400000，即 24h；过期不注入）                                                                               |
| 大脑 agent 选择 / 记忆继承                              | 见下方「切换大脑 Agent」与 [docs/接入其它-ACP-Agent.md](docs/接入其它-ACP-Agent.md)（`WEMIND_BRAIN*`、`WEMIND_BRAIN_REAL_HOME` 等） |

限制：

- **只在电脑开机且 daemon 运行时在线**（不是云端常驻）；
- **不能主动发起对话**（iLink 限制），需你先发消息；
- iLink 会话超时（errcode `-14`）会进入 1 小时冷却，重发消息恢复。

### 微信指令总览（大脑 / 会话 / 任务）

在微信里**直接发**这些消息即可，daemon 拦截处理、不进大脑（中文与斜杠双轨，`/ai` 是收敛前缀）：

| 你发的消息                                  | 作用                                                                    | 谁能发 |
| ------------------------------------------- | ----------------------------------------------------------------------- | ------ |
| `切换大脑 [名]` · `/ai brain [名]` · `/brain [名]` | **热切换**对话大脑：进程内换，不重启 daemon、不打断在途回合；失败自动回滚到原大脑 | 账号本人 |
| `切换任务大脑 [名]` · `/ai task [名]` · `/worker [名]` | 设**默认任务大脑**（粘性；不写 `brain.json`，重启回到配置值）           | 账号本人 |
| `AI` / `AI 列表` · `/ai`                    | 列可选 agent + 当前对话大脑 / 默认任务大脑                              | 账号本人 |
| `交接` · `/handoff`                         | 生成交接摘要（目标/已确认结论/未决问题/关键事实），切到别的大脑后**第一条消息自动带上**，答完即用掉 | 账号本人 |
| `新会话 [名字]` · `/new`                    | 清当前会话并新建（可命名）                                              | 已授权 |
| `会话列表 [页]` · `/sessions`               | 序号 / 名字或摘要 / 时间 / 轮次 / `←当前`；末尾提示其它大脑另有几条     | 已授权 |
| `恢复会话 <序号\|名字\|id前缀>` · `/resume` | 切回旧会话（**strict**：接不上就如实报错，不改当前会话）                | 已授权 |
| `重命名会话 <序号> <名字>` · `/rename`      | 给会话登记表改名                                                        | 已授权 |
| `删除会话 <序号>` · `/delete`               | 从 WeMind 列表删除（若是当前会话则同时清指针，下条消息开新会话）        | 已授权 |
| `任务 [<预设>：]正文` · `/task`             | 派发新任务（可指定 agent；不指定用默认任务大脑）                        | 已授权 |
| `#<编号> 正文` · `/reply <编号> 正文`       | 注入指定任务（多任务时必须带编号）                                      | 本人任务 |
| `任务列表` · `/tasks`                       | 编号 / agent / 状态（跑/等你）/ 轮次 / 时长 / 最近输出                  | 本人任务 |
| `结束任务 [编号]` · `结束全部任务` · `/stop` | 结束任务（「等你回复」的那条进程**回池复用**；「正在跑」的那条回合没法优雅取消，只能力杀；多条并存必须带编号） | 本人任务 |
| `帮助` · `/help`                            | 全部指令，按角色裁剪                                                    | 全部 |

非账号本人发上述「账号本人」类命令会收到一句短提示（**不会**转发给大脑）。

### 远程任务（worker）：把漫长任务交给微信遥控

> 📖 完整使用方法（微信 + 本地终端两入口、典型流程、FAQ）见 **[docs/使用指南-远程任务（worker）.md](docs/使用指南-远程任务（worker）.md)**。

除了「对话大脑」，daemon 还能把**漫长任务**交给一个**受控的 ACP worker 进程**跑——你在电脑上派发任务后离开，它在「需要你决策」（如列方案让你选）或「中断」时把情况推到微信，你回一句就能让它续跑（远程 human-in-the-loop）。

worker 与对话大脑是**独立的 ACP 进程，互不干扰**——而且是**每个任务一条连接**（进程池：结束「等你回复」的任务时进程回池复用，空闲超 5 分钟回收；结束「正在跑」的那条只能力杀）：可以同时让 kiro 做任务 1、opencode 做任务 2。worker 跑在任务工作目录、继承所用 agent 真实配置目录的**全量 MCP（除 `wechat`）＋ 记忆/技能/模型**（kiro 即 `~/.kiro`，opencode 即 `~/.config/opencode`）。

**指令集**：

| 你发的消息                        | 去向                                                               |
| --------------------------------- | ------------------------------------------------------------------ |
| `任务：xxx` / `>xxx`              | 明确发给 worker：没任务时**启动**新任务；有活跃任务时注入（唯一那条）；多条并存回消歧清单 |
| `任务 <预设>：xxx`                | 用指定 agent **新开**一条任务（冒号前必须是不带空格的已知预设名）   |
| `#2 正文`                         | 注入**第 2 条**任务（多任务并存时用它消歧）                        |
| `任务列表` / `结束任务 [编号]` / `结束全部任务` | 看 / 结束任务（不给编号 = 唯一那条；多条并存回消歧清单）  |
| `问大脑 xxx`                      | 明确发给对话大脑（worker 正等你时也能临时插话问大脑）              |
| worker 刚问你后，直接回（无前缀） | 注入 worker（最自然的决策回复）                                    |
| worker 埋头跑时，直接发（无前缀） | 走对话大脑（任务不受影响）                                         |
| 任务「已中断」后回「继续」（无前缀） | 拉进程**续跑**那条中断的任务（只有一条时才这么判）                |

- worker 只在 **waiting（刚停下问你）** 时才默认接管你的无前缀消息；它埋头跑时大脑照常可用。
- 只有一条活跃任务时无前缀消息直接注入它；**多条并存**时必须带编号（`#2 …`），否则回一份消歧清单。任务编号**按用户单调递增、不复用**，且**跨重启不归零**。
- worker 每轮输出带 `🤖【任务】` 标记；跑一轮期间持续「正在输入中」（typing 不占连续发送上限）。
- 中断（崩溃/超时/daemon 重启）后任务标**「已中断」**并在 `任务列表` 可见；回「继续」（或 `#n 继续`）才拉进程续跑（按预设试 `session/load` → `session/resume`）。接不上会如实说明「这次接不上，请用文字重述」；半截回合的副作用可能已发生，续跑前会提示核对（**不会**自动续跑）。
- 并发上限默认 3（`WEMIND_MAX_WORKERS`），超出时派发被拒并提示。
- 详见 [docs/方案C-MVP-远程human-in-the-loop.md](docs/方案C-MVP-远程human-in-the-loop.md)。

**本地终端入口**（与微信并列、管同一任务，**不依赖微信**）：在电脑前用 `wemind` 直接管 worker 任务，适合开任务时贴长描述 / 指定工作目录，或专注电脑工作不想掏手机时。

| 命令（`wemind …`）                            | 作用                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `task "<描述>" [--cwd <目录>] [--agent <预设>]` | 本地派发任务（默认 cwd=终端当前目录，可指定项目目录——微信入口做不到） |
| `task-list [<key\|label>]`                    | 任务列表（编号/agent/状态/轮次/时长）                                 |
| `task-status [<key\|label>]`                  | 任务概览（任务表有记录时与 `task-list` 同一份；表为空才退回读 `task-state.json` 快照） |
| `task-reply <编号> "<内容>"`（或 `task-reply "#编号 内容"`） | 回复/注入任务（`task-reply 2 "继续"`；不给编号 = 唯一那条） |
| `task-stop [<编号\|全部\|all>]`                | 结束任务（不给编号 = 唯一那条，多条并存回消歧清单）                   |

机制为**文件桥**：CLI 原子写 `task-inbox/*.json`（带 `ack` id），daemon 独立定时器扫描分发到同一套 task-manager，命令的真实结果写回 `task-out/<id>.json`（CLI 短轮询后打印它，所以「已派发」不会说谎：池满被拒会如实说），状态写 `task-state.json`（另有一份 `tasks.json` 供重启续跑）。CLI 的 `brain switch` / `session *` 则走**控制桥**（daemon 在跑就进程内执行、回话给你；daemon 没跑时读命令降级为直接读文件）。详见 [docs/本地双入口-命令派发与看敲.md](docs/本地双入口-命令派发与看敲.md)。

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
| `新会话 [名字]` / `/new`    | 开启新 ACP 会话（清空多轮上下文）；给名字便于在 `会话列表` 里认出来 |

加载/卸载 MCP 后 daemon 会**重启 ACP 进程**以按新沙箱配置重载，下一条消息生效。激活的 MCP 等于对白名单发件人全权开放（kiro 预设是 `--trust-all-tools`；其它 agent 按其批准策略），按需加载、用完可卸载。

### 切换大脑 Agent（通用化）

daemon 的大脑通过 **ACP（Agent Client Protocol，JSON-RPC 2.0 over 标准输入输出）** 驱动，未配置时默认 `auto`（按 `kiro → opencode → gemini → deepseek → qoder` 探测已安装者）。

**能不能接：四个必要条件**（详见 [docs/接入其它-ACP-Agent.md](docs/接入其它-ACP-Agent.md) §0）

| # | 条件 | 说明 |
| --- | --- | --- |
| 1 | 有**可执行入口** | daemon 要把它**启动为子进程**；纯 HTTP API（OpenAI / Anthropic / Ollama）没有进程可启动，目前接不了 |
| 2 | **实现 ACP**，或有 **ACP 适配器** | 原生实现：kiro / opencode / gemini / DSH / Qoder；需适配器：Claude Code（`claude-code-acp`）、Codex（`codex-acp`） |
| 3 | ACP 实现覆盖**最小方法集** | 至少 `initialize` + `session/new` + 能流式回包的 `session/prompt`；先用 `wemind brain check` 真握手 |
| 4 | 能**完成认证**且二进制可解析 | PATH 上能找到，或用 `--bin` 给绝对路径；`.cmd`/`.bat` 需经 shell |

> **「支持 ACP」四个字不足以说明可用**：`session/load`、`session/resume`、图片输入、MCP 传输、反向请求都是**可降级项**，按 agent 而异（见 `packages/wechat-daemon/src/brain-agents.ts` 的 `AcpAgentPreset` 字段与 [docs/接入其它-ACP-Agent.md](docs/接入其它-ACP-Agent.md) §9）。接入前先跑能力探针。

| 环境变量                | 作用                                                | 默认         |
| ----------------------- | --------------------------------------------------- | ------------ |
| `WEMIND_BRAIN`          | 选预设（如 `kiro`、`opencode`、`deepseek`、`auto`） | `auto`       |
| `WEMIND_BRAIN_BIN`      | 覆盖二进制（绝对路径或 PATH 上的名字）              | 预设自动解析 |
| `WEMIND_BRAIN_ARGS`     | 覆盖进入 ACP 模式的启动参数（空格分隔）             | 预设值       |
| `WEMIND_BRAIN_HOME_ENV` | 覆盖「agent 配置目录环境变量名」（指向 brain 沙箱） | 预设值       |
| `KIRO_CLI_BIN`          | 旧的 kiro 专用二进制覆盖（仍兼容）                  | —            |

`kiro` 预设 = `kiro-cli acp --trust-all-tools` + `KIRO_HOME` 指向沙箱。要接入新 agent，在 `ACP_AGENT_PRESETS` 加一条预设、或直接用上面四个变量。持久化选择用 `wemind brain set <预设> [--bin ...]`（写入 `<数据目录>/brain.json`，任何入口重启都复现；只给预设名且 daemon 在跑并认控制桥时会**立刻热应用**，带 `--bin/--args/--shell` 则仍是「只写盘、需重启」）。**运行时切换**用 `wemind brain switch <预设>` 或微信里发 `切换大脑 <预设>`——进程内换、失败自动回滚，见 [`docs/repowiki/06-ACP-大脑与沙箱.md`](docs/repowiki/06-ACP-大脑与沙箱.md)。

> 详细步骤、各 agent 需确认的 4 件事、MCP 沙箱差异、验证方法见 [docs/接入其它-ACP-Agent.md](docs/接入其它-ACP-Agent.md)。
>
> **OpenCode 已内置预设**：`WEMIND_BRAIN=opencode` 即可让 `opencode acp` 当大脑（自动用 `XDG_CONFIG_HOME` 隔离配置目录、curated MCP、继承记忆/技能）。完整设计、M1 实测与风险见 **[docs/接入-OpenCode.md](docs/接入-OpenCode.md)**。
>
> **DeepSeek 已接入（官方 DSH，微信 brain + worker E2E 已通）**：`wemind brain set deepseek --bin "<...>\dsh.cmd"` 即用 `dsh --profile acp` 当大脑；预设已处理 `DSH_HOME` 沙箱、`.credentials.yaml`、`model=deepseek-account/deepseek-flash`、`session/resume`、**动态 MCP（`加载/卸载` 经 ACP `mcpServers` 生效）**、图片拦截。实测与限制见 **[docs/接入-DeepSeek.md](docs/接入-DeepSeek.md)**，M3–M5 结果见 **[docs/待办-DeepSeek-M3-M5.md](docs/待办-DeepSeek-M3-M5.md)**。

> **Qoder 已内置预设（M0–M3 已完成）**：`wemind brain set qoder` 即用 `qodercli --acp --yolo` 当大脑；预设处理 `QODER_CONFIG_DIR` 沙箱、`.auth/user` + `.auth/machine_id` 登录态同步、`settings.json` 基底（剥离 `providers`/`model`、关自动更新）、文件式 MCP、`memory/` 记忆继承。需先 `qoder login`。实测与限制见 **[docs/接入-Qoder.md](docs/接入-Qoder.md)**。

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

## 常见问题

**装完打不开 / 提示命令不存在**
```bash
wemind version                      # 确认装上且版本正确
npm i -g @wemind/cli@latest         # 升级
npx -y @wemind/cli version          # 不想全局装：注意写全包名，npx wemind 不行
```

**扫码后一直卡在加载**
切到手机流量（关掉 WiFi）再扫一次；二维码过期会自动刷新（15 分钟内有效）。

**登录成功但发给它没反应**
1. `wemind list` 看是否「运行中」，`wemind brain check` 看大脑是否可用；
2. 看日志：`~/.wemind/<账号>/daemon.log`，搜 `prompt ok`（有 = 大脑回了）或 `prompt FAIL`（有 = 大脑出错）；
3. 大脑不可用会以致 **78** 退出并**停止自动重启**——先修大脑再 `wemind start <账号>`。

**回复到一半停了 / 让我回「继续」**
这是微信**连续发送上限（约 10 条）**的保护：进度消息也占额度。回复「继续」即可接着来；长任务建议拆小。

**两个 bot 抢消息 / 同一条消息回两遍**
同一 bot token **只能有一个消费者**。检查是否同时跑了 `wemind` 守护进程和 `@wemind/wechat-mcp`，或同一账号被启用了两套常驻（pm2 + 内置看门狗），二选一。

**改了代码/升级后行为没变**
正在运行的 daemon 不会自动换代码：`wemind stop <账号> && wemind start <账号>`。

**安全提示**
守护进程用 `--trust-all-tools`（kiro 预设），能给这个 bot 发消息的人即可让 AI 在本机执行工具。**唯一安全闸是发件人授权（allowFrom），扫码登录者自动授权，请勿清空**。详见 [安全说明](#安全说明)。

更多排障：[docs/ai/recipes/debug-daemon.md](docs/ai/recipes/debug-daemon.md) ｜ 面向新手的完整 FAQ：[docs/新手教程.md](docs/新手教程.md) §常见问题

## 致谢

- Fork 自 [Howardzhangdqs/mcp-wechat-server](https://github.com/Howardzhangdqs/mcp-wechat-server)（MIT）。
- iLink 协议细节、session-guard 与上下线通知实现借鉴自微信官方插件 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）。

## 许可证

[MIT](LICENSE) —— 沿用原项目 [Howardzhangdqs/mcp-wechat-server](https://github.com/Howardzhangdqs/mcp-wechat-server)（同为 MIT）。

---

> **文档版本**：WeMind 1.0.1 ｜ **最后核对**：2026-10-27 ｜ 代码以当前 `main` 为准；接入类结论请看对应文档的「实测/假设」标注。
