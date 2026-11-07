# 跨平台常驻方案（pm2）

> **最后核对**：2026-11-08

WeMind 的 daemon 本体是纯 Node.js，**跨平台**；常驻外壳有三套实现：**builtin**（`wemind start` 默认，跨平台零依赖）、**pm2**（`--runner pm2` 或 `WEMIND_RUNNER=pm2`）、**PowerShell 版后台守护进程**（`scripts/run-daemon.ps1 -Mode shell`，Windows 源码开发者；脚本默认是转 builtin 的薄壳）。本文说明 pm2 这套：**Windows / Linux / macOS 通用**，适合想用成熟进程管理器统一管理多账号的场景。

> 配置文件：仓库根的 `ecosystem.config.cjs`（多账号动态生成）。
> 常驻底层原理见 [daemon-常驻原理.md](daemon-常驻原理.md)。

---

## 1. 为什么用 pm2

pm2 是 Node 生态的进程管理器，**一个工具同时顶替**常驻外壳要手写的所有东西：

| 能力 | builtin `_watchdog` / `run-daemon.ps1`（默认薄壳或 `-Mode shell`） | pm2 |
|------|----------------|-----|
| 崩溃自动重拉（后台守护进程） | 各自的重拉循环（5s） | `autorestart`（内置） |
| 开机自启 | 系统计划任务 / systemd / launchd | `pm2 startup` + `pm2 save` |
| 单实例 | `wrapper.pid` 身份校验 / 命名 Mutex | 按 app 名天然唯一 |
| 脱离终端 | detached spawn / `Start-Process` | pm2 守护化（内置） |
| 多账号 | 每账号一条链（`run-all-daemons.ps1`） | `ecosystem.config.cjs` 按账号生成多 app |
| 日志 | `RotatingLog` / `*>> daemon.log` | `out_file`/`error_file`（已指到各账号 `daemon.log`） |

所以 Linux/macOS 上本来就有 builtin（无需 pm2）；pm2 的价值在于**跨平台统一、多账号集中管理**。在 Windows 上 pm2 也能替代 `run-daemon.ps1`（后者默认也是薄壳转 builtin，自启那一步稍特殊，见 §4）。

---

## 2. 安装与前置

**两条路线，先选一条**：

- **安装版用户**（`npm i -g @wemind/cli`，机器上没有本仓库）：不需要 `npm run build`，也没有 `ecosystem.config.cjs`。用 CLI 自带的 pm2 runner：`wemind start <账号> --runner pm2`（或 `WEMIND_RUNNER=pm2`），`wemind stop <账号>` 停。下文 §3–§6 的 `ecosystem.config.cjs` 步骤只适用于源码路线。
- **源码开发者**（clone 了本仓库）：按下文步骤走。

```bash
npm install -g pm2      # 全局装 pm2
npm run build           # 仅源码路线：在仓库根构建出 packages/wechat-daemon/dist
```

前提：**至少登录过一个账号**（`~/.wemind/accounts.json` 存在）。没有注册表时配置会回退到单账号 `default`（数据目录 `~/.wemind/default`）。登录见 README 的「多账号管理」。

`agent 二进制要在 PATH 上`：pm2 不像 PowerShell 版守护进程那样兜底找 `%LOCALAPPDATA%\Kiro-Cli`。确保 `kiro-cli`（或你选的 ACP agent）在 PATH，或在 `ecosystem.config.cjs` 的 `env` 里加 `WEMIND_BRAIN_BIN`（见 docs/接入方案/接入其它-ACP-Agent.md）。更好的做法：`wemind brain set <agent 名> --bin <绝对路径>` 落到账号 `brain.json`，各启动方式通吃。

---

## 3. 启动

在仓库根：

```bash
pm2 start ecosystem.config.cjs    # 为每个已登记账号起一个 wemind-<key>
pm2 status                        # 看状态
pm2 logs wemind-<key>             # 跟某账号日志（也可直接看 ~/.wemind/<key>/daemon.log）
```

