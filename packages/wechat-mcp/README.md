# @wemind/wechat-mcp

> 基于 **MCP（Model Context Protocol）** 的微信 Bot server——让任何兼容 MCP 的 AI Agent 通过**个人微信**收发消息。底层走腾讯官方 **iLink / 微信 ClawBot** 通道。

[WeMind](https://github.com/imwangpan/WeMind) monorepo 中已发布到 npm 的包（`@wemind/wechat-mcp`）；内核已内联进产物，对外只需这一个自包含的包。

产物 `dist/index.js` 同时带 `dist/index.js.map`。Node 默认不应用 sourcemap，所以 server 在打印 fatal 错误时自己读同目录的这张 map，日志里的堆栈直接写成 `src/xxx.ts:12` 这样的源码位置，不需要在 MCP 客户端配置里设任何环境变量；map 与产物同一次构建、同一目录，版本天然配对。

## 接入

在 MCP 客户端配置里，让客户端通过 `npx -y @wemind/wechat-mcp` 按需拉起即可（MCP 生态惯例，下方两份配置即此写法）：无需预先安装，`npx` 由客户端在自己的环境里解析包；不带版本号时会解析 `latest`，要固定版本可在包名后写 `@版本号`。

若想**先安装**到全局（固定版本、离线运行或在终端里直接敲），执行 `npm i -g @wemind/wechat-mcp` 得到 `wemind-mcp` 命令（Windows 为 `wemind-mcp.cmd`）；对应的配置改法见本节末尾。

**Claude Desktop / Cursor / 其它**

```json
{
  "mcpServers": {
    "wechat": { "command": "npx", "args": ["-y", "@wemind/wechat-mcp"] }
  }
}
```

**OpenCode** (`opencode.json`，V2：server 定义在 `mcp.servers` 下)

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

> **想用全局安装后的命令**：先 `npm i -g @wemind/wechat-mcp`，再把上面两份配置里的 `command` 换成 `wemind-mcp`（Windows 写 `wemind-mcp.cmd`）。GUI 客户端（Claude Desktop 等）启动时的 PATH 常不含 npm 全局 bin 目录，若报 `spawn ENOENT`，用 `npm root -g` 查出全局根、把 `command` 写成该 bin 的**绝对路径**即可；也可以继续用默认的 `npx` 写法。

## 工具

| 工具                  | 说明                                                      | 代码 description（简要转述，非逐字原文）                                                                                                                                                                |
| --------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login_qrcode`        | 取登录二维码（返回链接，并在数据目录生成 PNG 与终端文本） | Get a WeChat login QR code. Scan it with WeChat to connect the bot. … You MUST show all three returned forms (image URL / PNG file / terminal text file) to the user.                                   |
| `check_qrcode_status` | 查扫码状态（轮询到 `confirmed` 即登录成功）               | Check whether the QR code from `login_qrcode` has been scanned and confirmed. … If it returns `need_verifycode` or an IDC-redirect status, tell the user to run the `wemind login` CLI command (or `npx -y @wemind/cli login`) instead. |
| `logout`              | 登出并清除已保存的凭证                                    | Log out the current WeChat bot session. … Clears saved credentials, runtime state and any pending QR login. Only call this when the user asks to log out or wants to switch accounts.                   |
| `get_messages`        | 长轮询收消息（`wait=true` 阻塞直到收到，最长 7 天；图片/视频/文件只给占位符，语音带微信转写） | Poll for new WeChat messages. Always call with `wait=true` to block until a message arrives.（后接 4 步 typing 工作流；媒体不可下载）                                                                                 |
| `send_text_message`   | 发文本消息（`state="generating"` 发进度、默认 `finish` 发最终答复） | Send a text message to a WeChat user. … Each call is a separate message; use state="generating" for interim updates, state="finish" (default) for the final reply.                                      |
| `send_typing`         | 打字状态（`typing` 显示 / `cancel` 取消）                 | Show or cancel the "typing..." indicator for a WeChat user. … Re-send status `typing` every 15-20 seconds while still working, because the indicator expires on its own.                                |

> 上表为 description 的**简写转述**（`…` 表示省略），不是逐字原文；完整、准确的原文见 `src/index.ts`。工具说明**一律英文**（MCP 生态惯例 + 模型对 `MUST` / `wait=true` 这类强制约束的英文原文遵循度更高）；用户能看到的提示文案在 `tools/*.ts` 的 `message` 字段，均为中文。
>
> **`get_messages` 的两个入参**：`wait`（默认 `false`；`true` 时阻塞到有新消息，最长 7 天，**要求 MCP 客户端不设工具超时**）与 `timeout`（长轮询超时毫秒，默认 `10000`，范围 `1000–60000`；**`wait=true` 时忽略**）。Agent 通常只用 `wait=true`，这两个参数在 description 里会看到。
>
> **消息 ID**：`get_messages` 返回的 `message_id` 保留 iLink 的完整十进制精度；把它当字符串/不透明 ID 使用，不要转成 JavaScript `Number`。同一条消息不会被重复返回：服务端同批重复投递或重放的 `message_id` 由 `state.json` 里最近 200 条的 `seenMessageIds` 去重环跳过（与 daemon 形态同一套判据）。
>
> 表中 `check_qrcode_status` 的 description 里 `npx -y @wemind/cli login` 是源码 description 的原文——不安装、临时运行 CLI 时这样写；全局安装后等价的命令是 `wemind login`。
>
> **登录态过期**：扫码登录后凭证会随平台策略过期。此时工具返回 `status: "session_expired"`，处理方式同 `check_qrcode_status` 的 expired 分支——先 `logout` 再调 `login_qrcode` 重新扫码，**不要**反复重试 `get_messages`。

## 使用流程

1. Agent 调 `login_qrcode` → 你用手机微信扫码。
2. `check_qrcode_status` 轮询直到 `confirmed`。
3. `get_messages(wait=true)` 收消息 → `send_typing` 显示输入中 → `send_text_message` 回复 → `send_typing` 取消。

> `get_messages` 的工具描述里内嵌了完整工作流，Agent 读描述即可自驱。

## 注意

- ⚠️ **同一个 bot token 只能有一个程序收消息**（同一份登录凭证不能同时被两个程序使用）：本 MCP server 与 [`@wemind/cli`](https://www.npmjs.com/package/@wemind/cli) 的 daemon **二选一**。两边同时跑会互相抢消息、出现重复回复或丢消息。切换形态前先停掉另一个。
- `get_messages` 只返回**登录者**（扫码登录这个 bot 的微信号）或登录者白名单（`allowFrom.json`）内的消息，其它发件人的消息会被过滤——这是兜底鉴权，不是权限配置入口。
- 凭证存在 `~/.wemind/<account>/account.json`（**Windows 下为明文**，请用文件夹权限/磁盘加密保护）。账号目录由 `WECHAT_ACCOUNT`（默认 `default`）或 `WECHAT_DATA_DIR`（直接指定完整路径）决定；不设就用 `~/.wemind/default`。
- **与 CLI 账号体系对接**：标准目录（默认 `~/.wemind/default`、未设 `WECHAT_DATA_DIR`）登录成功后会自动登记进 `~/.wemind/accounts.json`，`wemind list` / `start` 可直接看到；退登时按 botId 核对后注销条目。自定义 `WECHAT_DATA_DIR` 不登记（注册表指向 `~/.wemind/<key>`，登记会指错目录）。
- iLink **不能主动发起对话**，只能在收到用户消息的会话上下文内回复。
- 这是腾讯新开放的插件通道，官方保留随时停服的权利，勿用于关键业务；需较新微信客户端并启用 ClawBot 插件。

## 更多

常驻守护、远程任务（worker）等完整能力见主仓库 **[WeMind](https://github.com/imwangpan/WeMind)**。

## License

MIT

> **日志格式（2026-11-11 起）**：运行日志统一由 `core/logging.ts` 的 `createLogger(scope)` 输出，格式为 `[wemind/<scope>][INFO|WARN|ERROR|DEBUG] …`，全部写 stderr（MCP 的 stdout 仍是 JSON-RPC 通道）；CLI 用户输出走 stdout 的 `print()`，不加前缀、不加级别。本文下面的日志样例可能省略了级别标记，实际每行都有。`wemind log --errors` 精确认 `[ERROR]/[WARN]` 标记，升级前写入的旧日志仍按关键词兼容。`WEMIND_LOG_LEVEL=debug` 才输出 DEBUG（目前没有 debug 调用点，属预留级别）。
