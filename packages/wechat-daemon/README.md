# @wemind/cli — 命令 `wemind`

> **你的 AI 大脑，挂在微信上。** 常驻微信 Bot 守护进程：自己长轮询 iLink 收消息 → 调常驻 **ACP 大脑**生成回复 → 自动回发。支持**远程任务（worker）**、**多账号**、收发图/文件。

[WeMind](https://github.com/imwangpan/WeMind) monorepo 的完整应用包；只依赖内核 `@wemind/wechat-ilink-core`（构建时已内联进单文件产物），不碰 MCP 层，可独立运行。

> **包名 `@wemind/cli` ≠ 命令名 `wemind`。** 与 `@modelcontextprotocol/*`、`@angular/cli`、`@openai/codex` 的惯例一致：包收在 scope 下，命令保持短名。因为包名与 bin 名不同，**`npx` 不会自动挑 bin，必须写全包名**。

## 安装

```bash
npm i -g @wemind/cli     # 安装后得到 wemind 命令
wemind version           # → wemind 1.0.0 (@wemind/cli, node 24.x, win32-x64)

# 不安装、一次性运行（注意是包名 @wemind/cli，不是 wemind）
npx -y @wemind/cli list
```

要求：**Node.js >= 20**；想让它真的会「思考」，需要 PATH 上有一个支持 **ACP** 的 agent CLI（`kiro-cli` / `opencode` / 桌面端 `dsh` 等；未配置时自动探测 `kiro → opencode → gemini → deepseek`）。

## 三步上手

```bash
wemind login --label 主号 --start   # ① 终端里出二维码，微信扫码 → 自动归档 + 启动常驻
wemind list                          # ② 看账号与运行状态
wemind brain check                   # ③ 验证大脑能说 ACP（initialize + session/new 握手）
```

之后在微信里随便发一句话，就该收到回复。日志在 `~/.wemind/<账号>/daemon.log`。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `wemind login [--label 名] [--start] [--runner builtin\|pm2]` | 扫码登录；`--start` 顺带拉起常驻 |
| `wemind list` | 账号、别名、运行状态、当前大脑 |
| `wemind start / stop <key\|label>` | 启停某账号的常驻 |
| `wemind brain [show\|set\|unset\|check]` | 查看/切换/清除/自检大脑（`brain set deepseek --bin "<绝对路径>" --restart`） |
| `wemind task "<描述>" [--cwd 目录]` | 本地派发远程任务给 worker |
| `wemind task-status / task-reply / task-stop` | 任务状态、注入续跑（`task-reply 继续`）、结束 |
| `wemind allow / revoke / allowlist` | 授权管理（谁能驱动这个 bot） |
| `wemind logout / delete / label / set-default` | 账号运维 |
| `wemind version` / `wemind help` | 版本、完整帮助 |

`key` = 由微信 botId 派生的目录名；`label` = 人类可读别名，多数命令两者都能用。

## 常驻怎么跑

`wemind start` 默认用**自带的跨平台看门狗**（builtin）：detached 拉起 `wemind _watchdog`，它循环执行 `wemind daemon`，进程退出 5 秒后自动重拉；单实例靠 `wrapper.pid` + 进程身份校验。也可以用 `--runner pm2`（或 `WEMIND_RUNNER=pm2`）交给 pm2。

开机自启：让系统在登录时执行一次 `wemind start <账号>` 即可（Windows 计划任务/启动文件夹、Linux systemd user service、macOS launchd）。**同一账号只用一套常驻方案**——两种 runner 同时跑会抢同一个 bot token。

## 数据与安全

- 所有状态在 `~/.wemind/<账号>/`（可用 `WEMIND_HOME` 改根目录）：`account.json` 登录凭证、`state.json` 游标、`allowFrom.json` 授权清单、`brain-home/` 大脑沙箱、`daemon.log` 日志。
- ⚠️ **daemon 用 `--trust-all-tools`**：能给这个 bot 发消息的人，即可让大脑在本机执行任意工具（shell / 写文件）。唯一安全闸是**发件人授权（allowFrom）**：扫码登录者自动授权，**勿清空**。
- `account.json` 里 bot token 是明文（POSIX 上 chmod 600；Windows 请用目录权限或磁盘加密）。
- 同一个 bot token **只能有一个消费者**：`wemind` daemon 与 `@wemind/wechat-mcp` 二选一，否则互相抢消息。

## 环境变量（常用）

| 变量 | 含义 |
| --- | --- |
| `WEMIND_HOME` | 数据根目录，默认 `~/.wemind` |
| `WECHAT_ACCOUNT` / `WECHAT_DATA_DIR` | 指定账号 / 指定完整数据目录（多账号隔离） |
| `WEMIND_RUNNER` | `builtin`（默认）或 `pm2` |
| `WEMIND_BRAIN` / `WEMIND_BRAIN_BIN` / `WEMIND_BRAIN_ARGS` | 一次性覆盖大脑选择（持久化请用 `wemind brain set`） |
| `WEMIND_ACP_AUTO_ALLOW=1` | 放行 ACP agent 的一次性权限请求（默认为拒绝） |

## 与 MCP 形态的区别

| | `@wemind/cli`（命令 `wemind`） | `@wemind/wechat-mcp` |
| --- | --- | --- |
| 驱动 | 自己常驻、自己调大脑 | 随 MCP 客户端生命周期，被动调工具 |
| 大脑 | 独立 ACP agent 进程 | 就是 MCP 客户端背后的模型 |
| 能力 | 收发图/文件、远程任务、多账号、7×24 | 文本收发为主 |

## 文档

- 完整文档：<https://github.com/imwangpan/WeMind>
- AI 协作者入口：[AGENTS.md](https://github.com/imwangpan/WeMind/blob/main/AGENTS.md)
- 接入其它 ACP agent：[docs/接入其它-ACP-Agent.md](https://github.com/imwangpan/WeMind/blob/main/docs/接入其它-ACP-Agent.md)
- Daemon 常驻原理：[docs/repowiki/10-部署与运维.md](https://github.com/imwangpan/WeMind/blob/main/docs/repowiki/10-部署与运维.md)

## License

MIT
