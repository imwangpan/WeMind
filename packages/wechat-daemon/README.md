# @wemind/cli — 命令 `wemind`

> **你的 AI 大脑，挂在微信上。** 常驻微信 Bot daemon：自己长轮询 iLink 收消息 → 调常驻 **ACP 大脑**生成回复 → 自动回发。支持**运行时切换大脑**（免重启）、**多任务并行（worker 进程池）**、**完整会话管理**（列表/恢复/改名/删除）、**会话交接**、**多账号**、收发图/文件。

[WeMind](https://github.com/imwangpan/WeMind) monorepo 的完整应用包；只依赖内核 `@wemind/wechat-ilink-core`（构建时已内联进单文件产物），不碰 MCP 层，可独立运行。

> **包名 `@wemind/cli` ≠ 命令名 `wemind`。** 与 `@modelcontextprotocol/*`、`@angular/cli`、`@openai/codex` 的惯例一致：包收在 scope 下，命令保持短名。因为包名与 bin 名不同，**`npx` 不会自动挑 bin，必须写全包名**。

## 安装

```bash
npm i -g @wemind/cli     # 安装后得到 wemind 命令
wemind version           # → wemind 1.2.0 (@wemind/cli, node …, win32-x64)   # 版本以实际安装为准

# 不安装、一次性运行（注意是包名 @wemind/cli，不是 wemind）
npx -y @wemind/cli list
```

要求：**Node.js >= 20**；想让它真的会「思考」，需要 PATH 上有一个支持 **ACP** 的 agent CLI（`kiro-cli` / `opencode` / 桌面端 `dsh` / `qodercli` / `cline` 等；未配置时自动探测 `kiro → opencode → gemini → deepseek → qoder → cline`）。

## 升级

```bash
npm i -g @wemind/cli@latest
wemind stop <账号> && wemind start <账号>   # 已在运行的 daemon 不会自动加载新代码
```

## 三步上手

```bash
wemind login --label 工作号 --start   # ① 终端里出二维码，微信扫码 → 自动归档 + 启动常驻
wemind list                          # ② 看账号与运行状态
wemind brain check                   # ③ 验证大脑能说 ACP（initialize + session/new 握手）
```

之后在微信里随便发一句话，就该收到回复。日志在 `~/.wemind/<账号>/daemon.log`。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `wemind login [--label 名] [--start] [--runner builtin\|pm2]` | 扫码登录；`--start` 顺带拉起常驻 |
| `wemind list` | 账号、别名、运行状态、当前大脑、worker 池 |
| `wemind start / stop <key\|label>` | 启停某账号的常驻 |
| `wemind brain [show\|set\|unset\|check]` | 查看 / 设置（写入磁盘）/ 清除 / 自检大脑（`brain set deepseek --bin "<绝对路径>" --restart`）；只加启动开关用 `--extra-args "…"`（追加，保留预设的 ACP 模式参数），`--args "…"` 是整段替换（漏掉 `acp` 会握手超时，`wemind brain` 会警告） |
| `wemind brain switch <agent 名\|auto>` | **热切换对话大脑**：daemon 在跑也不重启、不打断在途回合；失败自动回滚。`--worker` 设默认任务大脑；`wemind brain handoff` 生成交接摘要 |
| `wemind session new [名字] / list / resume <ref> / rename <ref> <名> / delete <ref>` | 会话管理：新建 / 列表 / 严格恢复 / 改名 / 删除（`ref` = 序号、名字或 id 前缀） |
| `wemind task "<描述>" [--agent 名] [--cwd 目录]` | 派发任务给 worker（多任务并行、按编号回话） |
| `wemind task-list / task-reply <编号> "…" / task-stop [编号\|全部]` | 任务列表、回话续跑（`task-reply 继续`）、结束（在等回复的进程回池复用） |
| `wemind allow / revoke / allowlist` | 授权管理（谁能驱动这个 bot） |
| `wemind logout / delete / label / set-default` | 账号运维 |
| `wemind version` / `wemind help` | 版本、完整帮助 |

`key` = 由微信 botId 派生的目录名；`label` = 人类可读别名，多数命令两者都能用。

## 常驻怎么跑

`wemind start` 默认用**自带的跨平台后台守护进程**（builtin）：detached 拉起 `wemind _watchdog`，它循环执行 `wemind daemon`，进程退出 5 秒后自动重拉；单实例靠 `wrapper.pid` + 进程身份校验。也可以用 `--runner pm2`（或 `WEMIND_RUNNER=pm2`）交给 pm2——`wemind` 会在账号目录生成 `pm2.app.json`（5s 重拉、最多 50 次、退出码 78 停手、日志合并到 `daemon.log`，与 builtin 语义一致），再 `pm2 start` 它。

开机自启：让系统在登录时执行一次 `wemind start <账号>` 即可（Windows 计划任务/启动文件夹、Linux systemd user service、macOS launchd）。**同一账号只用一套常驻方案**——两种 runner 同时跑会抢同一个 bot token。

## 数据与安全

- 所有状态在 `~/.wemind/<账号>/`（可用 `WEMIND_HOME` 改根目录）：`account.json` 登录凭证、`state.json` 游标（读到哪条消息了）、`allowFrom.json` 授权清单、`brain-home/` 大脑沙箱、`daemon.log` 日志。
- ⚠️ **daemon 会让大脑免确认执行工具**（**8 个内置预设默认都免审批**：kiro `--trust-all-tools`、gemini `--approval-mode yolo`、qoder `--yolo`、cline `--auto-approve true`、opencode 沙箱 `permission: allow`、DSH `danger-full-access`、claude-code `bypassPermissions`、codex `agent-full-access`）：能给这个 bot 发消息的人，即可让大脑在本机执行任意工具（shell / 写文件）。唯一安全闸是**发件人授权（allowFrom）**：扫码登录者自动授权，**勿清空**。边缘权限请求默认拒绝，`WEMIND_ACP_AUTO_ALLOW=1` 才逐次放行。
- `account.json` 里 bot token 是明文（POSIX 上 chmod 600；Windows 请用目录权限或磁盘加密）。
- 同一个 bot token **只能有一个消费者**：`wemind` daemon 与 `@wemind/wechat-mcp` 二选一，否则互相抢消息。

## 环境变量（常用）

| 变量 | 含义 |
| --- | --- |
| `WEMIND_HOME` | 数据根目录，默认 `~/.wemind` |
| `WECHAT_ACCOUNT` / `WECHAT_DATA_DIR` | 指定账号 / 指定完整数据目录（多账号隔离） |
| `WEMIND_RUNNER` | `builtin`（默认）或 `pm2` |
| `WEMIND_BRAIN` / `WEMIND_BRAIN_BIN` / `WEMIND_BRAIN_ARGS` / `WEMIND_BRAIN_EXTRA_ARGS` | 一次性覆盖大脑选择与启动参数（`ARGS` 整段替换、`EXTRA_ARGS` 追加；持久化请用 `wemind brain set`） |
| `WEMIND_ACP_AUTO_ALLOW=1` | 放行 ACP agent 的一次性权限请求（默认为拒绝） |
| `WEMIND_ACP_SESSION_MODE` | 覆盖/关闭预设的会话模式（`session/set_mode`）：`0`/`false`/`off` 关闭，其它值 = 该 modeId |

## 与 MCP 形态的区别

| | `@wemind/cli`（命令 `wemind`） | `@wemind/wechat-mcp` |
| --- | --- | --- |
| 驱动 | 自己常驻、自己调大脑 | 随 MCP 客户端生命周期，被动调工具 |
| 大脑 | 独立 ACP agent 进程 | 就是 MCP 客户端背后的模型 |
| 能力 | 收发图/文件、远程任务、多账号、7×24 | 文本收发为主 |

## 文档

- 完整文档：<https://github.com/imwangpan/WeMind>
- 新手一步步教程：[docs/新手教程.md](https://github.com/imwangpan/WeMind/blob/main/docs/新手教程.md)
- 发布与版本规则：[docs/发布-wemind-npm.md](https://github.com/imwangpan/WeMind/blob/main/docs/发布-wemind-npm.md)
- AI 协作者入口：[AGENTS.md](https://github.com/imwangpan/WeMind/blob/main/AGENTS.md)
- 接入其它 ACP agent：[docs/接入其它-ACP-Agent.md](https://github.com/imwangpan/WeMind/blob/main/docs/接入其它-ACP-Agent.md)
- Qoder 接入：[docs/接入-Qoder.md](https://github.com/imwangpan/WeMind/blob/main/docs/接入-Qoder.md)
- Daemon 常驻原理：[docs/repowiki/10-部署与运维.md](https://github.com/imwangpan/WeMind/blob/main/docs/repowiki/10-部署与运维.md)

## 维护者：发布新版本

本包（包名 `@wemind/cli`，命令 `wemind`）通过 GitHub Actions（[`.github/workflows/wemind-publish.yml`](../../.github/workflows/wemind-publish.yml)）发布到 npm。**下面的命令都在 WeMind 仓库根目录运行**，不是在 `packages/wechat-daemon` 子目录。

> ℹ️ **版本号只有一处来源**：`packages/wechat-daemon/package.json` 的 `version`。`src/version.ts` 在**运行时**读它（不再手写常量），所以改版本不会漏改源码。仓库提供 `npm run release:*` 一步到位，并自动跑一致性自检。

### 第一步：判断要不要发版

| 你改了什么 | 需要发版吗 |
| --- | --- |
| `packages/wechat-daemon/src/**` 或 `packages/wechat-ilink-core/src/**`（内核会内联进来） | ✅ 要 |
| 只改了 `*.md` 文档 | ❌ 不用（CI 仍跑检查，但版本没变会跳过发布） |
| 只改了 `packages/wechat-mcp/**` | ❌ 与本包无关，发的是另一个包 |

> 同一个版本号**不能重复发布**。所以「有没有改代码」不是关键，「有没有升版本号」才是——没升就只会跑检查、不发布。

### 第二步：选版本号

| 参数 | 示例 | 什么时候用 |
| --- | --- | --- |
| `patch` | `1.0.0` → `1.0.1` | Bug 修复、兼容性改动（**最常用**） |
| `minor` | `1.0.0` → `1.1.0` | 新增向后兼容的能力（如新增内置的大脑 agent、新增子命令） |
| `major` | `1.0.0` → `2.0.0` | 不兼容改动（如删子命令、改数据目录布局、改 CLI 参数） |

### 第三步：升版本号（一条命令）

```powershell
npm run release:patch    # 1.1.0 → 1.1.1（Bug 修复）
npm run release:minor    # 1.1.0 → 1.2.0（向后兼容的新功能）
npm run release:major    # 1.1.0 → 2.0.0（不兼容改动）
```

这三个脚本等价于：

```powershell
npm version <type> --workspace @wemind/cli --no-git-tag-version && npm run check:version
```

- 前半句改 **`package.json` 与 `package-lock.json` 两处**；`--no-git-tag-version` 让它**不**自动创建 git commit 和 tag（我们的发布流程要求「版本号 + 源码改动」在同一个 commit 里）；
- 后半句跑 `check-version` 自检：包名、`bin` 是否仍叫 `wemind`、lock 是否同步、**`src/version.ts` 有没有被改回硬编码版本号**。任一项不对就 `exit 1`，`&&` 会中断，不会带着错误版本继续。

> **指定具体版本**：`npm version 1.4.2 --workspace @wemind/cli --no-git-tag-version`
>
> 想完全手动也可以：改 `packages/wechat-daemon/package.json` 的 `"version"`，再 `npm install --package-lock-only --ignore-scripts` 刷新 lock。
> **不需要**改 `src/version.ts`——它运行时读 package.json。不要手动编辑 `package-lock.json`。

### 第四步：本地校验

```powershell
npm run check:version    # 包名 / bin / lock / 无硬编码版本号
npm run lint && npm run typecheck && npm run build && npm test
npm pack --dry-run --workspace @wemind/cli    # 应看到 5 个文件：LICENSE / README.md / package.json / dist/cli.js / dist/cli.js.map
```

> ⚠️ **`npm publish` 不会自动 build**。CI 会 build，但本地 `npm pack` 前必须先 `npm run build`，否则打出来是旧产物（`dist/` 在 `.gitignore` 里）。
>
> `prepack` 守卫（`scripts/prepack-guard.mjs`）会兜底拒绝：产物目录为空、`bin` 缺失、或声明了 sourcemap 却没把 `.map` 带进包。

### 第五步：提交并推送

```powershell
git add packages/wechat-daemon/package.json package-lock.json
git add packages/wechat-daemon/src packages/wechat-ilink-core/src   # 有源码改动时
git commit -m "chore: release @wemind/cli 1.2.0"   # 换成当前要发的版本
git push origin main
```

推送到 `main` 后，工作流依次执行：

```
check-version（包名 / bin / lock / 无硬编码版本号）→ npm ci → lint → format:check → typecheck → build → test
→ npm pack --dry-run（prepack 守卫确认包内容）
→ 把 tarball 真装到临时目录跑 wemind version / help（装包冒烟）
→ 检查 npm 上是否已存在该版本
→ 不存在则 npm publish（带 provenance 来源证明）；已存在则跳过并输出 notice
```

**看到 `Publish to npm` 显示 skipped 是正常的**：说明这个版本已发过（比如你只改了文档、没升版本）。想真正发版，回到第二步升版本号。

### 第六步：发布后验收

```powershell
npm view @wemind/cli version                        # 应显示新版本号
npm i -g @wemind/cli@latest && wemind version       # → wemind <新版本> (@wemind/cli, node …, <platform>-<arch>)
wemind list                                         # 应能正确识别在跑的账号与进程
```

已装用户升级：`npm i -g @wemind/cli@latest`，然后 `wemind stop <账号> && wemind start <账号>` ——**正在运行的 daemon 不会自动加载新代码**。

### 常见坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `check-version` 报「lock 版本不一致」 | 手改了 `package.json` 没刷新 lock | `npm install --package-lock-only --ignore-scripts`（或改用 `npm run release:*`） |
| `check-version` 报「硬编码 CLI_VERSION 字面量」 | 有人把 `src/version.ts` 改回了常量写法 | 还原为 `readOwnVersion(...)`（版本号必须只来自 package.json） |
| CI 绿了但 npm 上没新版本 | 版本号没升，被跳过 | `npm run release:patch` 后再推 |
| `npm pack` 出来是空壳 | 没先 `npm run build` | 先 build 再 pack |
| `prepack` 守卫拒绝发布 | 产物为空 / `bin` 缺失 / 声明了 sourcemap 但 `.map` 不在包里 | 按守卫提示补 build 或检查 `files` |
| `npm publish` 报 403 / EOTP | 本地直发需要交互式 2FA | **不要本地发**，走 CI（Trusted Publisher 已配好） |

## License

MIT
