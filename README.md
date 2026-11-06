# WeMind

> _Your AI mind, reachable on WeChat. —— 你的 AI 大脑，在微信上随时可达。_

WeMind 让任何 AI Agent 都能通过「个人微信」收发消息。它把腾讯官方的 iLink / 微信 ClawBot 渠道封装成两种可消费形态（均已发布到 npm）：一个 MCP Server 子包（`@wemind/wechat-mcp`），和一个常驻 daemon（`@wemind/cli`）。

| 形态 | 怎么装 | 适合 |
| --- | --- | --- |
| **MCP Server**（`wemind-mcp`） | `npm i -g @wemind/wechat-mcp` | 在 Claude Desktop / Cursor / OpenCode / Kiro 等已有客户端里让 AI 收发你的微信 |
| **常驻 daemon**（命令 `wemind`） | `npm i -g @wemind/cli` | 要一个自己常驻、7×24 自动回复、还能远程派任务的微信 AI 助手 |

常驻形态装完只需两步：`npm i -g @wemind/cli` → `wemind login --label 工作号 --start`（扫码登录并顺带常驻），之后 `wemind list` 看运行状态。

> ⚠️ **同一个微信 bot 账号只能有一个程序收消息**（同一份登录凭证不能同时被两个程序使用）：两种形态别同时跑，否则互相抢消息。
> ⚠️ **包名 ≠ 命令名**：装 `@wemind/cli`，敲 `wemind`。不安装、想临时跑一次时用 `npx -y @wemind/cli`（`npx` 按包名解析，写 `npx wemind` 不可用）。

