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

## 致谢

- Fork 自 [Howardzhangdqs/mcp-wechat-server](https://github.com/Howardzhangdqs/mcp-wechat-server)（MIT）。
- iLink 协议细节、session-guard 与上下线通知实现借鉴自微信官方插件 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）。

## 许可证

MIT（沿用原项目）
