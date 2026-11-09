# @wemind/cli — 命令 `wemind`

> **你的 AI 大脑，挂在微信上。** 常驻微信 Bot daemon：自己长轮询 iLink 收消息 → 调常驻 **ACP 大脑**生成回复 → 自动回发。支持**运行时切换大脑**（免重启）、**多任务并行（worker 进程池）**、**完整会话管理**（列表/恢复/改名/删除）、**会话交接**、**多账号**、收发**图片**（入站只收图、语音取微信转写，文件/视频不入站；出站发图与长回复自动转 `.md`）。

[WeMind](https://github.com/imwangpan/WeMind) monorepo 的完整应用包；只依赖内核 `@wemind/wechat-ilink-core`（构建时已内联进单文件产物），不碰 MCP 层，可独立运行。

> **包名 `@wemind/cli`，命令名 `wemind`。** 包收在 scope 下，命令保持短名。**`npx` 必须写全包名**。

## 环境要求

1. Node.js >= 20.19；
2. PATH 上有一个支持 **ACP** 的 agent CLI。

### 已适配的 Agent CLI

- 原生支持 ACP：`kiro-cli` / `opencode` / `gemini` / `DeepSeek Harness` / `qodercli` / `cline` 等；未显示配置时自动按以下顺序自动探测： `opencode → cline → qoder → gemini → deepseek → kiro`；
- `copilot` 原生支持 ACP，但不参与探测（安装不代表已登录），需显式 `wemind brain set|switch copilot`。
- 适配器类：`claude-code` / `codex` / `pi` 不参与探测，要显式 `wemind brain set|switch`。

### 其它

各 agent 的沙箱、凭据与免审批配置见 [接入其它 ACP agent](../../docs/接入方案/接入其它-ACP-Agent.md)。

## 安装

```bash
npm i -g @wemind/cli     # 安装后得到 wemind 命令
wemind version           # → wemind 1.5.1 (@wemind/cli, node …, win32-x64)   # 版本以实际安装为准
wemind list              # 查看账号与运行状态
```

不想全局安装、只想临时跑一次时，必须写全包名 `npx -y @wemind/cli <子命令>`（如 `npx -y @wemind/cli list`）。

## 升级

```bash
npm i -g @wemind/cli@latest
wemind stop <账号> && wemind start <账号>   # 已在运行的 daemon 不会自动加载新代码
```

## 三步上手

```bash
wemind login --label 工作号 --start   # ① 终端里出二维码，微信扫码 → 自动归档 + 启动常驻
wemind list                          # ② 看账号与运行状态
wemind brain check                   # ③ 验证大脑能实现 ACP（initialize + session/new 握手；失败退出码 1）
```

之后在微信里随便发一句话，就该收到回复。日志在 `~/.wemind/<账号>/daemon.log`。

## 常用命令

| 命令                                                                                                | 作用                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wemind login [--label 名] [--start] [--runner builtin\|pm2]`                                       | 扫码登录；`--start` 顺带拉起常驻                                                                                                                                                                                                                             |
| `wemind list`                                                                                       | 账号、别名、运行状态、当前大脑、worker 池                                                                                                                                                                                                                    |
| `wemind start / stop <key\|label>`                                                                  | 启停某账号的常驻                                                                                                                                                                                                                                             |
| `wemind start --all \| <key1> <key2>…`                                                              | 启动所有 / 指定的多个账号（单账号失败不影响其余）                                                                                                                                                                                                            |
| `wemind autostart install\|status\|uninstall [--key <key>\|--label 名]`                             | 开机自启：默认所有已登记账号；检测到 PM2 优先用 PM2，否则用计划任务 / systemd / LaunchAgent                                                                                                                                                                  |
| `wemind brain [show\|set\|unset\|check]`                                                            | 查看 / 设置（写入磁盘）/ 清除 / 自检大脑（`brain set deepseek --bin "<绝对路径>" --restart`）；只加启动开关用 `--extra-args "…"`（追加，保留预设的 ACP 模式参数），`--args "…"` 是整段替换（漏掉 `acp` 会握手超时，`wemind brain` 会警告；`--args ""` 清空） |
| `wemind brain switch <agent 名\|auto>`                                                              | **热切换对话大脑**：daemon 在跑也不重启、不打断在途回合；失败自动回滚。`--worker` 设默认任务大脑；`wemind brain handoff` 生成交接摘要                                                                                                                        |
| `wemind session new [名字] / list / resume <ref> / rename <ref> <名> / delete <ref> [<key\|label>]` | 会话管理：新建 / 列表 / 严格恢复 / 改名 / 删除（`ref` = 序号、名字或 id 前缀；省略账号 = 默认账号）                                                                                                                                                          |
| `wemind task "<描述>" [--agent 名] [--cwd 目录] [<key\|label>]`                                     | 派发任务给 worker（多任务并行、按编号回话；`--cwd` 相对路径按当前终端目录解析）                                                                                                                                                                              |
| `wemind task-list / task-reply <编号> "…" / task-stop [编号\|全部] [<key\|label>]`                  | 任务列表、回话续跑（`task-reply 继续`）、结束（在等回复的进程回池复用）                                                                                                                                                                                      |
| `wemind allow / revoke / allowlist`                                                                 | 授权管理（谁能驱动这个 bot）                                                                                                                                                                                                                                 |
| `wemind logout / delete / label / set-default`                                                      | 账号运维（`delete` 停不掉 daemon 时会拒绝删目录，先 `stop`）                                                                                                                                                                                                 |
| `wemind version` / `wemind help`                                                                    | 版本、完整帮助                                                                                                                                                                                                                                               |

`key` = 由微信 botId 派生的目录名；`label` = 人类可读别名，多数命令两者都能用。

## 常驻怎么跑

`wemind start` 默认用**自带的跨平台后台守护进程**（builtin）：后台拉起 `wemind _watchdog`，它循环执行 `wemind daemon`，进程退出后自动重拉。也可以用 `--runner pm2`（或 `WEMIND_RUNNER=pm2`）交给 pm2，两者语义一致。进程树、pid 记录、日志轮转等细节见 [部署与运维](../../docs/repowiki/10-部署与运维.md)。

**开机自启**：`wemind autostart install`（默认所有已登记账号，`--key`/`--label` 只装一个）。检测到 PM2 时优先用 PM2 托管（实例名 `wemind-<key>`）；否则用系统原生触发器：

- **Windows**：登录触发的计划任务（当前用户，不需要管理员），触发 `wemind start --all`，重拉交给 builtin watchdog；计划任务被拒时自动降级为 `HKCU\...\Run`。装了 PM2 时任务名改为 `wemind-autostart-pm2`，动作是 `start --all --runner pm2`（Windows 的 `pm2 startup` 不原生支持）。
- **Linux systemd / macOS launchd**：单元**必须写 `wemind daemon`（前台常驻）**，**不要写 `wemind start`**——后者会立刻退出，supervisor 会以为服务挂了并反复重启；本平台的 supervisor 自己负责重拉。

`wemind autostart status` 查看当前方式（`none` / `native-only` / `pm2-only` / `mixed`）；两套同时存在会抢同一个 bot token，`install` 会让你选择只保留一套。**同一账号只用一套常驻方案**——builtin / pm2 / 系统触发器不要重复配置。源码仓库的 `scripts/run-daemon.ps1` 默认也是薄壳（转 `wemind start`，重拉交给内置 watchdog）；`-Mode shell` 才启用旧的 PowerShell 循环，与它也**只用一套**。

## 数据与安全

- 所有状态在 `~/.wemind/<账号>/`（可用 `WEMIND_HOME` 改根目录）：`account.json` 登录凭证、`state.json` 游标（读到哪条消息了）、`allowFrom.json` 授权清单、`brain-home/` 大脑沙箱、`agent-sessions/`（agent 自己的会话库；目前 DSH 的 `deepseek/{brain,worker}` 在这里，不再写 `brain-home/sessions`）、`daemon.log` 日志。
- **适配器类大脑要单独装**（`claude-code` / `codex` / `pi`）：`npm i -g <适配器包>` 后 `wemind brain set <agent 名>`；各适配器的安装命令、认证、沙箱与 MCP 差异见 [接入其它 ACP agent](../../docs/接入方案/接入其它-ACP-Agent.md)。
- ⚠️ **daemon 会让大脑免确认执行工具**：10 个内置预设默认都免审批，能给这个 bot 发消息的人即可让大脑在本机执行工具（shell / 写文件）；Copilot 预设仅使用 `--allow-all-tools`，不启用 `--allow-all`。微信平台限制决定了只有扫码登录这个 bot 的**登录者**能发消息；另有一道**发件人授权（allowFrom）兜底**：登录者自动写入，**勿清空**。想收紧权限见 [接入其它 ACP agent](../../docs/接入方案/接入其它-ACP-Agent.md)。
- `account.json`（bot token）、`state.json`（`context_token`）、`qr_login.json` 在 POSIX 上统一 chmod 600；Windows 上都是明文，请用目录权限或磁盘加密。
- 同一个 bot token **只能有一个程序收消息**（同一份登录凭证不能同时被两个程序使用）：`wemind` daemon 与 `@wemind/wechat-mcp` 二选一，否则互相抢消息。

## 环境变量（常用）

| 变量                                                                                  | 含义                                                                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `WEMIND_HOME`                                                                         | 数据根目录，默认 `~/.wemind`                                                                                             |
| `WECHAT_ACCOUNT` / `WECHAT_DATA_DIR`                                                  | 指定账号 / 指定完整数据目录（多账号隔离）。`WECHAT_DATA_DIR` **只对 `wemind daemon` 直跑生效**；`start` / `login --start` / pm2 runner / 自启忽略它 |
| `WEMIND_RUNNER`                                                                       | `builtin`（默认）或 `pm2`                                                                                                |
| `WEMIND_BRAIN` / `WEMIND_BRAIN_BIN` / `WEMIND_BRAIN_ARGS` / `WEMIND_BRAIN_EXTRA_ARGS` | 一次性覆盖大脑选择与启动参数（`ARGS` 整段替换、`EXTRA_ARGS` 追加；持久化请用 `wemind brain set`）                        |
| `COPILOT_HOME`                                                                       | 仅运行 Copilot CLI 时由 WeMind 给子进程设置，指向隔离沙箱；不要手动固定                                                   |
| `WEMIND_ACP_AUTO_ALLOW=1`                                                             | 放行 ACP agent 的一次性权限请求（默认为拒绝）                                                                            |
| `WEMIND_ACP_SESSION_MODE`                                                             | 覆盖/关闭预设的会话模式（`session/set_mode`）：`0`/`false`/`off`/`no` 关闭，其它值 = 该 modeId                              |
| `WEMIND_LOG_MAX_MB` / `WEMIND_LOG_KEEP`                                               | `daemon.log` 轮转：单文件上限（默认 10）/ 保留份数（默认 3，`0` = 不留历史）；builtin 运行中轮转，pm2 用 `pm2-logrotate` |

## 与 MCP 形态的区别

|      | `@wemind/cli`（命令 `wemind`）      | `@wemind/wechat-mcp`              |
| ---- | ----------------------------------- | --------------------------------- |
| 驱动 | 自己常驻、自己调大脑                | 随 MCP 客户端生命周期，被动调工具 |
| 大脑 | 独立 ACP agent 进程                 | 就是 MCP 客户端背后的模型         |
| 能力 | 收发图片（长回复转 `.md`）、远程任务、多账号、7×24 | 文本收发为主                      |

## 文档

- 完整文档：<https://github.com/imwangpan/WeMind>
- 新手一步步教程：[docs/使用指南/新手教程.md](../../docs/使用指南/新手教程.md)
- 发布与版本规则：[docs/发布与变更记录/如何发布新版本.md](../../docs/发布与变更记录/如何发布新版本.md)
- AI 协作者入口：[AGENTS.md](../../AGENTS.md)
- 接入其它 ACP agent：[docs/接入方案/接入其它-ACP-Agent.md](../../docs/接入方案/接入其它-ACP-Agent.md)
- Daemon 常驻原理：[docs/repowiki/10-部署与运维.md](../../docs/repowiki/10-部署与运维.md)

## License

MIT