`ecosystem.config.cjs` 会读 `~/.wemind/accounts.json`，每个账号一个 app：`wemind-<botId派生key>`，注入 `WECHAT_ACCOUNT`，崩溃 5s 后重启，日志写各账号 `daemon.log`。

---

## 4. 开机自启（按系统）

### Linux / macOS（原生，推荐）

```bash
pm2 start ecosystem.config.cjs
pm2 save                 # 保存当前进程列表
pm2 startup              # 打印一条命令；按提示用 sudo 执行它（生成 systemd/launchd 集成）
```

`pm2 startup` 会生成 systemd（Linux）或 launchd（macOS）的开机项；`pm2 save` 后的进程列表会在开机时被 `pm2 resurrect` 自动拉起。

### Windows（pm2 自启较特殊）

pm2 官方对 Windows 开机自启支持不完善（`pm2 startup` 不原生支持 Windows）。现在由 `wemind autostart install` 统一处理：

```powershell
wemind autostart install
```

检测到 pm2 时，它会：

1. 按声明启动 `wemind-<key>` 实例（等价于 `pm2 start`）并 `pm2 save`；
2. 创建登录计划任务 `wemind-autostart-pm2`，默认动作是 `wemind start --all --runner pm2`（只装部分账号时是 `start <key…> --runner pm2`）——pm2 守护进程按需启动、按声明重建实例后再 `pm2 save`。这条命令内部仍要调用 `pm2`，所以 **`pm2` 必须在登录环境的 PATH 中**（npm 全局安装通常已经在用户 PATH 里）。

不再需要手工把计划任务命令写成 `pm2 resurrect`。若坚持手工方式，仍可让计划任务执行 `pm2 resurrect`，但同一账号只能保留一套触发器；`wemind autostart status` 会显示 `mixed` 并提示处理。

> 简言之：**Linux/macOS 用 pm2 一条龙；Windows 用 `wemind autostart install` 生成 `wemind-autostart-pm2` 登录任务，或干脆不用 pm2、让内置 watchdog 托管。**

---

## 5. 常用运维命令

```bash
pm2 status                     # 总览
pm2 logs                       # 全部日志
pm2 logs wemind-<key>          # 单账号
pm2 restart wemind-<key>       # 重启某账号（如改了 brain agent 配置）
pm2 restart all
pm2 stop wemind-<key>          # 停某账号
pm2 delete wemind-<key>        # 从 pm2 移除某账号
pm2 save                       # 保存当前列表（改动后记得存，否则重启机器丢失）
```

---

## 6. 多账号增删

- **新增账号**：先登录（`wemind login ...`），再：
  ```bash
  pm2 start ecosystem.config.cjs    # 会为新账号补起 app（已在跑的不受影响）
  pm2 save
  ```
- **移除账号**：直接 `wemind delete <key>` 即可——它内部先 `stopDaemon()`（先 `pm2 delete` 该 app，再按 pid 兜底杀 wrapper/daemon/brain/worker），确认停干净后才删目录。删完记得 `pm2 save`（否则重启后 pm2 还会按旧清单尝试拉起）。若想分步：`wemind stop <key>` → `wemind delete <key>` → `pm2 save`。

---

## 7. 与其它常驻方案的互斥（重要）

**不要对同一账号同时跑两套常驻**（pm2 / builtin `_watchdog` / `run-daemon.ps1 -Mode shell` 任意两套）——会出现两个 daemon 抢同一 token、互相打架。二选一：

- 用 pm2 → 先 `wemind stop <账号>`（它会杀掉 builtin 后台守护进程），并确保没有 `run-daemon.ps1 -Mode shell` 在跑、原计划任务「wemind-daemon」已删除；`run-daemon.ps1` 默认的 cli 薄壳最终也走 builtin，与 `wemind start` 等价；
- 用 builtin 或原 PowerShell 方案 → 不要 `pm2 start`。

builtin 的 `wrapper.pid` 单实例守卫与 PowerShell（`-Mode shell`）的命名 Mutex 都**只防自己那一套重复**，不感知 pm2，所以互斥要靠你在两套之间二选一。

