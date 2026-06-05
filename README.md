# mcp-wechat-server

基于 MCP（Model Context Protocol）的微信机器人服务器，让任何 AI Agent 都能收发微信消息。

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

## 快速开始

本 Fork 运行在 **Node.js** 上，未发布到 npm。请先按「本地开发」构建，再用绝对路径接入 MCP 客户端。

### Claude Desktop

在 `claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "wechat": {
      "command": "node",
      "args": ["/abs/path/to/mcp-wechat-server/dist/index.js"]
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
      "command": ["node", "/abs/path/to/mcp-wechat-server/dist/index.js"],
      "enabled": true
    }
  }
}
```

### Cursor / 其他 MCP 客户端

```json
{
  "command": "node",
  "args": ["/abs/path/to/mcp-wechat-server/dist/index.js"]
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

所有数据保存在 `~/.mcp-wechat-server/` 目录下：

| 文件 | 说明 |
|------|------|
| `account.json` | Bot Token 和用户 ID（POSIX 下权限 600；**Windows 下为明文**，见「安全说明」） |
| `state.json` | 消息游标和上下文 Token |
| `qrcode.png` | 生成的二维码图片 |
| `qrcode.txt` | 生成的终端二维码文本 |

## 本地开发

```bash
git clone https://github.com/imwangpan/mcp-wechat-server.git
cd mcp-wechat-server
npm install
npm run build      # 编译到 dist/
npm start          # 运行 node dist/index.js
npm test           # 运行单元测试
npm run dev        # tsx 热重载开发（可选）
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

`src/daemon/` 提供一个独立守护进程：自己长轮询 iLink 收消息 →
调 **常驻 `kiro-cli acp` 进程**（JSON-RPC over stdio）当大脑生成回复 → 自动回发。
进程常驻、原生多轮记忆，回复从 `agent_message_chunk` 流式拼接（天然无 ANSI/工具旁白）；
带**存活检测**（进程不在自动重启）。它**只依赖 `api/` + `store/`**，不碰 MCP 那层，便于日后独立拆出。

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
| `KIRO_CLI_BIN` | kiro-cli 可执行文件路径（默认走 PATH） |
| `WECHAT_BRAIN_TIMEOUT_MS` | 单次 kiro-cli 调用超时（默认 120000） |
| `WECHAT_BRAIN_HOME` | brain 沙箱目录（默认 `~/.mcp-wechat-server/brain-home`） |

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

## 致谢

- Fork 自 [Howardzhangdqs/mcp-wechat-server](https://github.com/Howardzhangdqs/mcp-wechat-server)（MIT）。
- iLink 协议细节、session-guard 与上下线通知实现借鉴自微信官方插件 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）。

## 许可证

MIT（沿用原项目）
