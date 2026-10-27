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

本包通过 GitHub Actions（[`.github/workflows/wechat-mcp-publish.yml`](../../.github/workflows/wechat-mcp-publish.yml)）发布到 npm。**下面的命令都在 WeMind 仓库根目录运行**，不是在 `packages/wechat-mcp` 子目录。

### 第一步：判断要不要发版

| 你改了什么 | 需要发版吗 |
| --- | --- |
| `packages/wechat-mcp/src/**` 或 `packages/wechat-ilink-core/src/**`（内核会内联进来） | ✅ 要 |
| 只改了 `*.md` 文档 | ❌ 不用（CI 会跑检查，但版本没变会跳过发布） |
| 只改了 `packages/wechat-daemon/**` | ❌ 与本包无关，发的是另一个包 |

> 同一个版本号**不能重复发布**。所以「有没有改代码」不是关键，「有没有升版本号」才是——没升就只会跑检查、不发布。

### 第二步：选版本号

| 参数 | 示例 | 什么时候用 |
| --- | --- | --- |
| `patch` | `1.0.4` → `1.0.5` | Bug 修复、兼容性改动（**最常用**） |
| `minor` | `1.0.4` → `1.1.0` | 新增向后兼容的功能（如新增一个 MCP 工具） |
| `major` | `1.0.4` → `2.0.0` | 不兼容改动（如删工具、改工具参数、升级 MCP 协议版本） |

### 第三步：升版本号（两种方式二选一）

**方式 A：用 npm 自动提升（推荐）**

```powershell
npm version patch --workspace @wemind/wechat-mcp --no-git-tag-version
```

它会同时更新**两处**：`packages/wechat-mcp/package.json` 的 `version`，以及根 `package-lock.json` 里该 workspace 的版本记录。

- `--workspace @wemind/wechat-mcp`：只动本包，不改根项目、daemon、core 的版本；
- `--no-git-tag-version`：不自动创建 commit 或 tag，改完由你自己检查提交。

**方式 B：手动改两处**

1. 编辑 `packages/wechat-mcp/package.json` 的 `"version"`；
2. 回到仓库根目录刷新锁文件：

```powershell
npm install --package-lock-only --ignore-scripts
```

> 不要手动编辑 `package-lock.json`。上面这条只重算 lockfile 元数据，不重装 `node_modules`、不跑依赖的安装脚本。

### 第四步：本地校验

```powershell
npm run check:version          # 本包不在其校验范围时以第五步为准
npm pkg get version --workspace @wemind/wechat-mcp   # 确认版本号已改
npm run lint && npm run typecheck && npm run build && npm test
npm pack --dry-run --workspace @wemind/wechat-mcp    # 看一眼打进去的文件清单
```

> ⚠️ **`npm publish` 不会自动 build**。CI 会 build，但如果你想在本地 `npm pack` 出可用的包，必须先 `npm run build`。

### 第五步：提交并推送

```powershell
git add packages/wechat-mcp/package.json package-lock.json
git add packages/wechat-mcp/src packages/wechat-ilink-core/src   # 有源码改动时
git commit -m "chore: release @wemind/wechat-mcp 1.0.5"
git push origin main
```

推送到 `main` 后，工作流依次执行：

```
校验版本与锁文件一致 → npm ci → lint → format:check → typecheck → build → test
→ npm pack --dry-run（确认包内容）
→ 检查 npm 上是否已存在该版本
→ 不存在则 npm publish（带 provenance 来源证明）；已存在则跳过并输出 notice
```

**看到 `Publish to npm` 显示 skipped 是正常的**：说明这个版本已经发过了（比如你只改了文档没升版本）。想真正发版，回到第二步升版本号。

### 第六步：发布后验收

```powershell
npm view @wemind/wechat-mcp version           # 应显示新版本号
npx -y @wemind/wechat-mcp                    # 应打印 Connected / Not logged in 后挂在 stdio（Ctrl+C 退出）
```

### 常见坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| CI 绿了但 npm 上没新版本 | 版本号没升，被跳过 | 升版本号后再推 |
| CI 报「版本不一致」 | 只改了 `package.json`，没跑 `npm install --package-lock-only` | 补跑第三步方式 B 的第 2 条 |
| `npm pack` 出来的包是空壳 | 没先 `npm run build`（`dist/` 在 `.gitignore` 里） | 先 build 再 pack |
| `npm publish` 报 403 / EOTP | 本地直发需要交互式 2FA | **不要本地发**，走 CI（Trusted Publisher 已配好） |

## License

MIT