**下一步**：**[新手教程](docs/使用指南/新手教程.md)**（从零开始，含扫码、开机自启、常见问题）｜ **[安装详解](#安装两种形态二选一)** ｜ 遇到问题看 [常见问题](#常见问题)

### AI 大脑：能接什么 agent

常驻助手需要一个「大脑」——一个**实现 ACP 协议的命令行程序**。内置 **9 个 agent 预设**：原生 ACP 的 `opencode` / `cline` / `qoder` / `gemini` / `deepseek`（DSH）/ `kiro`（**未配置时按此顺序自动探测**，按实测启动耗时排序；6 个都至少过了探针级实测（gemini 已通过真机 E2E，2026-11-01），opencode / cline / qoder / deepseek / kiro 另有长期真机使用），以及三个需适配器的 `claude-code` / `codex` / `pi`（三者都已探针级实测 + 真机 E2E；只能显式选用，不参与自动探测）。**能不能接的四个必要条件**（可执行入口、实现 ACP 或装了适配器、覆盖最小方法集、能完成认证）与逐项判断见下方 [切换大脑 Agent](#切换大脑-agent通用化)。

```bash
wemind brain                 # 看当前用的是哪个大脑
wemind brain check           # 真起一次 ACP 握手，验证能不能用
wemind brain set qoder       # 换大脑（按账号写入磁盘，重启仍生效）
wemind brain set opencode --extra-args "--log-level debug"   # 只追加启动参数（保留预设的 ACP 模式参数；--args 是整段替换，漏掉会握手超时）
wemind brain switch opencode # 换大脑：daemon 在跑就不重启、不打断在途回合；失败自动退回原来那个
wemind session list          # 会话列表（新会话 / 恢复会话 / 重命名 / 删除同名子命令）
```

> **「支持 ACP」不等于能用**：`session/load`、`session/resume`（agent 自带的会话恢复方法）、图片输入、MCP 传输、反向请求都是**可降级项**（agent 没实现就退到简单做法），各家实现差别很大。完整判断流程、各 agent 实测结论见 **[docs/接入方案/接入其它-ACP-Agent.md](docs/接入方案/接入其它-ACP-Agent.md)**。

## 📖 文档导航

按你的身份选入口：

| 你是 | 从这里开始 |
| --- | --- |
| **第一次用** | [新手教程](docs/使用指南/新手教程.md) —— 一步步搭起你的微信 AI |
| **想直接上手配置** | [安装（两种形态）](#安装两种形态二选一) · [MCP 客户端配置](#快速开始) · [挂到 Claude Desktop](#claude-desktop) · [挂到 Cursor](#cursor--其他-mcp-客户端) |
| **想换 AI 大脑** | [切换大脑 Agent](#切换大脑-agent通用化) · [接入其它 ACP Agent](docs/接入方案/接入其它-ACP-Agent.md) · [OpenCode](docs/接入方案/接入-OpenCode.md) · [DeepSeek](docs/接入方案/接入-DeepSeek.md) · [Qoder](docs/接入方案/接入-Qoder.md) |
| **想用远程任务** | [使用指南-远程任务](docs/使用指南/使用指南-远程任务（worker）.md) · [本地双入口](docs/机制与协议说明/本地双入口-命令派发与查看回复.md) |
| **运维 / 部署** | [部署与运维](docs/repowiki/10-部署与运维.md) · [跨平台常驻（pm2）](docs/部署与运维/跨平台常驻-pm2.md) · [数据目录与环境变量速查](docs/使用指南/速查-数据目录与环境变量.md) |
| **想改这个仓库 / 贡献代码** | [开发指南](docs/repowiki/11-开发指南.md) · [系统架构](docs/repowiki/02-系统架构.md) · [发版手册](docs/发布与变更记录/如何发布新版本.md) |
| **维护者 / 发布新版本** | [如何发布新版本](docs/发布与变更记录/如何发布新版本.md) —— 两个包的版本号、CI 流程、验收与常见坑 |
| **AI 编码助手**（帮我改这个仓库的 agent） | 先读 [AGENTS.md](AGENTS.md) → [docs/ai/README.md](docs/ai/README.md) → [术语表](docs/ai/术语表.md)（写作口径）与 [任务配方](docs/ai/recipes/) |

深入架构、协议与运行机制：[docs/repowiki/](docs/repowiki/README.md) —— 依据源码整理的完整技术 wiki（含 Mermaid 图）。**全库文档总索引**在 [docs/README.md](docs/README.md)。

| 入口                                                     | 内容                                                    |
| -------------------------------------------------------- | ------------------------------------------------------- |
| [docs/README.md](docs/README.md)                         | **全库文档总索引**：按读者与主题分组                    |
| [AGENTS.md](AGENTS.md)                                   | **AI 编码助手入口**：30 秒定位、硬约束、改哪里、已知坑 |
| [docs/ai/README.md](docs/ai/README.md)                   | AI 上下文包：数据流、事实状态表、任务配方               |
| [docs/ai/术语表.md](docs/ai/术语表.md)                   | 术语含义与中英写作口径                                  |
| [RepoWiki 首页](docs/repowiki/README.md)                 | 按角色的阅读导航 + 章节目录                             |
| [系统架构](docs/repowiki/02-系统架构.md)                 | 三包协作、两种接入形态、poller/worker 解耦、双 ACP 进程 |
| [iLink 协议内核](docs/repowiki/03-iLink-协议内核.md)     | HTTP 客户端、协议类型、错误码、收发图加解密             |
| [daemon](docs/repowiki/05-daemon.md)   | 消息路由、回合编排、连续发送上限管理                    |
| [ACP 大脑与沙箱](docs/repowiki/06-ACP-大脑与沙箱.md)     | 常驻 ACP 进程、MCP 沙箱、记忆继承、换大脑               |
| [远程任务 Worker](docs/repowiki/07-远程任务-Worker.md)   | 受控工作机、任务状态机、微信/本地双入口                 |
| [配置项与环境变量](docs/repowiki/09-配置项与环境变量.md) | 全部 env 速查表                                         |
| [llms.txt](llms.txt)                                     | 机器可读文档索引                                        |

> 本 README 是面向用户的使用说明；RepoWiki 是面向开发者的深度技术文档，两者互补。

## 功能

- **6 个 MCP 工具**：`login_qrcode`（取登录二维码）· `check_qrcode_status`（查扫码状态）· `logout`（登出并清凭证）· `get_messages`（长轮询收消息）· `send_text_message`（发文本）· `send_typing`（打字状态）
- **扫码登录**：生成终端文本二维码、PNG 图片、URL 链接三种方式
- **长轮询监听**：阻塞等待新消息，最长可等待 7 天
- **打字状态**：Agent 处理消息时自动显示「对方正在输入……」
- **状态持久化**：重启不丢失登录凭证和消息游标（记录「读到哪条消息了」）
- **独立运行**：无需 OpenClaw 框架，开箱即用

## 环境要求

- [Node.js](https://nodejs.org/) >= 20.19（发布包 `engines` 的下限；CI 在 Node 20 与 22 上验证，已在 Node 24 实测）。**从源码构建**需要 Node >= 22.18（`tsdown` 的 engines 要求；只安装/运行 `@wemind/cli`、`@wemind/wechat-mcp` 不受影响）
- Bun：产物是单文件 ESM，理论上可跑，但**未单独实测**（本文所有验证都在 Node 上）

## 项目结构（npm workspaces 三包）

本仓库是一个 monorepo，按职责拆为三个包，共享同一套 iLink 协议内核：

| 包                          | 路径                         | 说明                                                                                         | 发布                            |
| --------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------- |
| `@wemind/wechat-ilink-core` | `packages/wechat-ilink-core` | iLink 协议内核：HTTP 客户端、类型、会话守卫、账号/状态持久化、收图解密。不依赖任何「消费方」 | 私有（构建时内联进 `@wemind/cli` 与 `@wemind/wechat-mcp`） |
| `@wemind/wechat-mcp`        | `packages/wechat-mcp`        | MCP server：把内核能力暴露为 MCP 工具，供任意 MCP 客户端接入                                 | **已发布**（bin: `wemind-mcp`） |
| `@wemind/cli`               | `packages/wechat-daemon`     | 独立常驻 daemon：长轮询 + 常驻 ACP 大脑自动收发                                             | **已发布**（命令 `wemind`）     |

> 📌 上表「发布」列指的是**该子包**是否发布到 npm：对外发布的是 `@wemind/wechat-mcp`（MCP 形态）与 `@wemind/cli`（完整应用 CLI，命令 `wemind`）两个入口。两者共用同一个 bot token 时**只能二选一**。

`@wemind/wechat-mcp` 与 `@wemind/cli` 发布时都用 [tsdown](https://tsdown.dev/)（rolldown + oxc）把 `core` **内联**进单一产物，**两个包各自自包含**；`core` 本身 `private: true`，永不单独发布。发布流程见 [`.github/workflows/wemind-publish.yml`](.github/workflows/wemind-publish.yml) 与 [`docs/发布与变更记录/如何发布新版本.md`](docs/发布与变更记录/如何发布新版本.md)。

## 安装（两种形态，二选一）

| 形态 | 安装 | 命令 | 适用 |
| --- | --- | --- | --- |
| ① MCP Server | `npm i -g @wemind/wechat-mcp` | `wemind-mcp` | 已有 AI 客户端（Claude Desktop / Cursor / OpenCode / Kiro） |
| ② 常驻 daemon | `npm i -g @wemind/cli` | `wemind` | 想要一个自己跑、7×24 自动收发 + 远程任务的助手 |

```bash
# ② 常驻助手的典型三步（包名 @wemind/cli，命令是 wemind）
npm i -g @wemind/cli
wemind login --label 工作号 --start   # 扫码登录 + 启动常驻
wemind list                          # 查看账号与运行状态
```

> ⚠️ **包名 ≠ 命令名**：装的是 `@wemind/cli`，敲的是 `wemind`，`npm i -g` 后不受影响。不安装、临时跑一次时用 `npx -y @wemind/cli list`——`npx` 按包名解析，`npx wemind` 不可用；不带版本号时 npx 会解析 `latest`，要固定版本可写 `@wemind/cli@<版本号>` 或改用全局安装。
>
> 两个包都发布在 npm：<https://www.npmjs.com/package/@wemind/cli> ｜ <https://www.npmjs.com/package/@wemind/wechat-mcp>

## 快速开始

> **接入形态**：`@wemind/wechat-mcp` 已发布到 npm。在 MCP 客户端配置里，默认让客户端通过 `npx -y @wemind/wechat-mcp` 按需拉起它（MCP 生态惯例，下面三份配置即此写法）：不用预先安装，npx 在客户端自己的环境里解析包，GUI 客户端不必能找到 npm 全局 bin。
>
> 若想**先安装**到全局（固定版本、离线运行或在终端里直接敲），用 `npm i -g @wemind/wechat-mcp` 得到 `wemind-mcp` 命令（Windows 为 `wemind-mcp.cmd`），再把配置里的 `command` 换成 `wemind-mcp`；注意 GUI 客户端启动时的 PATH 常不含 npm 全局 bin 目录，找不到时写该 bin 的绝对路径。
>
> 两种写法的登录态与消息游标都持久化在 `~/.wemind`，与 MCP server 怎么启动无关。不带版本号时 npx 会解析 `latest`；要固定版本可在包名后写 `@<版本号>`，或改用全局安装。以下配置适用于 Claude Desktop、OpenCode、Cursor 等 MCP 客户端；本地开发时也可以构建后直接运行 `packages/wechat-mcp/dist/index.js`。

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

> **已全局安装时**：把上面三份配置里的 `command` / `args` 换成 `"command": "wemind-mcp"`（OpenCode 用 `["wemind-mcp"]`）。Claude Desktop 等 GUI 客户端启动时的 PATH 常不含 npm 全局 bin 目录；若报找不到命令，用 `npm root -g` 查出全局安装根，把 `command` 写成该 bin 的**绝对路径**（Windows 上是 `wemind-mcp.cmd`），或直接用上面的 npx 写法。

## 使用方法

### 1. 扫码登录

AI Agent 调用 `login_qrcode` 生成二维码，你可以通过以下方式扫码：

- 在终端运行 `cat ~/.wemind/default/qrcode.txt` 查看二维码
- 打开图片文件 `~/.wemind/default/qrcode.png`
- 将链接复制到微信中打开

> **提示**：如果手机扫码后页面一直加载，请切换到**移动数据网络**（关闭 WiFi）。

> **MCP 登录也会登记账号（2026-11-02）**：登录成功后，如果数据目录就是 CLI 的标准账号目录（默认 `~/.wemind/default`，且没设 `WECHAT_DATA_DIR`），MCP 会把它写进 `~/.wemind/accounts.json`——之后 `wemind list` / `wemind start` 能看到这个账号。自定义 `WECHAT_DATA_DIR` 时不登记（CLI 注册表指向 `~/.wemind/<key>`，硬登记会让它去错目录找凭证）。需要验证码 / IDC 重定向时，MCP 与 CLI 都会直接说明「暂不支持该步骤」并让你稍后重试（两者共用同一套登录能力，都不会静默等到超时）。

### 2. 确认登录

Agent 调用 `check_qrcode_status` 确认登录状态。

### 3. 开始聊天

登录成功后，Agent 会自动执行以下流程：

1. 调用 `get_messages` 轮询新消息
2. 收到消息后调用 `send_typing` 显示"正在输入..."
3. 处理完成后调用 `send_text_message` 回复
4. 回复完毕后调用 `send_typing` 取消打字状态

## 工具列表

| 工具                  | 说明                                                      | 代码 description（简要转述，非逐字原文）                                                                                                                                                                |
| --------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login_qrcode`        | 取登录二维码（返回 URL，并在数据目录生成 PNG 与终端文本） | Get a WeChat login QR code. Scan it with WeChat to connect the bot. … You MUST show all three returned forms (image URL / PNG file / terminal text file) to the user.                                   |
| `check_qrcode_status` | 查扫码状态（轮询到 `confirmed` 即登录成功）               | Check whether the QR code from `login_qrcode` has been scanned and confirmed. … If it returns `need_verifycode` or an IDC-redirect status, tell the user to run the `wemind login` CLI command (or `npx -y @wemind/cli login`) instead. |
| `logout`              | 登出并清除已保存的凭证                                    | Log out the current WeChat bot session. … Clears saved credentials, runtime state and any pending QR login. Only call this when the user asks to log out or wants to switch accounts.                   |
| `get_messages`        | 长轮询收消息（`wait=true` 阻塞直到收到）                  | Poll for new WeChat messages. Always call with `wait=true` to block until a message arrives.（后接 4 步 typing 工作流）                                                                                 |
| `send_text_message`   | 发文本消息                                                | Send a text message to a WeChat user. … iLink bots cannot initiate conversations: if you have never received a message from that user, this call fails.                                                 |
| `send_typing`         | 打字状态（`typing` 显示 / `cancel` 取消）                 | Show or cancel the "typing..." indicator for a WeChat user. … Re-send status `typing` every 15-20 seconds while still working, because the indicator expires on its own.                                |

> 上表为 `packages/wechat-mcp/src/index.ts` 的 `registerTool` description 的**简写转述**（`…` 表示省略），不是逐字原文；完整、准确的原文以源码为准。
> 6 个工具的 description **一律写英文**——MCP 生态惯例，且模型对 `MUST` / `wait=true` 这类强制约束的英文原文遵循度更高。用户能看到的提示文案在 `tools/*.ts` 的 `message` 字段，均为中文。
> `get_messages` 的完整描述是一段 4 步 `send_typing` 编排指引（收到消息即 `typing`、处理中每 15–20s 续发、回复后 `cancel`），与上文「开始聊天」的流程一致。
> 两个工具还有影响行为的入参：`send_text_message` 的可选 `state`（`generating` = 进度消息、`finish` = 最终答复，默认 `finish`；每次调用都是一条独立微信消息）；`get_messages` 对图片 / 视频 / 文件**只返回占位符**（不含可下载内容），语音消息带微信自带的转写文本——需要真实媒体请用 daemon 形态。

## 数据存储

运行时状态保存在 **`~/.wemind/<account>/`** 下（默认账号 `default`，即 `~/.wemind/default/`）。该目录**独立于代码仓库**——改名/重装/重新 clone 代码都不影响登录态。

| 文件/目录                                     | 说明                                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `account.json`                                | Bot Token、botId、userId、baseUrl（POSIX 下权限 600；**Windows 下为明文**，见「安全说明」）                 |
| `brain.json`                                  | **持久大脑配置**（`agent` 与各 agent 的 `presets` 启动覆盖）；热切换**成功才写**、失败不动，所以它始终等于「下次会用的那个大脑」 |
| `allowFrom.json`                              | **登录者白名单**（兜底鉴权，默认拒绝；正常只含登录者一个 userId，**别清空**——清空后除登录者外的发件人全部被拒） |
| `state.json`                                  | 长轮询游标（记录读到哪条了；`updatesBuf`）、各会话 `context_token`、`lastMessageId`（去重；POSIX 下权限 600） |
| `qr_login.json` / `qrcode.png` / `qrcode.txt` | 扫码登录临时态与二维码（登录后即失效；`qr_login.json` POSIX 下权限 600）                                    |
| `brain-sessions.json`                         | `<agent>:<userId> → ACP sessionId` 映射（按大脑分开存，切换 agent 互不覆盖）；daemon 重启后据此尝试 `session/load` 或 `session/resume` 恢复多轮上下文（agent 不支持则新建） |
| `brain-mcps.json`                             | brain 当前激活的 MCP 集（默认空）                                                                           |
| `brain-home/`                                 | brain 沙箱（由该 agent 配置里的 `homeEnvVar` 指向它；kiro 是 `KIRO_HOME`，opencode 是 `XDG_CONFIG_HOME`），含 agent 配置与 ACP 会话 |
| `worker-sessions.json`                        | worker（远程任务）`ACP sessionId` 映射（键 `<agent>:task-<编号>@<userId>`），任务中断后据此 `load`/`resume` 续跑 |
| `worker-home/`                                | worker 沙箱（同 brain 机制；MCP 继承**全量除 `wechat`** ＋ 记忆/技能/settings）                              |
| `agent-sessions/`                             | agent 自己的会话库隔离位置（目前只有 DeepSeek/DSH 用：`deepseek/{brain,worker}/`，由预设的 `isolateSessions` + `--patch` 指过来，避免它把别的 agent 写的 `sessions/` 当成自己的库） |
| `daemon.log`                                  | daemon 日志（stdout/stderr 合并；运行中按 `WEMIND_LOG_MAX_MB`（默认 10MB）轮转、保留 `WEMIND_LOG_KEEP`（默认 3）份） |
| `wrapper.pid`                                 | 后台守护进程的 pid（builtin `_watchdog` 写；`wemind stop` 据此连它一起停，否则 daemon 会被 5s 后重拉）       |
| `task-state.json`                             | 本地 `task-status` 读的运行态快照（状态/轮次/最近输出）                                                      |
| `task-inbox/` `task-out/`                     | 本地任务命令桥（CLI 写 `dispatch`/`reply`/`stop`，daemon 写答复）                                            |
| `workers.pid.json`                            | worker 进程池的**身份记录**（每条的 pid / agent / 真实 bin+args / busy\|idle / 任务编号；**单条时文件里是单个对象，多条是数组**）；`wemind stop` 一次杀光全部，旧账号的裸整数 `worker.pid` 仍兼容读取 |
| `session-registry.json`                       | 会话**登记表**（名字/标题/轮次/最近使用；最多 50 条/人·大脑）——只供列表展示，「当前是哪个」的唯一权威仍是 `brain-sessions.json` |
| `tasks.json`                                  | 任务表（编号/agent/状态/轮次/cwd/最近输出），用于**重启后续跑**：未完成的标「已中断」，回「继续」才续跑；损坏则降级为空表（只影响列表，不影响运行） |
| `handoff.json`                                | 交接摘要（`交接` 生成；TTL 24h，切到别的大脑后第一条消息带上一次即消费）                                     |
| `control-inbox/` `control-out/`               | CLI ↔ daemon **控制桥**（CLI 写请求、daemon 写应答）；`control-out/.bridge` 记着 daemon 自己的 pid——对不上说明它在跑旧版本 |
| `brain.pid` / `daemon.pid`                    | 进程身份的 JSON 记录（含起进程时**真实用的** bin/args）/ 裸整数 pid（供 `wemind list/stop` 精确识别与清理） |
| `brain-runtime.json`                          | daemon 实际生效的大脑（agent/source/bin/args；启动/热切换写入，stop 清掉）——`wemind list` 在运行时据此显示真实 agent |
| `pm2.app.json`                                | **仅 `--runner pm2`**：pm2 的 app 声明（5s 重拉 / 最多 50 次 / 退出码 78（大脑配置错误）与 75（同账号已有实例）停手 / 日志合并到 `daemon.log`）    |

**多账号**：每个微信账号一份独立子目录。用 `WECHAT_ACCOUNT=<key>` 切换（→ `~/.wemind/<key>/`），或用 `WECHAT_DATA_DIR=<完整路径>` 指定任意目录。不同账号 = 不同目录 = 完全隔离，可各自登录、各跑一个 daemon。**`<key>` 不能随手起名**：它由 `wemind login` 从 botId 派生并登记进 `~/.wemind/accounts.json`（`wemind list` 可查）；写一个没登记过的名字，daemon 会去一个不存在的目录找凭证。日常用 `wemind start <key|label>` 选账号即可，不必手设这个变量。

> **重置**：删 `account.json`+`state.json` = 退出登录重新扫码；清空对话记忆要删 `brain-sessions.json` + 该 agent 配置目录下的会话库（kiro/pi 是 `brain-home/sessions/`，opencode/qoder/gemini/cline 等按各自的 `configSubdir`，DSH 是 `agent-sessions/deepseek/{brain,worker}/`）。

> 📄 **速查**：改数据目录 / 迁移数据 / 环境变量用法（`WEMIND_HOME`、`WECHAT_DATA_DIR` 等，含初次运行指定路径与运行后迁移） → [docs/使用指南/速查-数据目录与环境变量.md](docs/使用指南/速查-数据目录与环境变量.md)。

## 本地开发

```bash
git clone https://github.com/imwangpan/WeMind.git
cd WeMind
npm install
npm run build      # 按 core → @wemind/cli / @wemind/wechat-mcp 顺序构建各包
npm start          # 运行 node packages/wechat-mcp/dist/index.js
npm test           # 运行单元测试
npm run dev -w @wemind/wechat-mcp   # tsx 热重载开发 @wemind/wechat-mcp（可选）
```

## 安全说明

- **凭证存储**：`account.json`（Bot Token）、`state.json`（`context_token`）、`qr_login.json`（扫码态）都是凭证类文件，POSIX 系统会统一设为权限 `600`；**Windows 上 `chmod` 无效，文件以明文存放且不受权限限制**——保存凭证时会有一次性告警。请用文件夹权限或磁盘加密保护 `~/.wemind/default/` 目录。
- **登录者白名单（两种形态都有）**：内置大脑默认**免审批**（每个 agent 用自己的开关，见[「切换大脑 Agent」](#切换大脑-agent通用化)）——**消息一旦被接受**，就能让 AI 在本机执行任意工具。**微信平台的限制决定了：只有扫码登录这个 bot 的那个微信号（「登录者」）能给它发消息**，所以谁在驱动它是一目了然的。代码里另有一道**兜底校验**（每账号一份 `allowFrom.json`，**默认拒绝**、登录时自动写入登录者）：万一发送范围将来变化、或 daemon 被接到别的入口，清单外的发件人一律忽略（`daemon.log` 记 `ignore unauthorized sender`；MCP 形态的 `get_messages` 同样只返回登录者或白名单里的消息）。**不要清空它**；管理命令 `allowlist`/`allow`/`revoke` 是兜底用的，正常无需碰。多账号各有各的白名单与登录者，互不影响。
- **隐私**：消息经由腾讯 iLink 渠道与本地 Agent 流转，涉及对话内容外发，请自行评估。

## 关于 iLink 渠道与限制

- 后端为腾讯官方 **iLink / 微信 ClawBot** 接口（`ilinkai.weixin.qq.com`），面向**个人微信账号**，区别于企业微信。按官方用途使用，不存在逆向 bot 那类封号风险。
- **不能主动发起对话**：只能在收到用户消息后、于该会话上下文内回复（发送依赖收消息得到的 `context_token`）。
- **服务稳定性**：这是腾讯新开放的插件功能，官方条款保留随时停服的权利，请勿用于关键业务。
- 需要较新的微信客户端并启用 ClawBot 插件。

## daemon：脱离 IDE/终端常驻自动收发

### 命令一览（自动生成）

> 本表由 `node scripts/gen-docs-tables.mjs` 从 `cli/manage.ts` 与 `ipc/chat-command-specs.ts` 生成，保证命令清单与代码一致。

<!-- BEGIN:auto cli-commands -->
**CLI 子命令**（`wemind <命令>`）

| 命令 |
|:---|
| `adopt` |
| `allow` |
| `allowlist` |
| `brain` |
| `delete` |
| `finalize` |
| `help` |
| `label` |
| `list` |
| `login` |
| `logout` |
| `revoke` |
| `session` |
| `set-default` |
| `start` |
| `stop` |
| `task` |
| `task-list` |
| `task-reply` |
| `task-status` |
| `task-stop` |
| `version` |

**微信指令**

| 指令 | 说明 |
|:---|:---|
| mcp | 列出可选/已激活的 MCP |
| 加载 <名字> | 加载一个 MCP（下条消息生效） |
| 卸载 <名字> | 卸载一个 MCP |
| 新会话 [名字] | 清空上下文重开（可命名） |
| 会话列表 [页] | 列出本人会话（← 当前 标当前） |
| 恢复会话 <序号\|名字\|id前缀> | 切回旧会话（失败明确报错，不静默新建） |
| 删除会话 <序号\|名字\|id前缀> | 只删登记（agent 侧的历史记录不动） |
| AI / AI 列表 | 看可选 agent 与当前配置 |
| 切换大脑 [agent 名\|auto] | 换对话大脑，不用重启（失败自动退回原来那个） |
| 切换任务大脑 [agent 名\|auto] | 设默认任务大脑（本次运行内一直生效，不写 brain.json） |
| 交接 | 生成当前会话摘要，切换后给新大脑接手 |
| 帮助 | 这张表 |
| 任务 [<agent 名>：]正文 | 派发新任务（有活跃任务时发给它）；带 agent 名就由它执行（只影响这一条） |
| #<编号> 正文 | 给指定编号的任务回话（回任务都用它；无前缀消息走大脑） |
| 任务列表 | 编号 / agent / 状态 / 轮次 / 已运行 |
| 结束任务 [编号]、结束全部任务 | 结束任务（进程留着复用） |
<!-- END:auto cli-commands -->

> 📦 **作为 `wemind` CLI 使用**：本 daemon 已发布为 **`@wemind/cli`**，装完得到 **`wemind`** 命令（`wemind login` / `start` / `list` / `task`；常驻默认用自带后台守护进程，也可 `--runner pm2`）。`npm i -g @wemind/cli` 后即可全局使用；包名与命令名不同，不安装、临时跑一次时写 `npx -y @wemind/cli`（`npx` 按包名解析，`npx wemind` 不可用）。发布与版本约定见 [`docs/发布与变更记录/如何发布新版本.md`](docs/发布与变更记录/如何发布新版本.md)；也可以按下文从源码运行。面向最终用户的一步步指引见 **[新手教程](docs/使用指南/新手教程.md)**。

`packages/wechat-daemon/` 提供一个独立 daemon：自己长轮询 iLink 收消息 →
调 **常驻 ACP agent**（JSON-RPC over stdio；未配置时 `auto` 探测 opencode/cline/qoder/gemini/deepseek/kiro）当大脑生成回复 → 自动回发。
进程常驻、原生多轮记忆，回复从 `agent_message_chunk` 流式拼接（天然无 ANSI/工具旁白）；
带**存活检测**（进程不在自动重启）。运行时只依赖第三方 `qrcode`（登录画码时才加载），内核 `@wemind/wechat-ilink-core` 已内联进产物，不碰 MCP 那层，是一个完全独立、可单独运行的包。

```bash
# 方式一：装好的 CLI（推荐最终用户）
npm i -g @wemind/cli    # 装完命令是 wemind
wemind login --label 工作号 --start    # 扫码登录 + 启动常驻
wemind list                          # 账号与运行状态
wemind brain check                   # 验证大脑能实现 ACP（真起一次握手）

# 方式二：从源码跑（开发者）
npm run build
npm run daemon      # 前台运行；需先完成扫码登录（见上文）
```

> ⚠️ **安全（务必读）**：**内置的 9 个 agent 预设默认都免审批**（kiro v2 `--trust-all-tools`，v3 用沙箱 `settings/permissions.yaml` 的 allow-all（引擎自动识别；真实设置已有则原样保留）；gemini `--approval-mode yolo`、qoder `--yolo`、opencode 沙箱配置 `permission: allow`、DSH `DSH_PERMISSION_MODE=danger-full-access`、cline `--auto-approve true`、claude-code `session/set_mode bypassPermissions`、codex `agent-full-access`、pi 默认就不逐次审批），意味着**消息一旦被 daemon 接受，就能让 AI 在运行 daemon 的电脑上执行任意工具（含 shell / 写文件）**。这是「微信里发一句话就能远程干活」的前提，代价是该 AI 在本机近乎全权。
> **微信平台只把发给这个 bot 的消息发送给登录者本人**（= 扫码登录它的那个微信号，也就是你），所以实际上只有你能驱动它。代码里另有一道**登录者白名单**（`allowFrom`，**默认拒绝**、登录时自动写入登录者）作为**兜底**：万一发送范围变化、或 daemon 被接到别的入口，清单外的发件人一律忽略（`daemon.log` 记 `ignore unauthorized sender`）。**不要关掉它。**
>
> **配对授权**：登录者白名单存于每账号的 `~/.wemind/<account>/allowFrom.json`（`finalize`/`adopt` 时自动写入扫码者；daemon 启动也会把登录者种入，老账号自动迁移），通常**无需任何手动配置**。管理命令（兜底用）：`allowlist <key|label>` 查看、`allow <key|label> <userId>` 加入、`revoke <key|label> <userId>` 移除（增删即时生效，无需重启 daemon）。鉴权 = 登录者（`WECHAT_OWNER_ID` 可覆盖）或 在白名单中。

环境变量（**常用项**；完整清单见 [docs/repowiki/09-配置项与环境变量.md](docs/repowiki/09-配置项与环境变量.md)）：

| 变量                                                    | 说明                                                                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `WEMIND_RUNNER`                                         | `wemind start` 的常驻外壳：`builtin`（默认，自带后台守护进程）/ `pm2`；与 `--runner` 等价                                |
| `WECHAT_OWNER_ID`                                       | 登录者覆盖（默认 = 扫码登录该 bot 的微信号 user id；常规用配对授权 allowFrom，见上）                                                |
| `WECHAT_ACCOUNT`                                        | 账号 key，决定状态子目录 `~/.wemind/<key>/`（默认 `default`）。**必须是 `wemind login` 登记过的 key**（见上文「多账号」），日常用 `wemind start <key\|label>` 即可 |
| `WECHAT_DATA_DIR`                                       | 直接指定完整状态目录路径，覆盖 `~/.wemind/<account>` 规则                                                                           |
| `WEMIND_HOME`                                           | 数据根目录（默认 `~/.wemind`）                                                                                                      |
| `WECHAT_BRAIN_HOME`                                     | brain 沙箱目录（默认 `<数据目录>/brain-home`）                                                                                      |
| `WECHAT_BRAIN_IDLE_MS` / `WECHAT_BRAIN_CAP_MS`          | 大脑单回合空闲/硬超时（默认 120000 / 900000；重任务实测需 ~6.5min）                                                                 |
| `WECHAT_BRAIN_FIRST_FRAME_MS`                           | 首帧超时：prompt 发出后多久仍无任何帧判「开局即卡死」并快速重试（默认 25000）                                                       |
| `WECHAT_BRAIN_HEARTBEAT_MS`                             | 静默期心跳间隔：多久没有帧就发一条「还在处理」进度（默认 15000，DSH 预设 60000）                                                     |
| `WECHAT_CONSEC_SEND_LIMIT`                              | bot 在用户回复前可连续发送的消息数上限（默认 10）。达「上限-2」后发提示并等待「继续」，留最后一条给答案                             |
| `WECHAT_MIN_SEND_GAP_MS`                                | 两条发送之间的最小间隔，规避发送限流（默认 1500）                                                                                   |
| `WECHAT_REPLY_FILE_THRESHOLD`                           | 回复正文超过此字符数则转 .md 文件发送（默认 1500）                                                                                  |
| `WEMIND_ILINK_BASE`                                     | iLink API / 登录基础 URL（默认 `https://ilinkai.weixin.qq.com`）                                                                    |
| `WECHAT_CDN_BASE_URL`                                   | 媒体 CDN 基础 URL（默认 `https://novac2c.cdn.weixin.qq.com/c2c`）                                                                   |
| `ILINK_CLIENT_VERSION`                                  | 对外声明的 iLink 客户端版本（默认 `2.4.3`，随官方升级可改，免动代码）                                                               |
| `ILINK_APP_ID`                                          | iLink App Id（默认 `bot`）                                                                                                          |
| `WEMIND_WORKER_CWD`                                     | worker（远程任务）工作目录（默认用户主目录；本地命令派发后可取命令所在目录）                                                        |
| `WEMIND_WORKER_HOME`                                    | worker 沙箱配置目录（默认 `<数据目录>/worker-home`）                                                                                |
| `WEMIND_WORKER_MCP_EXCLUDE`                             | worker 不继承的 MCP（逗号分隔；`wechat` 始终强制排除，防它把消息发回自己）                                                                      |
| `WEMIND_WORKER_IDLE_MS` / `_CAP_MS` / `_FIRST_FRAME_MS` | worker 单轮空闲 / 硬上限（到点就放弃）/ 首帧超时（默认 180000 / 1800000 / 30000，比对话大脑宽松）                                                    |
| `WEMIND_WORKER_BRAIN`                                   | 默认任务大脑（agent 名；未设则回落 `WEMIND_BRAIN`。两者都是**一次性覆盖**，会压过 brain.json 里的 `worker.agent`）                     |
| `WEMIND_MAX_WORKERS` / `WEMIND_IDLE_MAX`                | 同时运行的任务数上限（默认 3）/ 池中保留的空闲进程数（默认 2）                                                                      |
| `WEMIND_MAX_WORKERS_TOTAL`                              | 仅 `scripts/run-all-daemons.ps1` 读取：按账号数均分给每个 daemon 的全局 worker 预算（至少 1）；单独 `wemind start` 不读 |
| `WEMIND_WORKER_REAP_MS`                                 | 空闲 worker 进程回收时间（默认 300000，即 5 分钟；**注意不是** `WEMIND_WORKER_IDLE_MS`——那是单轮 prompt 空闲超时）                   |
| `WEMIND_WORKER_PROGRESS`                                | 是否推送 worker 全程文字进度（默认 `0` 安静；`1` 开启。「正在输入中」始终有）                                                       |
| `WEMIND_TASK_SCAN_MS`                                   | daemon 扫描本地命令收件箱 `task-inbox/` 与控制桥 `control-inbox/` 的间隔毫秒（默认 1000）                                          |
| `WEMIND_SWITCH_DRAIN_MS` / `WEMIND_SWITCH_TIMEOUT_MS`   | 换大脑：等在途回合结束的上限（默认 30000）/ 启动新大脑（`initialize` + 会话）硬上限（到点就放弃，默认 120000）                                 |
| `WEMIND_CONTROL_TIMEOUT_MS`                             | CLI 等 daemon 回话的上限（默认 30000；`brain switch` 自动放大到「启动新大脑 + 等在途回合结束 + 15s」，`brain.handoff` 按回合硬上限放大，默认 915s）                                                    |
| `WEMIND_HANDOFF_TTL_MS`                                 | 交接摘要的有效期（默认 86400000，即 24h；过期不带上）                                                                               |
| `WEMIND_SESSION_LOG_MAX` / `WEMIND_SESSION_PAGE_SIZE`   | 会话登记表每个「登录者 · 大脑」保留的条数上限（默认 50）/ 会话列表每页条数（默认 10）                                              |
| `WEMIND_MAX_RESTARTS`                                   | 后台守护进程的**连续崩溃**重拉上限（默认 50；跑满 10 分钟视为稳定、计数清零），超限停止自动重启（pm2 由 `max_restarts` 管）        |
| `WEMIND_LOG_MAX_MB` / `WEMIND_LOG_KEEP`                 | `daemon.log` 单文件上限（默认 10MB）/ 轮转保留份数（默认 3；`0` = 不留历史）。内置 watchdog 运行中轮转，`run-daemon.ps1` 每次重拉前轮转；pm2 runner 交给 `pm2-logrotate` |
| 大脑 agent 选择 / 记忆继承                              | 见下方「切换大脑 Agent」与 [docs/接入方案/接入其它-ACP-Agent.md](docs/接入方案/接入其它-ACP-Agent.md)（`WEMIND_BRAIN*`、`WEMIND_BRAIN_REAL_HOME` 等） |

限制：

- **只在电脑开机且 daemon 运行时在线**（不是云端常驻）；
- **不能主动发起对话**（iLink 限制），需你先发消息；
- iLink 会话超时（errcode `-14`）会暂停轮询约 1 小时（期间发来的消息不丢，恢复后照常收到）。要立即恢复：重启 daemon（`wemind stop <账号> && wemind start <账号>`），或 `wemind login` 重新扫码（登录成功后会自动解除正在运行的 daemon 的冷却）。

### 微信指令总览（大脑 / 会话 / 任务）

在微信里**直接发**这些消息即可，daemon 拦截处理、不进大脑（中文与斜杠双轨，`/ai` 是统一入口前缀）：

| 你发的消息                                  | 作用                                                                    | 作用范围 |
| ------------------------------------------- | ----------------------------------------------------------------------- | ------ |
| `切换大脑 [名]` · `/ai brain [名]` · `/brain [名]` | **换对话大脑（不用重启）**：不重启 daemon，不打断在途回合；失败自动退回原来那个 | 整个账号（仅登录者） |
| `切换任务大脑 [名]` · `/ai task [名]` · `/worker [名]` | 设**默认任务大脑**（**本次运行内一直生效**；不写 `brain.json`，重启回到配置值）           | 整个账号（仅登录者） |
| `AI` / `AI 列表` · `/ai`                    | 列可选 agent + 当前对话大脑 / 默认任务大脑                              | 整个账号（仅登录者） |
| `交接` · `/handoff`                         | 生成交接摘要（目标/已确认结论/未决问题/关键事实），切到别的大脑后**第一条消息自动带上**，答完即用掉 | 整个账号（仅登录者） |
| `新会话 [名字]` · `/new`                    | 清当前会话并新建（可命名）                                              | 登录者的会话 |
| `会话列表 [页]` · `/sessions`               | 序号 / 名字或摘要 / 时间 / 轮次 / `←当前`；末尾提示其它大脑另有几条     | 登录者的会话 |
| `恢复会话 <序号\|名字\|id前缀>` · `/resume` | 切回旧会话（**严格恢复**：接不上就如实报错，不改当前会话）                | 登录者的会话 |
| `重命名会话 <序号\|名字> <新名字>` · `/rename` | 给会话登记表改名；旧名字带空格时写成 `重命名会话 "旧 名字" 新名字`（也认 `“”` / `「」`） | 登录者的会话 |
| `删除会话 <序号>` · `/delete`               | 从 WeMind 列表删除（若是当前会话则同时清当前会话记录，下条消息开新会话）        | 登录者的会话 |
| `任务 [<agent 名>：]正文` · `/task`             | 派发新任务（可指定 agent；不指定用默认任务大脑）                        | 登录者的任务 |
| `#<编号> 正文` · `/reply <编号> 正文`       | 发给指定任务（回任务都用它；不带前缀的消息走大脑）                      | 登录者的任务 |
| `任务列表` · `/tasks`                       | 编号 / agent / 状态（跑/等你）/ 轮次 / 时长 / 最近输出                  | 登录者的任务 |
| `结束任务 [编号]` · `结束全部任务` · `/stop` | 结束任务（「等你回复」的那条进程**留着复用**；「正在跑」的那条回合没法优雅取消，只能力杀；多条并存必须带编号） | 登录者的任务 |
| `帮助` · `/help`                            | 全部指令，按角色裁剪                                                    | 全部 |

上表前四条（`AI` / `切换大脑` / `切换任务大脑` / `交接`）是**账号级**指令——影响整个账号的大脑/进程；在代码里它们是 **owner-only**（非登录者会收到一句短提示、**不会**转发给大脑），这是一道**兜底校验**：微信平台上只有登录者本人能给这个 bot 发消息，所以它平时不会触发。其余指令（会话与任务类）永远只属于**登录者自己**——会话与任务按 `userId` 隔离。

> **跨账号之间没有任何权限**：每个微信账号各有自己的 bot、daemon 与登录者，谁也管不了谁——**不存在「主号」**。多账号与换大脑的范围详见 [多账号管理](#多账号管理) 的「换大脑的范围」。

### 远程任务（worker）：把漫长任务交给微信遥控

> 📖 完整使用方法（微信 + 本地终端两入口、典型流程、FAQ）见 **[docs/使用指南/使用指南-远程任务（worker）.md](docs/使用指南/使用指南-远程任务（worker）.md)**。

除了「对话大脑」，daemon 还能把**漫长任务**交给一个**受控的 ACP worker 进程**跑——你在电脑上派发任务后离开，它在「需要你决策」（如列方案让你选）或「中断」时把情况推到微信，你回一句就能让它续跑（远程 human-in-the-loop）。

worker 与对话大脑是**独立的 ACP 进程，互不干扰**——而且是**每个任务一条连接**（进程池：结束「等你回复」的任务时进程留着复用，空闲超 5 分钟回收；结束「正在跑」的那条只能力杀）：可以同时让 kiro 做任务 1、opencode 做任务 2。worker 跑在任务工作目录、继承所用 agent 真实配置目录的**全量 MCP（除 `wechat`）＋ 记忆/技能/模型**（kiro 即 `~/.kiro`，opencode 即 `~/.config/opencode`）。

**指令集**：

| 你发的消息                        | 去向                                                               |
| --------------------------------- | ------------------------------------------------------------------ |
| `任务：xxx` / `>xxx`              | 明确发给 worker：没任务时**启动**新任务；有活跃任务时发给它（唯一那条）；多条并存回一份编号清单 |
| `任务 <agent 名>：xxx`                | 用指定 agent **新开**一条任务（冒号前必须是不带空格的已知 agent 名；**只影响这一条**，不改默认任务大脑） |
| `#2 正文`                         | 把话发给**第 2 条**任务（多任务并存时用它指定编号）                        |
| `任务列表` / `结束任务 [编号]` / `结束全部任务` | 看 / 结束任务（不给编号 = 唯一那条；多条并存回一份编号清单）  |
| `问大脑 xxx`                      | 明确发给对话大脑（与任务并存时也用它）                              |
| `> 正文`                           | 「明确发给任务」的短前缀（无任务时新开一条；回任务主要用 `#<编号> 正文`） |
| 其它无前缀消息（含 worker 刚问你后；不含下一行的「继续」） | **一律走对话大脑**——任务不会再悄悄接管你的日常消息                  |
| 任务「已中断」或「等你回复」后回「继续」（无前缀） | 拉进程**续跑**可续跑的任务（唯一时直接续跑；多条时回编号清单让你指明）                  |

- **回任务要显式寻址**：`#2 正文`（全角 `＃2：正文` 也认）；每条任务结果/中断推送末尾都会带一行 `↩ 回这条任务用「#2 正文」；不带前缀的消息会交给大脑。`，照着写即可。
- 唯一的隐式续跑是裸「继续 / 接着跑 / continue」：存在可续跑的任务（有「等你回复」的，或没有活跃任务时存在「已中断」的）才交给任务侧；可续跑任务多条时它会回编号清单，不替你选。其它消息都归大脑。任务埋头跑时也一样。
- 任务编号**按用户单调递增、不复用**，且**跨重启不归零**。
- worker 每轮输出带 `🤖【任务】` 标记（**多条任务并存时为 `🤖【任务<编号>】`**）；跑一轮期间持续「正在输入中」（typing 不占连续发送上限）。
- **daemon 重启**、**provider 报错**（额度/密钥/计费/模型不可用）或**续跑接不上**时，任务标**「已中断」**并在 `任务列表` 可见；回「继续」（或 `#n 继续`）才拉进程续跑（按该 agent 支持的方式试 `session/load` → `session/resume`）。**普通回合失败**（进程退出/超时等）则仍停在**「等你回复」**——直接回 `#n 继续` 或补充内容，下一轮会重建进程并恢复上下文。接不上会如实说明「这次接不上」，并指出重试是同一结果、要重来就结束这条任务后重新派一条；半截回合的副作用可能已发生，续跑前会提示核对（**不会**自动续跑）。
- 并发上限默认 3（`WEMIND_MAX_WORKERS`），超出时派发被拒并提示。
- 完整用法见 [使用指南-远程任务（worker）](docs/使用指南/使用指南-远程任务（worker）.md)，实现细节见 [repowiki 07-远程任务-Worker](docs/repowiki/07-远程任务-Worker.md)。（`docs/设计文档/方案C-MVP-远程human-in-the-loop.md` 是 2026-06 的历史设计稿，其路由描述已被现行实现取代，不要拿它当行为说明。）

**本地终端入口**（与微信并列、管同一任务，**不依赖微信**）：在电脑前用 `wemind` 直接管 worker 任务，适合开任务时贴长描述 / 指定工作目录，或专注电脑工作不想掏手机时。

| 命令（`wemind …`）                            | 作用                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `task "<描述>" [--cwd <目录>] [--agent <名字>] [<key\|label>]` | 本地派发任务（默认 cwd=终端当前目录，可指定项目目录——微信入口做不到） |
| `task-list [<key\|label>]`                    | 任务列表（编号/agent/状态/轮次/时长）                                 |
| `task-status [<key\|label>]`                  | 任务概览（任务表有记录时与 `task-list` 同一份；表为空才退回读 `task-state.json` 记录） |
| `task-reply <编号> "<内容>" [<key\|label>]`（或 `task-reply "#编号 内容"`） | 回复/发话给任务（`task-reply 2 "继续"`；不给编号 = 唯一那条） |
| `task-stop [<编号\|全部\|all>] [<key\|label>]`                | 结束任务（不给编号 = 唯一那条，多条并存回一份编号清单）                   |

机制为**文件桥**：CLI 原子写 `task-inbox/*.json`（先写临时文件再改名；带 `ack` 答复编号），daemon 独立定时器扫描分发到同一套 task-manager，命令的真实结果写回 `task-out/<id>.json`（CLI 短轮询后打印它，所以「已派发」不会说谎：达上限被拒会如实说），状态写 `task-state.json`（另有一份 `tasks.json` 供重启续跑）。CLI 的 `brain switch` / `session *` 则走**控制桥**（daemon 在跑就进程内执行、回话给你）。daemon 没跑时的行为分三种：**读命令**（`session list`、`session current`、`task-list`）照常能读，只是按「下次会用的那个大脑」列、附一行说明；**纯文件操作**（`session rename` / `delete`、不带 `--worker` 的 `brain switch`）可离线直改；**必须由 daemon 执行**的（`session resume`、`brain switch --worker`、`brain handoff`）会失败并提示先 `wemind start`——`resume` 要真的让 agent `load` 那条会话。`session new` 在离线时不会报错，但它只能**丢掉当前会话记录**（下条消息开新的），**名字不会生效**（命名要等会话真建好）。详见 [docs/机制与协议说明/本地双入口-命令派发与查看回复.md](docs/机制与协议说明/本地双入口-命令派发与查看回复.md)。

### 进度提示与连续发送上限

iLink 限制 bot 在用户回复前能**连续发送的消息数**（实测约 10；超出服务端以 `ret=-2` 拒绝，导致消息丢失）。daemon 据此管理发送：

- **三档进度**（按**最终答案发出时间**分档，不是 Agent 首字时间；daemon 不把流式正文分段发到微信）：
  - `<5s`：只发最终答案。
  - `5–15s`：第 5s 发 `🤖 收到，正在处理…`，然后发最终答案。
  - `≥15s`：第 5s 发 `🤖 收到，正在处理…`；第 15s 再发一条——正文已开始输出时是 `✍️ 正在整理回复…`，否则是 `⏳ 还在处理中…`；之后不再补发第三条固定进度，等最终答案（心跳/工具步骤仍照旧）。
  - 工具步骤、心跳、图片提示、重试提示都算「已有可见进度」：5s 时已有进度就不再发「收到」；第 15s 的第二条要求距上一条非确认进度 ≥5s，不满足就跳过（不延后补发），避免和 `🔧 步骤 N` 叠在一起。
  - 最终答案开始发送或回合失败时取消两个定时器，不会在答案之后再补进度。
  - `🔧 步骤 N：…`：工具调用，首条即发，其后每 ≥15s 一条。文案优先用 agent 自己给的 purpose，否则从工具参数里取 command/路径/query（折行压平，超 60 字截断），避免把整段原始参数塞进微信。
  - `🤔 还在思考/检索中…` / `⏳ 仍在处理中…（已 X 秒）`：静默满 15s 的第 1 次 / 第 2 次起心跳。
  - "正在输入中"（typing）每 5s 续发、**不计入**上限。
- **接近上限**：发到「上限-2」（默认第 8 条）仍无最终答案时，第 9 条改发 `⚠️ 接近微信连续消息上限…回复「继续」`，随后暂停进度（靠 typing 撑存活）、把最后一条额度留给最终答案。
- **「继续」**：回复「继续」即重置配额、恢复发送（长任务可多次）。**你发任何消息都会重置**该计数（服务端按"距上一条用户消息"计数）。
- 相关变量：`WECHAT_CONSEC_SEND_LIMIT`（默认 10）、`WECHAT_MIN_SEND_GAP_MS`（默认 1500，两条发送最小间隔）。
- 超长任务需放宽大脑超时：`WECHAT_BRAIN_CAP_MS`（默认 15min）、`WECHAT_BRAIN_IDLE_MS`（默认 120s）。

### MCP 沙箱与对话式加载

brain 跑在独立的沙箱目录里（默认 `<数据目录>/brain-home`，由该 agent 预设的 `homeEnvVar` 环境变量指给它，如 kiro 的 `KIRO_HOME`、opencode 的 `XDG_CONFIG_HOME`；可用 `WECHAT_BRAIN_HOME` 覆盖），**默认不加载任何 MCP**——既快又杜绝 `wechat` 自身回环（内置工具如 `web_search` 仍可用）。

> **继承你的记忆与规则**：沙箱会用目录 junction 把所用 agent 真实配置目录里的「知识/记忆」类子目录链进来，让微信里的大脑和你日常使用读到**同样的记忆、规则、技能**。`settings/` 里**除 `mcp.json` 外**的文件（尤其 `cli.json`，含 `chat.defaultModel` 等——这决定大脑用哪个模型！）也会同步过来，**只有 `mcp.json` 隔离 curated**（防 `wechat` 回环）；`sessions`（brain 自有会话）保持沙箱本地。**按 agent 配置驱动**（`brain-agents.ts` 里该 agent 的 `realHome`/`inheritDirs`）：kiro 预置 `steering`/`memories`/`skills`/`agents`/`powers`/`tasks`/`extensions` 等目录；gemini / opencode / deepseek / qoder / cline / pi / claude-code 也各自按预设继承 `skills` / `agents` / `commands` / `memory` 等目录与设置基底，`sandbox-inherit.ts` 会在换 agent 时按清单清掉上一个 agent 留下的继承项；`codex` 的适配器不认沙箱配置目录，因此不继承。非空目录（如 kiro 自建 agents 脚手架）会补拷缺失文件。可用 `WEMIND_BRAIN_REAL_HOME` / `WEMIND_BRAIN_INHERIT_DIRS` 覆盖，`WEMIND_BRAIN_INHERIT=0` 可关闭。**注意：直接改 agent 自己的配置文件换模型后，旧 ACP 会话可能仍绑旧模型，需在微信发「新会话」重建**（用 `wemind brain set --model` 再 `switch` 会在会话建立/恢复时重下发模型，不受此限）。需要某个 MCP 时，直接**在微信里发指令**（daemon 拦截处理，不进 brain）：

| 指令                        | 作用                                            |
| --------------------------- | ----------------------------------------------- |
| `MCP` / `列出 MCP` / `/mcp` / `mcp list` | 列出可选 MCP（来自全局 `mcp.json`）与当前已激活 |
| `加载 <名>` / `load <名>`   | 把指定 MCP 加入激活集（`wechat` 永久禁止）      |
| `卸载 <名>` / `unload <名>` | 移除                                            |
| `新会话 [名字]` / `/new`    | 开启新 ACP 会话（清空多轮上下文）；给名字便于在 `会话列表` 里认出来 |

加载/卸载 MCP 时，**只有激活集真的变了** daemon 才会重启 ACP 进程以按新沙箱配置重载，下一条消息生效（重复加载已激活项、卸载未激活项都不会重启；切脑进行中会先等切换结束再重启）。激活的 MCP 等于对登录者全权开放（内置预设默认免审批，见[「切换大脑 Agent」](#切换大脑-agent通用化)），按需加载、用完可卸载。

### 切换大脑 Agent（通用化）

daemon 的大脑通过 **ACP（Agent Client Protocol，JSON-RPC 2.0 over 标准输入输出）** 驱动，未配置时默认 `auto`（按 `opencode → cline → qoder → gemini → deepseek → kiro` 探测已安装者）。

**能不能接：四个必要条件**（详见 [docs/接入方案/接入其它-ACP-Agent.md](docs/接入方案/接入其它-ACP-Agent.md) §0）

| # | 条件 | 说明 |
| --- | --- | --- |
| 1 | 有**可执行入口** | daemon 要把它**启动为子进程**；纯 HTTP API（OpenAI / Anthropic / Ollama）没有进程可启动，目前接不了 |
| 2 | **实现 ACP**，或有 **ACP 适配器** | 原生实现：kiro / opencode / gemini（探针级实测 + 真机 E2E）/ DSH / Qoder / Cline；需适配器：Claude Code（`@agentclientprotocol/claude-agent-acp`，已探针级实测 + 真机微信单轮 E2E）、Codex（`@agentclientprotocol/codex-acp`，已探针级实测 + 真机 E2E）、pi（`pi-acp` + pi 本体，已探针级实测 + 真机 E2E，2026-11-01） |
| 3 | ACP 实现覆盖**最小方法集** | 至少 `initialize` + `session/new` + 能流式回包的 `session/prompt`；先用 `wemind brain check` 真握手 |
| 4 | 能**完成认证**且二进制可解析 | PATH 上能找到，或用 `--bin` 给绝对路径；`.cmd`/`.bat` 需经 shell |

> **「支持 ACP」四个字不足以说明可用**：`session/load`、`session/resume`、图片输入、MCP 传输、反向请求都是**可降级项**（agent 没实现就退到简单做法），按 agent 而异（见 `packages/wechat-daemon/src/agents/brain-presets.ts` 的 `AcpAgentPreset` 字段与 [docs/接入方案/接入其它-ACP-Agent.md](docs/接入方案/接入其它-ACP-Agent.md) §9）。接入前先跑能力探针。

| 环境变量                | 作用                                                | 默认         |
| ----------------------- | --------------------------------------------------- | ------------ |
| `WEMIND_BRAIN`          | 选 agent（如 `kiro`、`opencode`、`deepseek`、`auto`） | `auto`       |
| `WEMIND_BRAIN_BIN`      | 覆盖二进制（绝对路径或 PATH 上的名字）              | 自动解析     |
| `WEMIND_BRAIN_ARGS`     | 覆盖进入 ACP 模式的启动参数（空格分隔，整段替换）   | 内置默认值   |
| `WEMIND_BRAIN_EXTRA_ARGS` | 追加启动参数（空格分隔，拼在预设/覆盖参数之后）   | 无           |
| `WEMIND_ACP_SESSION_MODE` | 覆盖/关闭预设的会话模式（`session/set_mode`）：`0`/`false`/`off`/`no` 关闭，其它值 = 该 modeId | 用预设值 |
| `WEMIND_BRAIN_HOME_ENV` | 覆盖「agent 配置目录环境变量名」（指向 brain 沙箱） | 内置默认值   |
| `KIRO_CLI_BIN`          | 旧的 kiro 专用二进制覆盖（仍兼容）                  | —            |

`kiro`（内置）= `kiro-cli acp --trust-all-tools` + `KIRO_HOME` 指向沙箱。要接入新 agent，在 `ACP_AGENT_PRESETS` 里加一条、或直接用上面四个变量。持久化选择用 `wemind brain set <agent 名> [--bin ...] [--args "…"] [--extra-args "…"] [--shell|--no-shell] [--model ...] [--restart]`（写入 `<数据目录>/brain.json`，任何入口重启都复现；`--args` 是**整段替换**、`--extra-args` 追加在末尾——只加开关（如免确认）用后者，漏掉 `acp` 这类模式参数会握手超时，`wemind brain` 会给出警告；只给 agent 名且 daemon 在跑并认控制桥时会**立刻当场应用（不用重启）**，带 `--bin/--args/--extra-args/--shell/--model` 则只写盘——其中 `--bin`/`--args`/`--extra-args`/`--model` 的改动可由随后的 `wemind brain switch <同名 agent>` 当场应用（「是不是同一个」按 name/bin/args/model 判），`--shell` 要重启）。**模型**同样可配：`--model '["provider 路由","模型名"]'` 指定；**`--model auto` = 跟随你日常那个 agent 的默认**——DSH 读真实 `~/.dsh/profiles/acp/cordis.patch.yml`（优先你自己写的 `- id: acp`，否则 `agent-default-model`；典型 `["magpie","auto/deepseek-v4.1-flash"]`，需桌面端 DeepSeek Harness 在运行；读不到就不下发）。**运行时切换**用 `wemind brain switch <agent 名>` 或微信里发 `切换大脑 <agent 名>`——进程内换、失败自动退回原来那个，见 [`docs/repowiki/06-ACP-大脑与沙箱.md`](docs/repowiki/06-ACP-大脑与沙箱.md)。

**内置预设默认免审批**（每个 agent 用自己官方的机制，不是统一开关）：kiro `--trust-all-tools`、gemini `--acp --approval-mode yolo --skip-trust`、qoder `--acp --yolo`、cline `--acp --auto-approve true`、opencode 写进沙箱 `opencode.json` 的 `"permission": "allow"`（它没有 ACP 可用的 `--auto`）、DSH `DSH_PERMISSION_MODE=danger-full-access`、claude-code 会话建立后 `session/set_mode bypassPermissions`、codex `agent-full-access`、pi 默认不逐次审批（无开关）。想收紧时**不用改预设**：`--args` 整段替换启动参数，`DSH_PERMISSION_MODE` / `INITIAL_AGENT_MODE` 这类审批开关属于「默认值」（`envDefaults`：daemon 进程环境里同名变量优先），`WEMIND_ACP_SESSION_MODE=0` 可关掉 claude-code / codex 的会话模式切换（其它非空值 = 换成该 modeId）。边缘情况下 agent 仍可能发权限请求（如 claude-code 的 ask 规则），WeMind 默认拒绝，要全部放行设 `WEMIND_ACP_AUTO_ALLOW=1`。各 agent 的准确参数与出处见 [docs/接入方案/接入其它-ACP-Agent.md](docs/接入方案/接入其它-ACP-Agent.md) §5。

> 详细步骤、各 agent 需确认的 4 件事、MCP 沙箱差异、验证方法见 [docs/接入方案/接入其它-ACP-Agent.md](docs/接入方案/接入其它-ACP-Agent.md)。
>
> **OpenCode 已内置 agent**：`WEMIND_BRAIN=opencode` 即可让 `opencode acp` 当大脑（自动用 `XDG_CONFIG_HOME` 隔离配置目录、curated MCP、继承记忆/技能）。完整设计、M1 实测与风险见 **[docs/接入方案/接入-OpenCode.md](docs/接入方案/接入-OpenCode.md)**。
>
> **Claude Code 已内置（探针级实测 + 真机微信单轮 E2E）**：先 `npm i -g @agentclientprotocol/claude-agent-acp`（**Node ≥22**；Windows 得到 `claude-agent-acp.cmd`），再 `wemind brain set claude-code`。预设用 `CLAUDE_CONFIG_DIR` 隔离沙箱（`~/.claude.json` 一并隔离），`CLAUDE.md`/`skills`/`agents`/`commands` 与日常共用；MCP 走 ACP（目录取真实 `~/.claude.json`）；免审批走 `session/set_mode bypassPermissions`。真机微信单轮 E2E 已通过（2026-10-31）；重启续聊/MCP/任务待复测。详见 **[docs/接入方案/接入-ClaudeCode.md](docs/接入方案/接入-ClaudeCode.md)**。
>
> **DeepSeek 已接入（官方 DSH，微信 brain + worker E2E 已通）**：`wemind brain set deepseek --bin "<...>\dsh.cmd"` 即用 `dsh --profile acp` 当大脑；内置配置已处理 `DSH_HOME` 沙箱、`.credentials.yaml`、**默认模型跟随你日常 dsh**（把真实 `profiles/acp/cordis.patch.yml` **原样**同步进沙箱并从它读默认——优先你自己写的 `- id: acp`，否则 `agent-default-model`；**WeMind 不替你改 agent 的配置**：文件里缺 `- id: acp` 时 `wemind brain` 会给一段可粘贴的 YAML，让你补到真实 profile，补完终端 dsh 与微信大脑才是同一个模型；桌面端改模型后，重启 daemon 或 `wemind brain switch deepseek` 时跟着改；没写 `--model` 时读不到才回退 `deepseek-account/deepseek-flash`；`magpie` 路由需桌面端在运行）、`session/resume`、**动态 MCP（`加载/卸载` 经 ACP `mcpServers` 生效）**、图片拦截。实测与限制见 **[docs/接入方案/接入-DeepSeek.md](docs/接入方案/接入-DeepSeek.md)**（M3–M5 的验证结果见该文附录）。

> **Qoder 已内置 agent（M0–M3 已完成）**：`wemind brain set qoder` 即用 `qodercli --acp --yolo` 当大脑；内置配置已处理 `QODER_CONFIG_DIR` 沙箱、`.auth/user` + `.auth/machine_id` 登录态同步、`settings.json` 基底（剥离 `providers`/`model`、关自动更新）、文件式 MCP、`memory/` 记忆继承。需先 `qoder login`。实测与限制见 **[docs/接入方案/接入-Qoder.md](docs/接入方案/接入-Qoder.md)**。
>
> **Cline 已内置 agent（原生 ACP，3.0.74 实测）**：装 `npm i -g cline` 后 `wemind brain set cline` 即用 `cline --acp --auto-approve true` 当大脑；`providers.json` 登录态同步、`models.json` 模型目录同步（缺它会回退 `gpt-4o`）、`mcp.json` 文件式 MCP。**认证**：ACP 只自动恢复 `cline` / `cline-pass` / `openai-codex`；自定义/API-key provider 由 WeMind 从 `providers.json` 自动派生 `CLINE_PROVIDER` + `CLINE_API_KEY`（父进程显式设了就不接管），通常无需手工配置。实测与限制见 **[docs/接入方案/接入-Cline.md](docs/接入方案/接入-Cline.md)**。
>
> **pi 已内置（探针级实测 + 真机 E2E，2026-11-01）**：先 `npm i -g @earendil-works/pi-coding-agent`（pi 本体，**Node ≥22.19**——它的 engines 要求，比适配器的 ≥20 更严）并在终端里 `pi` 登录/配好模型，再 `npm i -g pi-acp`（社区适配器），然后 `wemind brain set pi`。预设用 `PI_CODING_AGENT_DIR` 隔离沙箱（`settings.json` / `auth.json` / `models*.json` 原样同步，`skills/` junction、`AGENTS.md` 复制）；MCP 走 pi 自己的 `<沙箱根>/mcp.json`（`pi mcp list` 实测，kiro 格式）；免审批无需开关（pi 默认不逐次审批）；启动横幅用 pi 自己的 `quietStartup` 在沙箱里关掉（不进微信回复）。**只装适配器不够**——`requiresBins: ["pi"]` 会提前报「运行时 pi 缺失」。**不在自动探测**，只能显式选用。详见 **[docs/接入方案/接入-pi.md](docs/接入方案/接入-pi.md)**。

### 收发图片

- **收图**（用户发图 → 大脑看图）：daemon 下载并 AES-128-ECB 解密入站图片，作为 ACP image 块喂给大脑——**前提是该 agent 真正接受图片**（kiro / opencode / qoder / gemini / claude-code / codex / pi 支持；DSH 官方 0.2.1-rc.2 与 **Cline 3.0.74** 实测不可用，带图会被友好拒绝；Cline 虽广告 `image:true`，但 ACP prompt 只保留 text 块。claude-code 的 ACP `promptCapabilities.image: true`，但本机网关对实测用的 1×1 PNG 报 400，属上游限制）。
- **发图**（大脑发图 → 用户）：大脑在回复里用 **Markdown 图片语法 `![](图片的 http 链接或本地文件绝对路径)`**，或直接给出**裸图片 URL**，daemon 会自动把它下载/读取后作为图片消息发出，并把剩余文字另发。大脑本身不会文生图，但能发：联网搜到的图、本地已有的图、自己用代码渲染保存的图表。底层走 `getUploadUrl` + AES-128-ECB 加密上传 CDN（`no_need_thumb`，免缩略图）。**URL 只接受公网 http(s)**：本机/内网/回环（`localhost`、私有 IP、链路本地、IPv6 映射）以及重定向到这些地址的请求一律拒绝（重定向逐跳校验、最多 3 跳）；本地文件绝对路径仍然可用。
- **发文件 / 视频**：core `sendFile` 按扩展名自动判类型（图/视频/文件），组装 `image_item / video_item / file_item`，上传链路与发图同构。
- **收语音**（语音输入）：用户发语音 → 直接取 `voice_item.text`（微信侧已做语音转文字）当文本喂大脑，**零依赖**（无需 SILK 解码/外接 ASR）。**发语音**（bot 语音回复）暂不做（需 TTS + SILK，且语音回复体验通常不如文本）。

### 长回复自动转 .md 文件

- 当大脑最终回复正文**超过阈值**（默认 1500 字，`WECHAT_REPLY_FILE_THRESHOLD` 可覆盖）时，daemon 不再把长文拆成多条文本，而是作为**单个 `.md` 文件**发送：一条消息、规避连续发送上限、阅读完整。
- 文件名由**内容生成合适标题**（取首个 Markdown 标题或首个非空行，清洗为合法文件名）；正文若无标题则在文件内前置一个 H1。发文件失败时**兜底回退为文本**。

### Windows 登录自启

**安装版（`npm i -g @wemind/cli`）**：计划任务/启动文件夹只需执行一次 `wemind start <账号>`。`wemind start` 会拉起自带后台守护进程（`wemind _watchdog`）后立即返回，崩溃重拉由它负责；重复执行安全（会先停旧实例）。例如启动文件夹放一个 `.bat`：

```bat
@echo off
wemind start 我的号
```

**源码开发者**：优先用计划任务（PS7 全路径、登录触发、崩溃重拉由 `scripts/run-daemon.ps1` 的循环负责）：

```powershell
$pwsh = "C:\Program Files\PowerShell\7\pwsh.exe"
$wrapper = "<仓库绝对路径>\scripts\run-daemon.ps1"
$action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapper`""
Register-ScheduledTask -TaskName "wemind-daemon" -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew) -Force
```

若环境禁止创建计划任务（提示「拒绝访问」），改用**启动文件夹**自启：在
`shell:startup`（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`）放一个
`.vbs`，用 `WScript.Shell.Run` 以隐藏窗口调用上面的 `pwsh ... -File scripts/run-daemon.ps1`。

> **注意 · 安装版没有 `scripts/`**：上面的 `run-daemon.ps1` 只存在于源码仓库；用 npm 安装的 CLI 请直接用 `wemind start`（自带后台守护进程），不要去找仓库脚本。

> **注意 · node 由版本管理器管理时**：若 `node` 由 **fnm / nvm / Volta** 这类「只往交互 shell 注入 PATH」的工具管理，登录任务/服务（`-NoProfile`、无 shell 注入）的持久 PATH 里通常**没有 node**：`run-daemon.ps1` 会找不到它，且 daemon 拉起的大脑（如 `opencode acp`）也解析不到。`scripts/run-daemon.ps1` 已内置回退（fnm `%APPDATA%\fnm\aliases\default`、Volta、`C:\Program Files\nodejs`）并把命中目录**前置进 PATH**；若安装位置不在其中，请改脚本候选或直接用绝对路径的 node 启动。另：PS7 若只以 WindowsApps 别名存在（无 `C:\Program Files\PowerShell\7\pwsh.exe`），优先走上面的 VBS 退路。

> 常驻底层原理（三层进程树、后台守护进程循环、单实例 Mutex、开机自启、多账号隔离、pid 链与故障恢复）详见 [docs/部署与运维/daemon-常驻原理.md](docs/部署与运维/daemon-常驻原理.md)。
>
> **跨平台（Windows/Linux/macOS）常驻**：用 pm2 + 根目录 `ecosystem.config.cjs` 即可，详见 [docs/部署与运维/跨平台常驻-pm2.md](docs/部署与运维/跨平台常驻-pm2.md)。上面的 PowerShell 方案为 Windows 专用，二者对同一账号**只用一套**。

## 多账号管理

支持登录多个微信账号，每个账号一份独立目录 `~/.wemind/<key>/`，`key` 由微信 **botId** 派生（唯一、自动获取；当前 iLink 接口不返回昵称/微信号，故用 botId，另存可编辑的 `label` 别名）。账号清单记录在 `~/.wemind/accounts.json`。不同账号 = 不同 token = 各跑一个 daemon，互不冲突。

> **key / label / 默认账号 / 登录者（owner）是四个不同概念**：`key`（botId 派生）是唯一标识、也是目录名，系统据它区分；`label` 是人类可读别名（可改、可重复、**无任何权限含义**；`--label 工作号` 里的「工作号」只是随手起的别名——**别用「主号」「主账号」这类词**，它们会被误读成「有权限的那个账号」）；**默认账号**（`set-default` 设置、`list` 标 `[默认]`、**首个登记的账号自动成为它**）只决定「CLI 里省略账号时用哪个」；**登录者（owner）是按账号算的**——每个账号的登录者就是扫码登录它的那个微信号（`account.json` 的 `userId`），它决定微信侧那四条「仅登录者」命令（`AI`/`切换大脑`/`切换任务大脑`/`交接`）谁能发。**它不是「主号」**：一个账号的登录者跟别的账号没有任何关系，不存在「一个账号拥有其它账号权限」这回事。下列命令多数 **可用 key 或 label 选择账号**（label 唯一匹配时）；`start`/`stop` 与会话/任务类命令**省略账号 = 默认账号**。

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
| `start [<key\|label>]`         | 启动 daemon（省略账号 = 默认账号）                                      |
| `stop [<key\|label>]`          | 停止 daemon + brain + 全部 worker 进程树（省略账号 = 默认账号）         |
| `logout <key\|label>`          | 停 daemon + 通知下线 + 清凭证（保留目录，可重登）                       |
| `delete <key\|label>`          | 停 daemon + 删除目录 + 移除注册                                         |
| `label <key\|label> <新别名>`  | 改别名                                                                  |
| `set-default <key\|label>`     | 设默认账号                                                              |
| `adopt <key> [--label 名]`     | 把已存在的账号目录登记进注册表                                          |
| `allowlist <key\|label>`       | 查看该账号的登录者白名单（allowFrom）                                   |
| `allow <key\|label> <userId>`  | （兜底）把某 userId 加入白名单                                          |
| `revoke <key\|label> <userId>` | （兜底）从白名单移除某 userId                                           |

### 多账号下的「换大脑」：范围、限制、两个入口的区别

**N 个账号 = N 个 daemon**：每个账号各有自己的 `brain.json`、会话表、沙箱与进程树，互不干扰。换大脑是**账号级**的（一个 daemon 同一时刻只有一个活跃对话大脑），**切一个账号不会影响任何别的账号**。两个入口的对照：

| | 微信里发 `切换大脑 X` | 本机 CLI `wemind brain switch X [<key\|label>]` |
| --- | --- | --- |
| 作用对象 | **只作用于收到这条消息的那个账号**——消息进的是哪个 daemon，就切哪个 | **可指定任意账号**（省略 = 默认账号） |
| 谁能做 | 只有该账号的**登录者**（= 唯一能给这个 bot 发消息的人；微信平台限制，别人根本发不进来） | 能在本机敲命令的人（= 机主）：不经过微信、不需要登录态，也**不受「仅登录者」限制** |
| daemon 在跑 | 进程内**换大脑（不用重启）**：不打断在途回合，失败自动退回原来那个 | 同样经控制桥当场换（等它回话；`brain switch` 的超时自动放大到 等在途回合结束+启动新大脑+15s） |
| daemon 没跑 | —（没有 daemon 就没有微信侧） | `brain switch` **只写该账号的 `brain.json`**，答复注明「下次启动生效」；`--worker` 设的默认任务大脑**只存在进程内**，必须先有 daemon |

限制与边界：

- **没有跨账号操作**：微信侧天然只影响「消息进来的那个账号」；CLI 要切别的账号必须**显式写 `key`/`label`**，也没有「一次切全部」的命令——逐个账号切即可。查看与自检同理：`wemind brain [show] [<key\|label>]`、`wemind brain check [<key\|label>]`（省略 = 默认账号）。
- **一个账号一个活跃大脑**：切换是账号级全局，不是「每条会话/每条任务一套」。想用别的 agent 跑任务，用「切换任务大脑」或 `任务 <agent 名>：正文`（worker 侧，与对话大脑互不影响）。
- **CLI 的可达范围 = 本机**：控制桥是本地文件桥，只接受**agent 名与纯数据**（不接受自定义 bin/args，所以 `brain switch` 带 `--bin` 会被拒，那是 `brain set` 的活），只有能访问 `~/.wemind/<key>/` 的本机用户能用——**没有远程/网络入口**。
- **写入磁盘口径两个入口一致**：都是**新大脑启动成功才写 `brain.json`**，失败退回不改盘。
- **`WEMIND_BRAIN` 环境变量会压过一切**：它存在时，重启后仍回到它指的大脑（切换答复里有警告）。
- **环境变量是进程级的，不是账号级的**：`WEMIND_BRAIN`、API key、`WEMIND_MAX_WORKERS` 等由启动 daemon 的 shell 提供，同一 shell 启动的 N 个账号会一起继承——`WEMIND_BRAIN` 会同时压过每个账号的 `brain.json`（重启后都回到它指的大脑），`WEMIND_MAX_WORKERS` 是**每个 daemon 各自**的上限（N 个账号合计最多 N × 值）。用 `scripts/run-all-daemons.ps1` 拉起多账号时可设 `WEMIND_MAX_WORKERS_TOTAL`，脚本会按账号数均分后注入每个子进程（只覆盖它拉起的 daemon，已在运行的需重启）；单独 `wemind start` 的账号仍各按自己的值。要按账号取不同值，就分开环境启动；持久的大脑选择用各账号的 `wemind brain set`。
- **少数 agent 仍会读真实 home**：微信消息、会话表、任务表与沙箱本身都是按账号隔离的，但有个别 agent 不支持把配置目录指到沙箱——`codex` 的适配器没有沙箱配置目录（认证/配置取真实 `~/.codex`）；`pi` 经 `pi-acp` 读真实 `~/.pi/pi-acp/session-map.json`、`~/.pi/agent/prompts`、`~/.agents/skills`；`qoder` 的 `memory/` 是指向真实 `~/.qoder/memory` 的 junction。**同一台机器上多个账号由不同的人使用**时，要意识到这些数据是共享的；同一个人自用多账号不受影响。详见 [repowiki 06](docs/repowiki/06-ACP-大脑与沙箱.md#少数-agent-的真实-home-仍跨账号共享)。

**自启全部账号**：`scripts/run-all-daemons.ps1` 读注册表为每个账号起一个 daemon（各账号单实例守卫，重复运行安全）。**开机自启要你自己配**：仓库不带现成的 `.vbs`——按上节「Windows 登录自启」在 `shell:startup` 放一个 `.vbs`，让它调用 `scripts/run-all-daemons.ps1`，开机才会拉起所有已登记账号。（`scripts/` 只在源码检出里，npm 安装的包没有它。）

## 常见问题

**装完打不开 / 提示命令不存在**
```bash
npm i -g @wemind/cli                # 重新全局安装（升级也是同一条命令）
wemind version                      # 确认装上且版本正确
```
不想全局安装、只想临时跑一次时用 `npx -y @wemind/cli version`（`npx` 按包名解析，`npx wemind` 不可用）；不带版本号时 npx 会解析 `latest`，要固定版本可写 `@wemind/cli@<版本号>` 或改用全局安装。

**扫码后一直卡在加载**
切到手机流量（关掉 WiFi）再扫一次；二维码过期会自动刷新（`wemind login` 的整体登录窗口是 15 分钟，超时会提示重新扫码；MCP 形态的二维码本身 5 分钟内有效，过期后重新调 `login_qrcode`）。

**登录成功但发给它没反应**
1. `wemind list` 看是否「运行中」，`wemind brain check` 看大脑是否可用；
2. 看日志：`~/.wemind/<账号>/daemon.log`，搜 `prompt ok`（有 = 大脑回了）或 `prompt FAIL`（有 = 大脑出错）；
3. 大脑不可用会以退出码 **78** 退出；同账号已有实例以 **75** 退出，两者都会**停止自动重启**——先修大脑或处理残留实例，再 `wemind start <账号>`。

**回复到一半停了 / 让我回「继续」**
这是微信**连续发送上限（约 10 条）**的保护：进度消息也占额度。回复「继续」即可接着来；长任务建议拆小。

**两个 bot 抢消息 / 同一条消息回两遍**
同一 bot token **只能有一个程序收消息**。检查是否同时跑了 `wemind` daemon 和 `@wemind/wechat-mcp`，或同一账号被启用了两套常驻（pm2 + 内置后台守护进程），二选一。

**改了代码/升级后行为没变**
正在运行的 daemon 不会自动换代码：`wemind stop <账号> && wemind start <账号>`。

**安全提示**
daemon 的**内置预设默认免审批**（每个 agent 用自己官方的开关；见上节），**消息一旦被接受**即可让 AI 在本机执行工具。**微信平台只发送登录者本人的消息**（必须扫码登录该 bot 才能给它发消息），代码里另有**登录者白名单（allowFrom）**作为兜底：默认拒绝、默认只放行「登录者」（扫码登录这个 bot 的那个微信号，登录时自动写入），**请勿清空**。详见 [安全说明](#安全说明) 与[daemon 一节的「安全（务必读）」](#daemon脱离-ide终端常驻自动收发)。

更多排障：[docs/ai/recipes/debug-daemon.md](docs/ai/recipes/debug-daemon.md) ｜ 面向新手的完整 FAQ：[docs/使用指南/新手教程.md](docs/使用指南/新手教程.md) §常见问题

## 致谢

- Fork 自 [Howardzhangdqs/mcp-wechat-server](https://github.com/Howardzhangdqs/mcp-wechat-server)（MIT）。
- iLink 协议细节、session-guard 与上下线通知实现借鉴自微信官方插件 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）。

## 许可证

[MIT](LICENSE) —— 沿用原项目 [Howardzhangdqs/mcp-wechat-server](https://github.com/Howardzhangdqs/mcp-wechat-server)（同为 MIT）。

---

> **最后核对**：2026-11-05 ｜ 本文档描述当前分支的最新代码，已发布版本见 [CHANGELOG](docs/发布与变更记录/CHANGELOG.md) 与 npm；接入类结论请看对应文档的「实测/假设」标注。
