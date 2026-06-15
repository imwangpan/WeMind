# WeMind

> *Your AI mind, reachable on WeChat.*

基于 MCP（Model Context Protocol）的微信 AI 机器人，让任何 AI Agent 都能收发微信消息。

> **关于本 Fork**
>
> Fork 自 [Howardzhangdqs/mcp-wechat-server](https://github.com/Howardzhangdqs/mcp-wechat-server)，主要改动：
> - **支持 Node.js 运行**（原项目仅支持 Bun）：`tsc` 构建到 `dist/`，用 `node` 运行
> - **补齐 iLink 协议请求头** `iLink-App-Id` / `iLink-App-ClientVersion`（连接所需）
> - **处理会话超时**（errcode `-14`），补 `notifyStart` / `notifyStop` 上下线通知
> - 修复回复引用（`ref_msg`）死代码、修复 server 版本号硬编码
> - Windows 凭证权限处理与安全提示、补单元测试与 CI
>
> iLink 协议细节、session-guard 与上下线通知实现借鉴自微信官方插件
> [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）。

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

| 包 | 路径 | 说明 | 发布 |
|------|------|------|------|
| `@wemind/wechat-ilink-core` | `packages/wechat-ilink-core` | iLink 协议内核：HTTP 客户端、类型、会话守卫、账号/状态持久化、收图解密。不依赖任何「消费方」 | 私有（内联进 mcp-server） |
| `@wemind/wechat-mcp` | `packages/wechat-mcp` | MCP server：把内核能力暴露为 MCP 工具，供任意 MCP 客户端接入 | **可发布**（bin: `wemind-mcp`） |
| `@wemind/wechat-daemon` | `packages/wechat-daemon` | 独立常驻守护进程：长轮询 + 常驻 ACP 大脑自动收发 | 私有（本机运行） |

`mcp-server` 发布时用 [tsup](https://tsup.egoist.dev/) 把 `core` **内联**进单一产物，因此对外只需发布这一个自包含的包；`daemon` 在本仓库内通过 workspace 直接引用 `core` 源码，永不发布。

## 快速开始

> **接入形态**：`@wemind/wechat-mcp` 设计为可发布的独立 npm 包，未来可用 `npx -y @wemind/wechat-mcp` 直接接入。当前尚未发布到公共 registry，请先按「本地开发」构建，再用绝对路径指向 `packages/wechat-mcp/dist/index.js` 接入 MCP 客户端。

### Claude Desktop

在 `claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "wechat": {
      "command": "node",
      "args": ["/abs/path/to/mcp-wechat-server/packages/wechat-mcp/dist/index.js"]
    }
  }
}
```

### OpenCode

在 `opencode.json` 中添加：

```json
{
  "mcp": {
    "wechat": {
      "type": "local",
      "command": ["node", "/abs/path/to/mcp-wechat-server/packages/wechat-mcp/dist/index.js"],
      "enabled": true
    }
  }
}
```

### Cursor / 其他 MCP 客户端

```json
{
  "command": "node",
  "args": ["/abs/path/to/mcp-wechat-server/packages/wechat-mcp/dist/index.js"]
}
```

## 使用方法

### 1. 扫码登录

AI Agent 调用 `login_qrcode` 生成二维码，你可以通过以下方式扫码：

- 在终端运行 `cat ~/.mcp-wechat-server/qrcode.txt` 查看二维码
- 打开图片文件 `~/.mcp-wechat-server/qrcode.png`
- 将链接复制到微信中打开

> **提示**：如果手机扫码后页面一直加载，请切换到**移动数据网络**（关闭 WiFi）。

<img src="assets/opencode_screenshot1.png" alt="OpenCode 登录二维码" width="600">

### 2. 确认登录

Agent 调用 `check_qrcode_status` 确认登录状态。

### 3. 开始聊天

登录成功后，Agent 会自动执行以下流程：

1. 调用 `get_messages` 轮询新消息
2. 收到消息后调用 `send_typing` 显示"正在输入..."
3. 处理完成后调用 `send_text_message` 回复
4. 回复完毕后调用 `send_typing` 取消打字状态

<img src="assets/wechat_screenshot1.jpg" alt="微信收发消息" width="400">

<img src="assets/opencode_screenshot2.png" alt="OpenCode Agent 交互" width="600">

<img src="assets/wechat_screenshot2.jpg" alt="微信收到回复" width="400">

## 工具列表

| 工具 | 说明 |
|------|------|
| `login_qrcode` | 生成微信登录二维码 |
| `check_qrcode_status` | 检查二维码是否已扫码确认 |
| `logout` | 退出登录并清除凭证 |
| `get_messages` | 拉取新消息（`wait=true` 阻塞等待直到收到消息） |
| `send_text_message` | 发送文本消息 |
| `send_typing` | 发送或取消"正在输入"状态 |

## 数据存储

运行时状态保存在 **`~/.wemind/<account>/`** 下(默认账号 `default`，即 `~/.wemind/default/`)。该目录**独立于代码仓库**——改名/重装/重新 clone 代码都不影响登录态。

| 文件/目录 | 说明 |
|------|------|
| `account.json` | Bot Token、botId、userId、baseUrl（POSIX 下权限 600；**Windows 下为明文**，见「安全说明」） |
| `state.json` | 长轮询游标（`updatesBuf`）、各会话 `context_token`、`lastMessageId`（去重） |
| `qr_login.json` / `qrcode.png` / `qrcode.txt` | 扫码登录临时态与二维码（登录后即失效） |
| `brain-sessions.json` | `userId → ACP sessionId` 映射，daemon 重启后据此 `session/load` 恢复多轮上下文 |
| `brain-mcps.json` | brain 当前激活的 MCP 集（默认空） |
| `brain-home/` | brain 的沙箱 `KIRO_HOME`（独立于你本人的 `~/.kiro`），含 `settings/mcp.json`（默认空）与各 ACP 会话落盘记录 |

**多账号**：每个微信账号一份独立子目录。用 `WECHAT_ACCOUNT=<名>` 切换（→ `~/.wemind/<名>/`），或用 `WECHAT_DATA_DIR=<完整路径>` 指定任意目录。不同账号 = 不同目录 = 完全隔离，可各自登录、各跑一个 daemon。

> **重置**：删 `account.json`+`state.json` = 退出登录重新扫码；删 `brain-sessions.json`+`brain-home/sessions/` = 清空对话记忆。

## 本地开发

```bash
git clone https://github.com/imwangpan/mcp-wechat-server.git
cd mcp-wechat-server
npm install
npm run build      # 按 core → daemon/mcp-server 顺序构建各包
npm start          # 运行 node packages/wechat-mcp/dist/index.js
npm test           # 运行单元测试
npm run dev -w @wemind/wechat-mcp   # tsx 热重载开发 mcp-server（可选）
```

## 安全说明

- **凭证存储**：`account.json` 含 Bot Token。POSIX 系统会设为权限 `600`；**Windows 上 `chmod` 无效，文件以明文存放且不受权限限制**——启动保存时会有一次性告警。请用文件夹权限或磁盘加密保护 `~/.mcp-wechat-server/` 目录。
- **隐私**：消息经由腾讯 iLink 渠道与本地 Agent 流转，涉及对话内容外发，请自行评估。

## 关于 iLink 渠道与限制

- 后端为腾讯官方 **iLink / 微信 ClawBot** 接口（`ilinkai.weixin.qq.com`），面向**个人微信账号**，区别于企业微信。按官方用途使用，不存在逆向 bot 那类封号风险。
- **不能主动发起对话**：只能在收到用户消息后、于该会话上下文内回复（发送依赖收消息得到的 `context_token`）。
- **服务稳定性**：这是腾讯新开放的插件功能，官方条款保留随时停服的权利，请勿用于关键业务。
- 需要较新的微信客户端并启用 ClawBot 插件。

## 守护进程（daemon）：脱离 kiro-cli 常驻自动收发

`packages/wechat-daemon/` 提供一个独立守护进程：自己长轮询 iLink 收消息 →
调 **常驻 `kiro-cli acp` 进程**（JSON-RPC over stdio）当大脑生成回复 → 自动回发。
进程常驻、原生多轮记忆，回复从 `agent_message_chunk` 流式拼接（天然无 ANSI/工具旁白）；
带**存活检测**（进程不在自动重启）。它**只依赖内核包 `@wemind/wechat-ilink-core`**，不碰 MCP 那层，是一个完全独立、可单独运行的包。

> 备注：`acp-brain.ts` 是默认大脑；`brain.ts`（每条消息 spawn `kiro-cli chat` 的无状态版）保留作为可回退实现。

```bash
npm run build
npm run daemon      # 前台运行；需先完成扫码登录（见上文）
```

> ⚠️ **安全（务必读）**：daemon 用 `--trust-all-tools`，意味着**任何能给这个微信 ClawBot 会话发消息的人，都能让 Kiro 在运行 daemon 的电脑上执行任意工具（含 shell / 写文件）**。
> 唯一的安全闸是**发件人白名单**：daemon 默认只处理登录账号本人（`account.userId`）发来的消息，其余忽略。**不要关掉它。** 可用 `WECHAT_OWNER_ID` 覆盖白名单。

环境变量：

| 变量 | 说明 |
|------|------|
| `WECHAT_OWNER_ID` | 发件人白名单（默认登录账号本人 user id） |
| `WECHAT_ACCOUNT` | 账号标识，决定状态子目录 `~/.wemind/<account>/`（默认 `default`）。多账号用不同值隔离 |
| `WECHAT_DATA_DIR` | 直接指定完整状态目录路径，覆盖上面的 `~/.wemind/<account>` 规则 |
| `KIRO_CLI_BIN` | kiro-cli 可执行文件路径（默认走 PATH） |
| `WECHAT_BRAIN_TIMEOUT_MS` | 单次 kiro-cli 调用超时（默认 120000） |
| `WECHAT_BRAIN_HOME` | brain 沙箱目录（默认 `<数据目录>/brain-home`） |

限制：

- **只在电脑开机且 daemon 运行时在线**（不是云端常驻）；
- **不能主动发起对话**（iLink 限制），需你先发消息；
- iLink 会话超时（errcode `-14`）会进入 1 小时冷却，重发消息恢复。

### MCP 沙箱与对话式加载

brain 跑在独立的 `KIRO_HOME` 沙箱（`WECHAT_BRAIN_HOME`）里，**默认不加载任何 MCP**——既快又杜绝 `wechat` 自身回环（内置工具如 `web_search` 仍可用）。需要某个 MCP 时，直接**在微信里发指令**（daemon 拦截处理，不进 brain）：

| 指令 | 作用 |
|------|------|
| `MCP` / `列出 MCP` | 列出可选 MCP（来自全局 `mcp.json`）与当前已激活 |
| `加载 <名>` / `load <名>` | 把指定 MCP 加入激活集（`wechat` 永久禁止） |
| `卸载 <名>` / `unload <名>` | 移除 |
| `新会话` / `重置` / `/new` | 开启新 ACP 会话（清空多轮上下文） |

加载/卸载 MCP 后 daemon 会**重启 ACP 进程**以按新沙箱 `mcp.json` 重载，下一条消息生效。激活的 MCP 等于对白名单发件人全权开放（brain 是 `--trust-all-tools`），按需加载、用完可卸载。

### 切换大脑 Agent（通用化）

daemon 的大脑通过**标准 ACP（Agent Client Protocol，JSON-RPC over stdio）**驱动，默认是 `kiro-cli`，但任何兼容 ACP 的 agent CLI 都能接入，**无需改代码，仅靠环境变量**（见 `packages/wechat-daemon/src/brain-agents.ts`）：

| 环境变量 | 作用 | 默认 |
|------|------|------|
| `WEMIND_BRAIN` | 选预设（如 `kiro`、`gemini`） | `kiro` |
| `WEMIND_BRAIN_BIN` | 覆盖二进制（绝对路径或 PATH 上的名字） | 预设自动解析 |
| `WEMIND_BRAIN_ARGS` | 覆盖进入 ACP 模式的启动参数（空格分隔） | 预设值 |
| `WEMIND_BRAIN_HOME_ENV` | 覆盖「agent 配置目录环境变量名」（指向 brain 沙箱） | 预设值 |
| `KIRO_CLI_BIN` | 旧的 kiro 专用二进制覆盖（仍兼容） | — |

`kiro` 预设 = `kiro-cli acp --trust-all-tools` + `KIRO_HOME` 指向沙箱。要接入新 agent，在 `ACP_AGENT_PRESETS` 加一条预设、或直接用上面四个变量即可。协议层（`session/new`/`prompt`/`update` 等）是标准 ACP，所有 ACP agent 共用。

> 详细步骤、各 agent 需确认的 4 件事、MCP 沙箱差异、验证方法见 [docs/接入其它-ACP-Agent.md](docs/接入其它-ACP-Agent.md)。

### 收发图片

- **收图**（用户发图 → 大脑看图）：daemon 下载并 AES-128-ECB 解密入站图片，作为 ACP image 块喂给大脑（`promptCapabilities.image:true`），大脑能"看"图回应。
- **发图**（大脑发图 → 用户）：大脑在回复里用 **Markdown 图片语法 `![](图片的 http 链接或本地文件绝对路径)`**，或直接给出**裸图片 URL**，daemon 会自动把它下载/读取后作为图片消息发出，并把剩余文字另发。大脑本身不会文生图，但能发：联网搜到的图、本地已有的图、自己用代码渲染保存的图表。底层走 `getUploadUrl` + AES-128-ECB 加密上传 CDN（`no_need_thumb`，免缩略图）。

### Windows 登录自启

优先用计划任务（PS7 全路径、登录触发、崩溃重拉由 `scripts/run-daemon.ps1` 的循环负责）：

```powershell
$pwsh = "C:\Program Files\PowerShell\7\pwsh.exe"
$wrapper = "<仓库绝对路径>\scripts\run-daemon.ps1"
$action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapper`""
Register-ScheduledTask -TaskName "mcp-wechat-daemon" -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew) -Force
```

若环境禁止创建计划任务（提示「拒绝访问」），改用**启动文件夹**自启：在
`shell:startup`（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`）放一个
`.vbs`，用 `WScript.Shell.Run` 以隐藏窗口调用上面的 `pwsh ... -File scripts/run-daemon.ps1`。

> 常驻底层原理（三层进程树、wrapper 看门狗循环、单实例 Mutex、开机自启、多账号隔离、pid 链与故障恢复）详见 [docs/daemon-常驻原理.md](docs/daemon-常驻原理.md)。
>
> **跨平台（Windows/Linux/macOS）常驻**：用 pm2 + 根目录 `ecosystem.config.cjs` 即可，详见 [docs/跨平台常驻-pm2.md](docs/跨平台常驻-pm2.md)。上面的 PowerShell 方案为 Windows 专用，二者对同一账号**只用一套**。

## 多账号管理

支持登录多个微信账号，每个账号一份独立目录 `~/.wemind/<key>/`，`key` 由微信 **botId** 派生（唯一、自动获取；当前 iLink 接口不返回昵称/微信号，故用 botId，另存可编辑的 `label` 别名）。账号清单记录在 `~/.wemind/accounts.json`。不同账号 = 不同 token = 各跑一个 daemon，互不冲突。

> **key vs label**：`key`（botId 派生）是唯一标识、也是目录名，系统据它区分；`label` 是人类可读别名（可改、可重复）。下列命令多数 **可用 key 或 label 选择账号**（label 唯一匹配时）。

**新增一个账号（推荐：一条命令）** —— 在终端跑：

```powershell
node packages/wechat-daemon/dist/manage.js login --label 工作号 --start
```

它会：自动生成二维码（**过期自动刷新**、终端直接显示 + 自动打开 PNG）→ 你用要登录的微信扫码确认 → 自动按 botId 归档登记 → `--start` 顺带启动该账号 daemon。整条命令在你终端里跑，二维码原生渲染、不怕过期。

管理命令（`node packages/wechat-daemon/dist/manage.js <command>`）：

| 命令 | 作用 |
|------|------|
| `login [--label 名] [--start]` | **一条命令完成扫码登录**：自刷新二维码 + 自动归档（`--start` 顺带启动） |
| `list` | 列出账号、别名、botId、运行状态 |
| `start <key\|label>` | 启动某账号的 daemon |
| `logout <key\|label>` | 停 daemon + 通知下线 + 清凭证（保留目录，可重登） |
| `delete <key\|label>` | 停 daemon + 删除目录 + 移除注册 |
| `label <key\|label> <新别名>` | 改别名 |
| `set-default <key\|label>` | 设默认账号 |
| `adopt <key> [--label 名]` | 把已存在的账号目录登记进注册表 |

**自启全部账号**：`scripts/run-all-daemons.ps1` 读注册表为每个账号起一个 daemon（各账号单实例守卫，重复运行安全）。Windows 启动文件夹的 VBS 已指向它，开机自动拉起所有已登记账号。

## 致谢

- Fork 自 [Howardzhangdqs/mcp-wechat-server](https://github.com/Howardzhangdqs/mcp-wechat-server)（MIT）。
- iLink 协议细节、session-guard 与上下线通知实现借鉴自微信官方插件 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）。

## 许可证

MIT（沿用原项目）