---

## 8. 环境变量

可在 `ecosystem.config.cjs` 各 app 的 `env` 里加（或系统级设置）：

- `WEMIND_BRAIN` / `WEMIND_BRAIN_BIN` / `WEMIND_BRAIN_ARGS` / `WEMIND_BRAIN_EXTRA_ARGS` / `WEMIND_BRAIN_HOME_ENV` —— 选/配 ACP agent（见 docs/接入方案/接入其它-ACP-Agent.md）。**更省心**：用 `wemind brain set <agent 名> [--bin <绝对路径>]` 把选择落到账号 `brain.json`——pm2 / 后台守护进程 / 手动启动都读它，无需在 `env` 里配；
- `WECHAT_OWNER_ID` —— 覆盖「登录者」（默认取扫码登录者的 userId；`allowFrom` 登录者白名单是兜底）；
- `WECHAT_BRAIN_IDLE_MS` / `WECHAT_BRAIN_CAP_MS` —— 大脑回合空闲/硬超时。

`WECHAT_ACCOUNT` 已由配置自动按账号注入，不要手动覆盖。

### 日志轮转（必须配）

pm2 只是把 stdout/err 写进 `daemon.log`，**不会自己轮转**——`ecosystem.config.cjs` 里没有 `max_size`/`retain`，长期跑会把磁盘写满。装一次 pm2-logrotate 即可（与 builtin 的 `RotatingLog` 等价）：

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M      # 与 builtin 的 WEMIND_LOG_MAX_MB 默认 10 对齐
pm2 set pm2-logrotate:retain 3          # 与 WEMIND_LOG_KEEP 默认 3 对齐
pm2 set pm2-logrotate:compress true     # 压缩历史，省磁盘
```

> 用 builtin runner（`wemind start` 不带 `--runner pm2`）时**不需要**这一步——`log-rotate.ts` 的 `RotatingLog` 自己会按 `WEMIND_LOG_MAX_MB` / `WEMIND_LOG_KEEP` 轮转。

---

## 9. 不想用 pm2？原生 systemd / launchd 示例

### Linux（systemd 用户服务，模板化多账号）

`~/.config/systemd/user/wemind@.service`：

```ini
[Unit]
Description=WeMind daemon (%i)
After=network-online.target

[Service]
Environment=WECHAT_ACCOUNT=%i
ExecStart=/usr/bin/node /abs/path/WeMind/packages/wechat-daemon/dist/cli.js daemon
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now wemind@<账号key>        # 每账号一个实例（%i = 账号 key）
loginctl enable-linger $USER                                # 允许未登录也常驻（服务器场景）
```

### macOS（launchd LaunchAgent）

`~/Library/LaunchAgents/com.wemind.<key>.plist`：`ProgramArguments` = `[node, /abs/path/WeMind/packages/wechat-daemon/dist/cli.js, daemon]`（前台常驻本体；**不是** `dist/index.js`，也不是 `wemind start`），加 `EnvironmentVariables.WECHAT_ACCOUNT=<key>`、`KeepAlive=true`、`RunAtLoad=true`，然后 `launchctl load`。

> systemd `Restart=always` / launchd `KeepAlive` 就是后台守护进程；`enable` / `RunAtLoad` 就是自启；服务单元天然单实例——和 pm2 等价，只是手写 unit。

---

## 10. 小结

- **业务代码零改动**即跨平台；本方案只加常驻外壳。
- **Linux/macOS**：不装 pm2 也能用 builtin（`wemind start <账号>`）；要集中管理就用 `pm2 start ecosystem.config.cjs && pm2 save && pm2 startup`，或写 systemd/launchd unit。
- **Windows**：默认 builtin；装了 pm2 时 `wemind autostart install` 会创建登录任务 `wemind-autostart-pm2`（执行 `start --all --runner pm2`），源码开发者也可用 `run-daemon.ps1`（默认薄壳转 builtin）或 `-Mode shell` + 计划任务。
- **同一账号只用一套**常驻方案，别叠加。
