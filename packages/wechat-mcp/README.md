# @wemind/wechat-mcp

> 基于 **MCP（Model Context Protocol）** 的微信 Bot server——让任何兼容 MCP 的 AI Agent 通过**个人微信**收发消息。底层走腾讯官方 **iLink / 微信 ClawBot** 通道。

[WeMind](https://github.com/imwangpan/WeMind) monorepo 的可发布包；内核 `@wemind/wechat-ilink-core` 已用 tsdown 内联进产物，对外只需这一个自包含的包。

## 接入

无需全局安装，在 MCP 客户端配置里用 `npx` 即可：

**Claude Desktop / Cursor / 其它**

```json
{
  "mcpServers": {
    "wechat": { "command": "npx", "args": ["-y", "@wemind/wechat-mcp"] }
  }
}
```

**OpenCode** (`opencode.json`)

```json
{
  "mcp": {
    "wechat": {
      "type": "local",
      "command": ["npx", "-y", "@wemind/wechat-mcp"],
      "enabled": true
    }
  }
}
```

## 工具

| 工具                  | 说明                                                      |
| --------------------- | --------------------------------------------------------- |
| `login_qrcode`        | 生成微信登录二维码（终端文本 / PNG 图片 / 链接 三种形式） |
| `check_qrcode_status` | 检查二维码是否已扫码确认                                  |
| `logout`              | 退出登录并清除凭证                                        |
| `get_messages`        | 拉取新消息（`wait=true` 长轮询阻塞直到收到，最长 7 天）   |
| `send_text_message`   | 发送文本消息                                              |
| `send_typing`         | 显示 / 取消「正在输入」                                   |

## 使用流程

1. Agent 调 `login_qrcode` → 你用手机微信扫码。
2. `check_qrcode_status` 轮询直到 `confirmed`。
3. `get_messages(wait=true)` 收消息 → `send_typing` 显示输入中 → `send_text_message` 回复 → `send_typing` 取消。

> `get_messages` 的工具描述里内嵌了完整工作流，Agent 读描述即可自驱。

## 注意

- 凭证存在 `~/.wemind/<account>/account.json`（**Windows 下为明文**，请用文件夹权限/磁盘加密保护）。
- iLink **不能主动发起对话**，只能在收到用户消息的会话上下文内回复。
- 这是腾讯新开放的插件通道，官方保留随时停服的权利，勿用于关键业务；需较新微信客户端并启用 ClawBot 插件。

## 更多

常驻守护、远程任务（worker）等完整能力见主仓库 **[WeMind](https://github.com/imwangpan/WeMind)**。

## License

MIT
