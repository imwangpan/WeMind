# 跨平台常驻方案（pm2）

WeMind 的 daemon 本体是纯 Node.js，**跨平台**；只有「常驻外壳」（后台守护进程 + 自启）原先是 Windows + PowerShell 7 专属（`scripts/run-daemon.ps1` + 计划任务）。本文给出一份 **Windows / Linux / macOS 通用**的常驻方案，用 [pm2](https://pm2.keymetrics.io/)。

> 配置文件：仓库根的 `ecosystem.config.cjs`（多账号动态生成）。
> 常驻底层原理见 [daemon-常驻原理.md](daemon-常驻原理.md)。

---

## 1. 为什么用 pm2

pm2 是 Node 生态的进程管理器，**一个工具同时顶替**原来那套 PowerShell 外壳要手写的所有东西：

| 能力 | 原 Windows 方案 | pm2 |
|------|----------------|-----|
| 崩溃自动重拉（后台守护进程） | `run-daemon.ps1` 的 `while` 循环 | `autorestart`（内置） |
| 开机自启 | 计划任务 / 启动文件夹 VBS | `pm2 startup` + `pm2 save` |
| 单实例 | 命名 Mutex | 按 app 名天然唯一 |
| 脱离终端 | 计划任务 / `Start-Process` | pm2 守护化（内置） |
| 多账号 | 每账号一个 wrapper | `ecosystem.config.cjs` 按账号生成多 app |
| 日志 | `*>> daemon.log` | `out_file`/`error_file`（已指到各账号 `daemon.log`） |

所以在 Linux/macOS 上，`run-daemon.ps1` 整个用不上；在 Windows 上 pm2 也能替代它（自启那一步稍特殊，见 §4）。

---

## 2. 安装与前置

```bash
npm install -g pm2      # 全局装 pm2
npm run build           # 在仓库根：先构建出 packages/wechat-daemon/dist
```

前提：**至少登录过一个账号**（`~/.wemind/accounts.json` 存在）。没有注册表时配置会回退到单账号 `default`（数据目录 `~/.wemind/default`）。登录见 README 的「多账号管理」。

`agent 二进制要在 PATH 上`：pm2 不像 PowerShell wrapper 那样兜底找 `%LOCALAPPDATA%\Kiro-Cli`。确保 `kiro-cli`（或你选的 ACP agent）在 PATH，或在 `ecosystem.config.cjs` 的 `env` 里加 `WEMIND_BRAIN_BIN`（见 docs/接入其它-ACP-Agent.md）。更好的做法：`wemind brain set <agent 名> --bin <绝对路径>` 落到账号 `brain.json`，各启动方式通吃。

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

pm2 官方对 Windows 开机自启支持不完善（`pm2 startup` 不原生支持 Windows）。三选一：

1. **继续用现成的计划任务**，但把它执行的命令换成 `pm2 resurrect`（最省心，复用 §daemon-常驻原理 里的计划任务方式）：
   ```powershell
   pm2 start ecosystem.config.cjs; pm2 save
   # 计划任务（登录触发）执行： pm2 resurrect
   ```
2. 用社区方案 [pm2-installer](https://github.com/jessety/pm2-installer)（把 pm2 装成 Windows 服务）。
3. **干脆不用 pm2**，Windows 仍用原来的 `scripts/run-daemon.ps1` + 计划任务（见 README「Windows 登录自启」）——功能等价。

> 简言之：**Linux/macOS 用 pm2 一条龙；Windows 可用 pm2 跑但自启建议仍走计划任务（执行 `pm2 resurrect`），或直接沿用原 PowerShell 方案。**

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
- **移除账号**：`pm2 delete wemind-<key>` + `pm2 save`，再按需 `wemind delete <key>` 清数据目录。

---

## 7. 与原 Windows 方案的互斥（重要）

**不要对同一账号同时跑 pm2 和 `run-daemon.ps1`**——会出现两个 daemon 抢同一 token、互相打架。二选一：

- 用 pm2 → 关掉/删除原计划任务「wemind-daemon」，并确保没有 `run-daemon.ps1` 在跑；
- 用原 PowerShell 方案 → 不要 `pm2 start`。

原 PowerShell 方案的命名 Mutex 只防它自己重复，**不感知 pm2**，所以互斥要靠你在两套之间二选一。

---

## 8. 环境变量

可在 `ecosystem.config.cjs` 各 app 的 `env` 里加（或系统级设置）：

- `WEMIND_BRAIN` / `WEMIND_BRAIN_BIN` / `WEMIND_BRAIN_ARGS` / `WEMIND_BRAIN_EXTRA_ARGS` / `WEMIND_BRAIN_HOME_ENV` —— 选/配 ACP agent（见 docs/接入其它-ACP-Agent.md）。**更省心**：用 `wemind brain set <agent 名> [--bin <绝对路径>]` 把选择落到账号 `brain.json`——pm2 / 后台守护进程 / 手动启动都读它，无需在 `env` 里配；
- `WECHAT_OWNER_ID` —— 覆盖「登录者」（默认取扫码登录者的 userId；`allowFrom` 登录者白名单是兜底）；
- `WECHAT_BRAIN_IDLE_MS` / `WECHAT_BRAIN_CAP_MS` —— 大脑回合空闲/硬超时。

`WECHAT_ACCOUNT` 已由配置自动按账号注入，不要手动覆盖。

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
systemctl --user enable --now wemind@feead781eb44.service   # 每账号一个实例
loginctl enable-linger $USER                                # 允许未登录也常驻（服务器场景）
```

### macOS（launchd LaunchAgent）

`~/Library/LaunchAgents/com.wemind.<key>.plist`：`ProgramArguments` = `node .../dist/index.js`，加 `EnvironmentVariables.WECHAT_ACCOUNT=<key>`、`KeepAlive=true`、`RunAtLoad=true`，然后 `launchctl load`。

> systemd `Restart=always` / launchd `KeepAlive` 就是后台守护进程；`enable` / `RunAtLoad` 就是自启；服务单元天然单实例——和 pm2 等价，只是手写 unit。

---

## 10. 小结

- **业务代码零改动**即跨平台；本方案只加常驻外壳。
- **Linux/macOS**：`pm2 start ecosystem.config.cjs && pm2 save && pm2 startup`（或写 systemd/launchd unit），一条龙。
- **Windows**：可用 pm2（自启走计划任务执行 `pm2 resurrect`），或继续用原 `run-daemon.ps1` + 计划任务。
- **同一账号只用一套**常驻方案，别叠加。
