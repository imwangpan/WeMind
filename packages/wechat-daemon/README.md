# @wemind/cli — 命令 `wemind`

> **你的 AI 大脑，挂在微信上。** 常驻微信 Bot daemon：自己长轮询 iLink 收消息 → 调常驻 **ACP 大脑**生成回复 → 自动回发。支持**运行时切换大脑**（免重启）、**多任务并行（worker 进程池）**、**完整会话管理**（列表/恢复/改名/删除）、**会话交接**、**多账号**、收**文本/图片/语音/文件/视频**（图片给大脑看；文件/视频/无转写语音落盘给路径），出站**图片/文件/视频**与长回复自动转 `.md`。

[WeMind](https://github.com/imwangpan/WeMind) monorepo 的完整应用包；只依赖内核 `@wemind/wechat-ilink-core`（发布时已内联进单文件产物），不碰 MCP 层，可独立运行。

产物 `dist/cli.js` 同时带 `dist/cli.js.map`。Node 默认不应用 sourcemap，所以 WeMind 在打印错误时自己读同目录的这张 map：`daemon.log` 里的堆栈会直接写成 `src/xxx.ts:12` 这样的源码位置，不需要设任何环境变量；map 与产物同一次构建、同一目录，版本天然配对。

> **包名 `@wemind/cli`，命令名 `wemind`。** 包收在 scope 下，命令保持短名。**`npx` 必须写全包名**。

## 环境要求

1. Node.js >= 20.19；
2. PATH 上有一个支持 **ACP** 的 agent CLI。

### 已适配的 Agent CLI

- 原生支持 ACP：`kiro-cli` / `opencode` / `gemini` / `DeepSeek Harness` / `qodercli` / `cline` 等；未显示配置时自动按以下顺序自动探测： `opencode → cline → qoder → gemini → deepseek → kiro`；
- `copilot` 原生支持 ACP，但不参与探测（安装不代表已登录），需显式 `wemind brain set|switch copilot`。
- 适配器类：`claude-code` / `codex` / `pi` 不参与探测，要显式 `wemind brain set|switch`。

### 其它

各 agent 的配置来源（direct / sandbox）、凭据与免审批配置见 [接入其它 ACP agent](../../docs/接入方案/接入其它-ACP-Agent.md)。

## 安装

```bash
npm i -g @wemind/cli     # 安装后得到 wemind 命令
wemind version           # → wemind 1.8.0 (@wemind/cli, node …, win32-x64)   # 版本以实际安装为准
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
| `wemind log [key\|label] [--lines N] [--errors] [--file N]`                                         | 看该账号 `daemon.log` 尾部（默认 50 行、全量日志；`--errors` 精确认 `[ERROR]`/`[WARN]` 标记（旧日志按关键词兼容）并带前后各 2 行上下文，`--file 1` 看轮转文件）。一次性快照，不带 `--follow`                                                                 |
| `wemind start / stop <key\|label>`                                                                  | 启停某账号的常驻                                                                                                                                                                                                                                             |
| `wemind start --all \| <key1> <key2>…`                                                              | 启动所有 / 指定的多个账号（单账号失败不影响其余）                                                                                                                                                                                                            |
| `wemind autostart install\|status\|uninstall [--key <key>\|--label 名]`                             | 开机自启：默认所有已登记账号；检测到 PM2 优先用 PM2，否则用计划任务 / systemd / LaunchAgent                                                                                                                                                                  |
| `wemind brain [show\|set\|unset\|check]`                                                            | 查看 / 设置（写入磁盘）/ 清除 / 自检大脑（`brain set deepseek --bin "<绝对路径>" --restart`）；只加启动开关用 `--extra-args "…"`（追加，保留预设的 ACP 模式参数），`--args "…"` 是整段替换（漏掉 `acp` 会握手超时，`wemind brain` 会警告；`--args ""` 清空） |
| `wemind brain switch <agent 名\|auto>`                                                              | **热切换对话大脑**：daemon 在跑也不重启、不打断在途回合；失败自动回滚。`--worker` 设默认任务大脑；`wemind brain handoff` 生成交接摘要                                                                                                                        |
| `wemind session new [名字] / list / resume <ref> / rename <ref> <名> / delete <ref> [<key\|label>]` | 会话管理：新建 / 列表 / 严格恢复 / 改名 / 删除（`ref` = 序号、名字或 id 前缀；省略账号 = 默认账号）                                                                                                                                                          |
| `wemind config show \| home-mode [direct\|sandbox] \| reload`                                        | 看当前 homeMode/路径；切模式或重新读取 Agent 配置（`reload` 在回合进行中会排队到回合结束）                                                                                                                                                                  |
| `wemind config agent show\|get\|set\|unset\|edit <agent> <键路径> [值]`                             | 改 Agent 的**真实**配置（写前备份+mtime/hash 校验；JSONC 含注释拒绝写）                                                                                                                                                                                      |
| `wemind config wechat show\|edit <agent>`                                                           | 改微信侧 overlay（只影响微信，不碰真实配置；只支持 `mcp.disable` / `mcp.extra`，拒绝密钥值与微信 MCP）                                                                                                                                                       |
| `wemind mcp list \| enable <名> \| disable <名> \| add <名> '<JSON>' \| remove <名>`                | 管理大脑 MCP：`sandbox` 下 brain 默认空集、按 agent 持久激活；`direct` 下 `加载/卸载` 原样交给 Agent；worker 始终排除 `wechat`                                                                                                                                |
| `wemind workspace show \| set <绝对路径> \| reset [--role brain\|worker]`                           | 看/设/重置工作区（必须已存在的本地目录；不能是账号数据/Agent 配置/系统目录）                                                                                                                                                                                 |
| `wemind env capture [--dry-run] \| show \| clear`                                                   | 拍一份非密钥环境快照（`env.json`，只白名单键；当前进程环境优先于快照）                                                                                                                                                                                       |
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

- 所有状态在 `~/.wemind/<账号>/`（可用 `WEMIND_HOME` 改根目录）：`account.json` 登录凭证、`state.json` 游标、`allowFrom.json` 授权清单、`runtime.json`（homeMode）、`agent-overrides/`（微信侧 overlay，仅 `mcp.disable` / `mcp.extra`）、`workspace.json` 与 `workspace/`、`media/inbound/`、`session-cwd.json`、`daemon.log` 等。`brain-home/` / `worker-home/` 与 DSH 的 `agent-sessions/` 只在 `sandbox` 模式使用。
- **适配器类大脑要单独装**（`claude-code` / `codex` / `pi`）：`npm i -g <适配器包>` 后 `wemind brain set <agent 名>`；各适配器的安装命令、认证、配置来源与 MCP 差异见 [接入其它 ACP agent](../../docs/接入方案/接入其它-ACP-Agent.md)。
- ⚠️ **daemon 会让大脑免确认执行工具**：10 个内置预设默认都免审批，能给这个 bot 发消息的人即可让大脑在本机执行工具（shell / 写文件）；Copilot 预设仅使用 `--allow-all-tools`，不启用 `--allow-all`。微信平台限制决定了只有扫码登录这个 bot 的**登录者**能发消息；另有一道**发件人授权（allowFrom）兜底**：登录者自动写入，**勿清空**。想收紧权限见 [接入其它 ACP agent](../../docs/接入方案/接入其它-ACP-Agent.md)。
- `account.json`（bot token）、`state.json`（`context_token`）、`qr_login.json` 在 POSIX 上统一 chmod 600；Windows 上都是明文，请用目录权限或磁盘加密。
- **出站附件有安全闸**：大脑必须显式写 `[附件](file:///绝对路径)` / `[文件](...)` / `[视频](...)`（路径含 `)` 用 `<...>`）。只允许**本地**绝对路径（`file://host/...` 与 UNC 网络路径拒绝，软链接目标同样检查；Windows 的 `文件::$DATA` 数据流也拒绝）；读取前 `realpath` 并拒绝状态/凭据文件（`account.json`、`.env`、各 agent 的 `.credentials*`、`.auth/`、`oauth_creds.json`、`settings.json`/`models*.json` 等），单文件默认上限 25MB（`WECHAT_OUTBOUND_FILE_MAX_MB`）。硬链接无法从路径区分，属已接受风险。**临时要发这类文件**时，登录者在微信发 `允许敏感文件 [分钟]`（默认 2 分钟、上限 30）开窗口：只跳过敏感名单，网络路径/数据流/大小上限照旧；**先开窗再发、或被拦下后回这条指令补发**都行（被拦下的路径在内存里保留 30 分钟）。窗口只在本 daemon 进程内，重启即失效。
- 同一个 bot token **只能有一个程序收消息**（同一份登录凭证不能同时被两个程序使用）：`wemind` daemon 与 `@wemind/wechat-mcp` 二选一，否则互相抢消息。

## 环境变量（常用）

| 变量                                                                                  | 含义                                                                                                                                                |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEMIND_HOME`                                                                         | 数据根目录，默认 `~/.wemind`                                                                                                                        |
| `WECHAT_ACCOUNT` / `WECHAT_DATA_DIR`                                                  | 指定账号 / 指定完整数据目录（多账号隔离）。`WECHAT_DATA_DIR` **只对 `wemind daemon` 直跑生效**；`start` / `login --start` / pm2 runner / 自启忽略它 |
| `WEMIND_RUNNER`                                                                       | `builtin`（默认）或 `pm2`                                                                                                                           |
| `WEMIND_BRAIN` / `WEMIND_BRAIN_BIN` / `WEMIND_BRAIN_ARGS` / `WEMIND_BRAIN_EXTRA_ARGS` | 一次性覆盖大脑选择与启动参数（`ARGS` 整段替换、`EXTRA_ARGS` 追加；持久化请用 `wemind brain set`）                                                   |
| `WEMIND_HOME_MODE`                                                                    | 一次性覆盖 homeMode：`direct`（默认）/ `sandbox`；持久化用 `wemind config home-mode`                                                              |
| `WEMIND_WORKER_CWD`                                                                   | 一次性覆盖 worker 默认工作目录（显式任务 `--cwd` 优先）                                                                                             |
| `WEMIND_WORKER_MCP_EXCLUDE`                                                           | worker 额外排除的 MCP 名（逗号分隔；`wechat` 始终强制排除）                                                                                         |
| `WEMIND_MCP_CATALOG` / `WECHAT_MCP_CATALOG`                                           | 覆盖 MCP 可选清单文件路径（不影响 native 只读门禁）                                                                                                 |
| `COPILOT_HOME`                                                                        | 由 WeMind 给子进程设置，仅 sandbox 指向账号沙箱；不要手动固定                                                                                             |
| `WEMIND_ACP_AUTO_ALLOW`                                                               | ACP agent 反向权限请求：**默认 yolo 放行**（自动选 `allow_once`/`allow_always`）；设 `0`/`false`/`off`/`no` 恢复逐次拒绝                          |
| `WEMIND_ACP_SESSION_MODE`                                                             | 覆盖/关闭预设的会话模式（`session/set_mode`）：`0`/`false`/`off`/`no` 关闭，其它值 = 该 modeId                                                      |
| `WEMIND_LOG_MAX_MB` / `WEMIND_LOG_KEEP`                                               | `daemon.log` 轮转：单文件上限（默认 10）/ 保留份数（默认 3，`0` = 不留历史）；builtin 运行中轮转，pm2 用 `pm2-logrotate`                            |
| `WEMIND_LOG_LEVEL`                                                                    | 设为 `debug` 才输出 DEBUG 级别（预留级别，当前没有 debug 调用点）；INFO/WARN/ERROR 始终输出                                                         |
| `WECHAT_INBOUND_MEDIA_MAX_MB` / `WECHAT_OUTBOUND_FILE_MAX_MB`                         | 入站文件/视频/语音单文件上限（默认 100）/ 出站附件单文件上限（默认 25）                                                                             |
| `WECHAT_MEDIA_TTL_DAYS` / `WECHAT_MEDIA_MAX_MB`                                       | 入站媒体（`direct` 为 `<账号>/media/inbound`，`sandbox` 为沙箱内）保留天数 / 总量上限（默认 30 天 / 1GB；启动时 + 写入媒体时清理）                     |
| `WECHAT_TOOL_PROGRESS_ITEMS`                                                          | 结构化工具进度 item（11/12）开关（**默认关**：微信客户端目前不渲染，只发文本「步骤 N」；`1` = 启用）                                                |

## 与 MCP 形态的区别

|      | `@wemind/cli`（命令 `wemind`）                                                       | `@wemind/wechat-mcp`              |
| ---- | ------------------------------------------------------------------------------------ | --------------------------------- |
| 驱动 | 自己常驻、自己调大脑                                                                 | 随 MCP 客户端生命周期，被动调工具 |
| 大脑 | 独立 ACP agent 进程                                                                  | 就是 MCP 客户端背后的模型         |
| 能力 | 收文本/图片/语音/文件/视频；发图片/文件/视频与长回复转 `.md`；远程任务、多账号、7×24 | 文本收发为主（媒体只给占位符）    |

## 文档

- 完整文档：<https://github.com/imwangpan/WeMind>
- 新手一步步教程：[docs/使用指南/新手教程.md](../../docs/使用指南/新手教程.md)
- 发布与版本规则：[docs/发布与变更记录/如何发布新版本.md](../../docs/发布与变更记录/如何发布新版本.md)
- AI 协作者入口：[AGENTS.md](../../AGENTS.md)
- 接入其它 ACP agent：[docs/接入方案/接入其它-ACP-Agent.md](../../docs/接入方案/接入其它-ACP-Agent.md)
- Daemon 常驻原理：[docs/repowiki/10-部署与运维.md](../../docs/repowiki/10-部署与运维.md)

## License

MIT
