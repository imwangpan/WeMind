# @wemind/wechat-mcp

> 基于 **MCP（Model Context Protocol）** 的微信 Bot server——让任何兼容 MCP 的 AI Agent 通过**个人微信**收发消息。底层走腾讯官方 **iLink / 微信 ClawBot** 通道。

[WeMind](https://github.com/imwangpan/WeMind) monorepo 中已发布到 npm 的包（`@wemind/wechat-mcp`）；内核 `@wemind/wechat-ilink-core` 已用 tsdown 内联进产物，对外只需这一个自包含的包。

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

## 维护者：发布新版本

本包通过 GitHub Actions 发布到 npm。新版本必须使用从未发布过的版本号；推送到 `main` 后，工作流会检查、构建并发布。下面的命令都要在 **WeMind 仓库根目录**运行，而不是在 `packages/wechat-mcp` 子目录运行。

### 推荐：用 npm 自动提升版本

运行 `npm version`，让 npm 同时更新包的 `package.json` 和根目录 `package-lock.json` 中对应的 workspace 版本记录：

```powershell
npm version patch --workspace @wemind/wechat-mcp --no-git-tag-version
```

例如当前版本是 `1.0.2`，运行后会变成 `1.0.3`。这里的 `patch` 表示修复或兼容性改动时递增第三段版本号。其他常见选择：

| 命令参数 | 示例变化          | 常见用途             |
| -------- | ----------------- | -------------------- |
| `patch`  | `1.0.2` → `1.0.3` | Bug 修复、兼容性改动 |
| `minor`  | `1.0.2` → `1.1.0` | 向后兼容的新功能     |
| `major`  | `1.0.2` → `2.0.0` | 不兼容的重大改动     |

`--workspace @wemind/wechat-mcp` 表示只提升 MCP 包，不改根项目、daemon 或 core 的版本。`--no-git-tag-version` 表示不自动创建 Git commit 或 tag；文件仍会更新，需要你自行检查并提交。

### 手动改版本后同步锁文件

如果直接编辑 `packages/wechat-mcp/package.json`，例如把 `"version": "1.0.2"` 改为 `"version": "1.0.3"`，保存后在仓库根目录运行：

```powershell
npm install --package-lock-only --ignore-scripts
```

这会重新生成 lockfile 元数据，不会重新安装 `node_modules`，也不会运行依赖的安装脚本。不要手动编辑 `package-lock.json`；只需更新其中 `packages/wechat-mcp` 对应的版本记录。根项目及其他 workspace 的版本号不需要随之修改。

### 检查并触发发布

确认包清单和锁文件中的版本一致，再检查安装与打包：

```powershell
npm pkg get version --workspace @wemind/wechat-mcp
npm ci --dry-run
npm pack --dry-run --workspace @wemind/wechat-mcp
```

确认后，把版本、锁文件以及本次要发布的源码改动一起提交并推送到 `main`：

```powershell
git add packages/wechat-mcp/package.json package-lock.json
git add packages/wechat-mcp/src packages/wechat-ilink-core/src
git commit -m "chore: release @wemind/wechat-mcp 1.0.3"
git push origin main
```

如果本次不涉及源码变化，第二条 `git add` 可以省略。推送后，GitHub Actions 会运行检查；只有 npm 上尚不存在当前版本时才会发布。同一版本不能重复发布，因此每次发布新代码都要先提升版本号。

## License

MIT
