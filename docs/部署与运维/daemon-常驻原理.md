# Daemon 后台常驻原理（详解）

> **最后核对**：2026-11-14
>
> ⚠️ **三套常驻外壳，同一账号只用一套**：
>
> - **发布版（`npm i -g @wemind/cli`）默认 builtin runner**：`wemind start` → detached `cli.js _watchdog`（Node 写的后台守护进程）→ 循环跑 `cli.js daemon`。零依赖、跨平台。见 §2'。
> - **pm2 runner**：`wemind start --runner pm2`（或 `WEMIND_RUNNER=pm2`），或源码开发者的 `ecosystem.config.cjs`。见 [跨平台常驻-pm2.md](跨平台常驻-pm2.md)。
> - **源码开发者（Windows）的 `scripts/run-daemon.ps1`**：默认是**薄壳**——定位 node 与仓库根后执行 `wemind start`，常驻仍由 builtin `_watchdog` 负责（源码与发布版走同一条代码路径）；`-Mode shell` 才启用旧的 PowerShell 监督循环（独立实现 + 命名 Mutex）。
>
> 三套的**设计思想相同**（外层后台守护进程 + 5s 重拉 + 单实例守卫 + pid 链），只是实现语言不同。**同一账号只能用一套**。

本文详细说明 WeMind daemon 如何做到「开机自启 + 一直在后台收发微信 + 崩了自动恢复」。常驻不是单一机制，而是**三层进程 + 一个后台守护进程循环 + 一套保活/隔离细节**的组合。

> 📄 **只想速查？** 进程树、pid 文件表、故障恢复表、运维命令见 [repowiki 10. 部署与运维](../repowiki/10-部署与运维.md)——那篇是摘要，本文是详解，正文不重复。

> 相关文件：
>
> - `packages/wechat-daemon/src/cli/watchdog-runner.ts` —— **builtin 后台守护进程**（发布版默认；`cli.js _watchdog`）
> - `packages/wechat-daemon/src/cli/pm2-runner.ts` —— pm2 runner（`wemind start --runner pm2`）
> - `scripts/run-daemon.ps1` —— 源码仓库的启动/常驻外壳：默认薄壳转 `wemind start`，`-Mode shell` 保留 PowerShell 后台守护进程（源码开发者，Windows）
> - `scripts/run-all-daemons.ps1` —— 多账号批量启动（PowerShell 路线）
> - `packages/wechat-daemon/src/index.ts` —— daemon 本体（poller/worker 循环）
> - `packages/wechat-daemon/src/acp/acp-brain.ts` —— 大脑 ACP 子进程
> - `packages/wechat-daemon/src/cli/process-lifecycle.ts` —— 管理命令的进程启停（start/stop/logout/delete）

---

## 1. 整体进程树

```
开机触发器（同一台机器只用一个：Windows 计划任务 / HKCU Run 键 / Linux systemd / macOS launchd；`wemind autostart install` 生成）
        │ 只负责「拉起一次」并脱离 shell
        ▼
   ① 后台守护进程（三选一，同一账号只用一套）
        · builtin：cli.js _watchdog   ← 发布版默认（跨平台，零依赖；run-daemon.ps1 默认也走它）
        · pm2：    pm2 start wemind-<key>
        · 源码：   pwsh run-daemon.ps1 -Mode shell（Windows，见 §2）
        │  while: 跑 node daemon; 退出后睡 5s 再跑
        ▼
   node  <cli.js> daemon            ← ② daemon 本体（业务，常驻）
        │  poller + fastWorker + worker 三个循环，永不自然退出
        ▼
   ACP agent（kiro-cli / opencode / dsh / qodercli…）  ← ③ 大脑/worker（懒启动、可自愈重建）
```

三层进程各写一个 PID 文件到账号数据目录 `~/.wemind/<key>/`：

| 文件               | 属于                      | 写入者                                            | 用途                                                                                                                                                                                                                    |
| ------------------ | ------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrapper.pid`      | ① 后台守护进程            | `watchdog-runner.ts`（builtin，含 `run-daemon.ps1` 默认的 cli 模式）/ `run-daemon.ps1 -Mode shell` | 管理命令据此停掉它（否则停了 daemon 会被立刻重拉）；兼作单实例守卫                                                                                                                                                      |
| `daemon.pid`       | ② daemon                  | `index.ts` 启动时                                 | 精确定位本账号 node 进程                                                                                                                                                                                                |
| `brain.pid`        | ③ 大脑                    | `acp-brain.ts` spawn 后                           | 区分「bot 的大脑」与用户自己日常用的 agent，便于清理                                                                                                                                                                    |
| `workers.pid.json` | ③' worker（可能多条并存） | `worker-pool.ts` / `worker-acp.ts` spawn 后       | 远程任务进程的**记录**（每条含起进程时真实用的 bin/args，供逐条身份校验；单条为对象、多条为数组）；`stop` 时一并清理（漏了会留下孤儿进程占着会话）。旧账号只有裸整数 `worker.pid`，仍按「配置算特征串」的老办法兼容读取 |
| `pm2.app.json`     | ① 后台守护进程            | `pm2-runner.ts`（仅 `--runner pm2`）              | pm2 的 app 声明（名字/重拉策略/日志/`WECHAT_ACCOUNT`）；由 `wemind start --runner pm2` 生成后 `pm2 start`                                                                                                               |

> **身份校验（防 pid 复用）**：pid 会被系统复用（尤其**重启后**）——只凭「pid 还活着」就杀进程或判定「运行中」，可能**误杀别人的进程**、或反而看不出「其实没起来」。所以所有基于 pid 文件的判断/停止都会先**核对该 pid 的命令行是否确属本程序**（`proc-identity.ts`）：daemon 与后台守护进程需命中**三组**特征串之一——`wemind` + `cli.js`（npm 安装与仓库绝对路径）、`wechat-daemon` + `dist` + `cli.js`（在仓库根用**相对路径**手跑；命令行里既没有仓库名也没有包名）、`run-daemon.ps1`（源码开发期的 PowerShell 版）；大脑/worker 需含其启动命令（如 `opencode acp`，据此与用户自己的 `opencode serve` 区分）。查不到命令行时**不再一律判否**，而是三态：`identifyProcess()` 返回 `ours` / `other` / `unknown`。**unknown 不等于 other**：`start` 与后台守护进程单实例守卫 fail-closed（拒绝启动，避免双开抢 token），`stop` 不杀且保留 pid 文件，`wemind list` 显示「无法确认」。Windows 查询输出用 `WEMIND|<pid>|<base64(UTF-8)>` 编码，避免 PS 5.1 控制台代码页（中文 Windows 为 936）把命令行解码成乱码；PowerShell 解析走 `shared/process/powershell.ts`（5.1 优先，缺失回退 `pwsh`）。
>
> ⚠️ 这里**不能只用**源码目录名 `wechat-daemon` 做特征：发布到 npm 后包目录叫 `@wemind/cli`，只用它会让「装出来的 wemind」永远认不出自己（`list` 恒显示「已停止」、`stop` 杀不掉、后台守护进程单实例守卫失效）。所以它只作为**追加**的一组，并要求 `dist` 一起出现，专门补「相对路径启动」这一种形态；同理也不能反过来删掉 `wemind` + `cli.js` 那一组。

> 停止时**必须把后台守护进程一起停掉**（断掉重拉）：只杀 daemon，它会在 5 秒后被后台守护进程重新拉起。
> 实现上 `manage.ts` 的 `stopDaemon()` 一次做完全部：把 `wrapper`/`daemon`/`brain`/`workers` 四类 pid 记录一起读出来（worker 可能多条：单条是对象、多条是数组）、逐条**校验身份**后交给 `killProcessTrees()` 统一终止（同一批里后台守护进程在它的 5 秒重拉延时结束前就已被杀掉，所以不必分先后）——Windows 走 `taskkill /T /F`，POSIX 先收集后代进程再 SIGTERM→SIGKILL（`process.kill` 单 pid 不会杀子树，这是 2026-10-27 修掉的跨平台缺陷）。

---

## 2'. 第①层（默认）：builtin 后台守护进程（`watchdog-runner.ts`）

`npm i -g @wemind/cli` 的用户走这一套，**不需要装 pm2、也不需要 PowerShell 脚本**：

```bash
wemind start <账号>            # 默认 WEMIND_RUNNER=builtin
wemind start <账号> --runner pm2   # 或 WEMIND_RUNNER=pm2 切到 pm2
```

`watchdogStart()` 用 `spawn(process.execPath, [cliPath, "_watchdog"], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, WECHAT_ACCOUNT: key } })` 脱离拉起一个后台守护进程；`runWatchdog()` 是它的循环本体：

```
单实例守卫（wrapper.pid 存在且 isOurProcess → 直接退出）
for (;;) {
  写 daemon.log：start daemon
  spawn(node, [cliPath, "daemon"], { stdio: 管道 → RotatingLog 逐块追加 daemon.log })
  等子进程退出（close，等 stdout/stderr 收完）→ 拿到 code
  code === 78（BRAIN_CONFIG_EXIT_CODE，大脑配置错误）? → 停止自动重启并提示人工修
  code === 75（DAEMON_ALREADY_RUNNING_EXIT_CODE，同账号已有实例）? → 停止自动重启（另一个实例已在服务）
  连续崩溃超过 WEMIND_MAX_RESTARTS（默认 50，跑满 10 分钟清零）? → 停止自动重启并提示看日志
  否则睡 5s 后重拉
}
```

要点：

- **单实例**：`acquireSingleton()` 用 `wrapper.pid` + `isOurProcess()` 校验（不只看 pid 是否存活，防重启后 pid 复用误判）；
- **退出码 78 特判**：大脑配置错误重拉无益，停在循环外，避免每 5 秒刷一条日志；**退出码 75**（同账号已有 daemon）同理——另一个实例已经在用同一个 bot token 收消息，重拉只会每 5 秒撞一次。
- **连续崩溃上限**：短暂运行就崩的连续次数超过 `WEMIND_MAX_RESTARTS`（默认 50，与 pm2 对齐）就停止重拉，避免崩溃循环无限刷日志/耗 CPU；daemon 跑满 10 分钟视为稳定、计数清零。PowerShell 版同一套语义。
- **跨平台**：不依赖 shell / Mutex / pm2，Windows 用 `windowsHide` 防闪窗；
- **日志**：stdout/stderr 经管道由 `RotatingLog` 逐块追加进 `<数据目录>/daemon.log`，与 PowerShell 路线一致；运行中按 `WEMIND_LOG_MAX_MB`（默认 10MB）轮转、保留 `WEMIND_LOG_KEEP`（默认 3）份。

> pm2 也是第①层的一种实现，与 builtin 后台守护进程**行为对齐**（`pm2-runner.ts`）：app 名 `wemind-<key>`、
> `restart_delay: 5000`、`max_restarts: 50`、`stop_exit_codes: [78, 75]`（75 = 同账号已有实例，重拉无益）、日志合并到账号 `daemon.log`。
> 声明写在账号目录的 `pm2.app.json` 里（不是把参数堆在 `pm2 start` 命令行上——`--stop-exit-codes`
> 是变参，还要和 `--` 分隔符挤在一起，只能靠真机试；JSON 声明没有这层解析）。
>
> 源码开发者的 `pm2 start ecosystem.config.cjs` 是**另一条**路线（同一组设置，按 `accounts.json` 批量生成 app）。

---

## 2. 第①层（源码开发者，Windows）：run-daemon.ps1

> 仅当你在**仓库里从源码跑**、且想用计划任务自启时才需要本节。发布版用户请用 §2'。

`run-daemon.ps1` 有两种模式（`-Mode`）：

### 2.1 cli（默认）：薄壳，复用 builtin watchdog

只做三件事：

1. 定位仓库根（`$PSScriptRoot` 反推）与 node 绝对路径（PATH 优先；fnm / nvm / Volta 兜底，并把 node 所在目录前置进 PATH，供 ACP agent 解析）；
2. 选账号：`-Account <key>` > `WECHAT_ACCOUNT` > CLI 默认账号；`-All` 传 `start --all`；
3. 执行 `node dist/cli.js start [<key>|--all]` 后退出。

常驻、5s 重拉、连续崩溃上限、单实例守卫全部由 `watchdog-runner.ts` 的 `_watchdog` 负责——源码开发者与发布版**跑的是同一条代码路径**，只保留一份 watchdog 实现。`-DryRun` 只打印将执行的命令，不启动进程（自检与测试用）。

### 2.2 shell：旧的 PowerShell 监督循环

`-Mode shell` 才进入下面这套独立实现；升级前的老计划任务若想保持原行为，加上该参数即可。

`run-daemon.ps1 -Mode shell` 的本质是一个**永不结束的监督循环（supervisor / watchdog）**：

```powershell
while ($true) {
  "[wemind/wechat-daemon/wrapper] start daemon $(Get-Date -Format o)" | Add-Content $log
  & $node "packages/wechat-daemon/dist/cli.js" daemon *>> $log   # 阻塞，直到 node 退出
  "[wemind/wechat-daemon/wrapper] daemon exited (code=$LASTEXITCODE), restart in 5s ..." | Add-Content $log
  Start-Sleep -Seconds 5
}
```

工作方式：

1. `& $node ...` 会**前台阻塞**——node daemon 可能跑几小时/几天，这一行就一直不返回；
2. 一旦 node 退出（崩溃、被 `taskkill`、异常），这行返回，记一条 `daemon exited (code=...)`；
3. 睡 5 秒（避免崩溃风暴时疯狂重启）；
4. 回到循环顶部，**重新拉起 node**。

这就是「daemon 崩了会自动恢复」的来源。**职责分离**：node 只管业务逻辑，保活完全交给外层后台守护进程。daemon 进程内部不做自重启。

> 关于「防挂起」规范的澄清：`run-daemon.ps1 -Mode shell` 里**故意**用前台阻塞 `& node` + `Start-Sleep`——它的职责就是守着 node。这不违反项目的「shell 防挂起」约定，因为那条约定约束的是「临时在交互 shell 里跑的命令」，而它本身是被计划任务以脱离方式启动的长期监督进程。

`-Mode shell` 启动时它还做几件准备：

- **设 UTF-8 编码**（`[Console]::OutputEncoding` / `$OutputEncoding`）：否则 node/kiro-cli 的中文输出按系统 GBK 代码页解码会乱码（早期踩过）。
- **定位仓库**：用 `$PSScriptRoot` 反推仓库根（脚本在 `<repo>/scripts/`），可移植，不写死路径。
- **解析数据目录**：`WECHAT_ACCOUNT` → `~/.wemind/<account>/`，或 `WECHAT_DATA_DIR` 直接指定；日志写各自目录的 `daemon.log`。
- **解析 node / kiro-cli**：走 PATH；kiro-cli 找不到时兜底到 `%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe`。

---

## 3. 单实例守卫（`-Mode shell`：命名 Mutex）

> cli 模式（默认）不自己管单实例——`wemind start` 拉起的 builtin watchdog 用 `wrapper.pid` + 进程身份校验守卫；两套互不感知，所以**同一账号不要同时用 cli 与 shell 模式**。

如果计划任务、手动启动、多次登录叠加，可能同时跑起多个 shell 守护循环 → 多个 daemon 抢同一个 token、互相打架（早期的坑①）。为此 `run-daemon.ps1 -Mode shell` 启动时用**命名 Mutex** 做单实例守卫：

```powershell
$dataKey  = WECHAT_DATA_DIR 或 "account:<WECHAT_ACCOUNT>" 或 "account:default"
$sha      = SHA1(dataKey.toLower())
$mutexName= "wemind-daemon-" + sha 前 16 位 hex
$mutex    = New-Object Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) { 记日志「已有实例在跑」; exit 0 }   # 抢不到锁 → 直接退出
```

- 抢到锁才继续；抢不到说明同账号已有守护进程在跑，本次直接退出。
- Mutex 名按**数据目录**派生 → **不同账号 = 不同 mutex** → 多账号各自独立、可共存，互不阻塞。
- 进程退出时操作系统自动释放 Mutex（`$global:WeMindMutex` 持有引用保证生命周期覆盖整个脚本）。

---

## 4. 第②层：daemon 本体为何「不自己退」

`index.ts` 起来后跑三个**永不返回**的循环（详见架构里的「拉取/处理解耦」）：

- **poller**：`while(true)` 里 `getUpdates` 长轮询（25s 超时，无消息就继续轮询）、更新 token、把消息入队；
- **fastWorker**：从快车道队列取控制/任务指令，和大脑子回合并发处理；
- **worker**：从消息队列串行取内容喂大脑。

`pollerLoop` 与 `fastWorkerLoop` 以 `void` 启动，`workerLoop` 由 `await` 常驻；三者并发运行，所以**正常情况下 node 进程永不自然结束**。它只会因为：

1. **未捕获异常**（曾导致静默 `code=1`，已加全局 `unhandledRejection`/`uncaughtException` 处理器记录而不退出）；
2. **被 `taskkill`**（管理命令停止、或部署时手动重启）；
3. **会话过期 `-14`**：不退出，而是 `pauseSession` 暂停 1 小时、等用户重新登录后再活；

而退出。一旦退出 → 第①层守护进程在 5 秒后重拉。

启动时 daemon 还会：写 `daemon.pid`；注册 `exit`/`SIGINT`/`SIGTERM` 清理 pid；`ensureBrainHome()` 准备大脑副本；`notifyStart()` 通知 iLink 上线。

---

## 5. 第③层：大脑（ACP 子进程）的生命周期

大脑不是随 daemon 一起起的，而是**懒启动**：第一条消息到来、worker 调用 `askBrain` 时才 `spawn` 一个 ACP agent 进程（用哪个 agent 由账号 `brain.json` / `WEMIND_BRAIN` 决定，未配置则 `auto` 探测；见 [`接入其它-ACP-Agent.md`](../接入方案/接入其它-ACP-Agent.md)），之后**常驻复用**（每用户一个 ACP session，原生多轮记忆）。

自愈：`session/prompt` 超时或失败 → 杀掉可能假死的 agent 进程 → 下一条消息重建，并用 `session/load`（不支持时 `session/resume`）按持久化的 sessionId 恢复上下文。agent 两者都不支持时只能新建会话；这不是「模型记性差」，是能力缺口。

---

## 6. 第〇层：开机自启（怎么第一次被拉起）

**现行做法（所有平台、安装版与源码版一致）：`wemind autostart install`**——默认给所有已登记账号装；`--key` / `--label` 只装一个。它按平台生成触发器，检测到 PM2 时优先用 PM2：

| 平台 | 触发器 | 触发后执行 | 谁负责重拉 |
|------|--------|------------|------------|
| Windows | 登录触发的计划任务（当前用户，不需要管理员；被受管策略拒绝时降级 `HKCU\...\Run`） | `wemind start --all`（只装部分账号时是 `start <key…>`） | 内置 `_watchdog` |
| Linux | `~/.config/systemd/user/wemind@<key>.service` | `wemind daemon`（前台常驻） | systemd（`Restart=always`） |
| macOS | `~/Library/LaunchAgents/dev.wemind.<key>.plist` | `wemind daemon`（前台常驻） | launchd（`KeepAlive`） |
| 任意（装了 PM2） | pm2 自身（`wemind-<key>` 实例） | `wemind daemon`（声明 `args: "daemon"`） | pm2 |

> **触发器绝不能执行 `wemind autostart install`**——每次登录都会重新安装一遍。Windows 触发器只执行 `start --all`（只装部分账号时是 `start <key…>`）；Linux/macOS 的 supervisor 本身负责重拉，单元里写 `wemind start` 会立刻退出并被无限重启。
>
> 装完用 `wemind autostart status` 核对（`none` / `native-only` / `pm2-only` / `mixed`）。`mixed` 表示系统触发器与 PM2 各拉了一份，会抢同一个 bot token——重新跑 `install` 会让你选择只保留一种。详见 [开机自启](开机自启.md)。

**旧方式（仅源码开发者手动配置，仍可用）**：`run-daemon.ps1` 自己不会开机自动出现，需要一个系统级触发器。默认 cli 模式下它是薄壳，动作推荐直接覆盖全部账号：

**首选：计划任务（登录触发）**

```powershell
$pwsh    = "C:\Program Files\PowerShell\7\pwsh.exe"          # 必须 PS7 全路径
$wrapper = "<仓库绝对路径>\scripts\run-daemon.ps1"
$action  = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapper`" -All"
Register-ScheduledTask -TaskName "wemind-daemon" `
  -Action $action `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn) `
  -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew) -Force
```

- `-All`：启动所有已登记账号（等价 `wemind start --all`）；只起一个账号用 `-Account <key>`，交给 CLI 默认账号则省略；
- `-AtLogOn`：登录即触发；
- `ExecutionTimeLimit = 0`：不限时长（否则计划任务默认 72 小时后杀掉常驻进程）；
- `MultipleInstances IgnoreNew`：防重复触发。cli 模式的真正单实例守卫是 builtin watchdog 的 `wrapper.pid`；`-Mode shell` 才是脚本自己的 Mutex；
- 计划任务的 `Execute` 必须用 **PS7 全路径**，不要用 `pwsh`（依赖 PATH）或 WindowsApps 执行别名（在非交互上下文常解析失败）。

**退路：启动文件夹 + `.bat`**（环境禁建计划任务时）

在 `shell:startup`（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`）放一个 `.bat`，内容为 `wemind start --all`（安装版）或 `pwsh -File "<仓库>\scripts\run-daemon.ps1" -All`（源码版）。**不要用 `.vbs`**（项目已弃用）。注意这条退路会出现在「任务管理器 → 启动」里，且与 `wemind autostart install` 的注册表退路**不要重复**。

> **为什么一定要「脱离」启动**：无论计划任务、Run 键还是 `Start-Process`，目的都是让后台守护进程（及其子孙 node/kiro-cli）**不继承启动者的 stdout 管道**。否则启动它的那个 shell 会一直等管道 EOF → 「看似卡住」。这也是本项目「shell 防挂起」规范的根因。

---

## 7. 多账号：每账号一条独立链

`run-all-daemons.ps1` 读账号注册表 `<WEMIND_HOME>/accounts.json`（默认 `~/.wemind/accounts.json`），为每个账号起一条独立的启动链（默认 cli 模式：每个 wrapper 转 `wemind start <key>`，重拉交给各账号自己的 builtin watchdog）：

```powershell
foreach ($key in $accounts) {
  Start-Process -FilePath $pwsh `
    -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$wrapper) `
    -WindowStyle Hidden -Environment @{ WECHAT_ACCOUNT = $key }   # 显式传账号
}
```

- 每账号不同 `WECHAT_ACCOUNT` → 不同数据目录 + 不同单实例守卫（cli：builtin watchdog 的 `wrapper.pid`；shell：命名 Mutex）+ 不同日志 → **完全独立、可共存、互不抢 token**。
- 多账号必须用 `Start-Process -Environment` **显式传** `WECHAT_ACCOUNT`，靠 `$env:` 继承不可靠（坑⑯相关）。
- 重复运行安全：已在跑的账号会被该账号的单实例守卫挡掉（cli：builtin watchdog；shell：Mutex）。

---

## 8. 生命周期与管理命令

`wemind`（源码在 `packages/wechat-daemon`）按 pid 文件链精确操作：

| 命令                                         | 做什么                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `start <key\|label> [--runner builtin\|pm2]` | 起该账号的后台守护进程（默认 builtin detached `_watchdog`；`pm2` 则生成 `pm2.app.json` 交给 pm2，重拉/78 语义与 builtin 一致） |
| `list`                                       | 列出各账号状态（读 daemon/brain pid，并**核对命令行身份**后判断「运行中」）                                                    |
| `logout <key>`                               | 停整条链（后台守护进程→daemon→brain/worker）+ iLink 下线 + 清凭证，**保留目录**                                                |
| `delete <key>`                               | 停整条链 + 删数据目录 + 注销注册表；**停完仍发现 daemon 活着就不删目录**（避免删掉它正在用的文件），提示先 `stop`              |

停止由 `stopDaemon()` 一次完成（不再需要手工分步）：先 `pm2Stop` 兜底，再读 `wrapper/daemon/brain/worker` 四个 pid 文件、**逐个核验命令行身份**，通过校验的进程一次性交给 `killProcessTrees()`——Windows 用 `taskkill /T /F` 连带子树；POSIX 先收集后代再 SIGTERM→SIGKILL。最后清掉全部 pid 文件。

---

## 9. 故障模式与恢复一览

| 现象                               | 机制层         | 表现 / 恢复                                                                      |
| ---------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| daemon 崩溃（含旧的静默 `code=1`） | ① 后台守护进程 | 日志 `daemon exited (code=...)` → 5s 后重拉；已加全局异常处理器从源头减少崩溃    |
| 大脑（agent）假死/超时             | ③ acp-brain    | 杀进程 → 下条消息重建 + `session/load`/`resume` 恢复上下文                       |
| 网络抖动 `getUpdates fetch failed` | ② poller       | try/catch + 2s 后重试，不崩                                                      |
| 登录会话过期 `-14`                 | ② daemon       | 暂停 1 小时，等重新登录后自动恢复                                                |
| 重复启动 / 多实例                  | ① 单实例守卫   | builtin watchdog 的 `wrapper.pid` 守卫 / shell 模式的命名 Mutex 让重复实例直接退出 |
| 开机没起来                         | 〇 触发器      | 检查计划任务是否存在/启用、PS7 路径、`ExecutionTimeLimit=0`                      |
| 开机没起来（陈旧 pid 被复用）      | 〇/① pid 文件  | pid 存活还须**身份校验**确属本程序，否则后台守护进程会误判「已有实例」而静默退出 |

---

## 10. 一句话总结

> **开机触发器负责「开机拉起一次」并脱离 shell**——Windows 用计划任务（首选）或 `HKCU\...\Run`（禁建任务时的退路）、Linux 用 systemd、macOS 用 launchd；**同一台机器只选一个**。后台守护进程（builtin `_watchdog`，`run-daemon.ps1` 默认薄壳最终也走它 / pm2 / `run-daemon.ps1 -Mode shell`）的循环负责「崩了再拉」；node 的三个 `while(true)`（poller + fastWorker + worker）负责「自己不退」；单实例守卫（wrapper.pid 身份校验 / Mutex / pm2 app 名）负责「不重复」；pid 文件链负责「能精确停」。五者叠起来 = 稳定的后台常驻。**

> **日志格式（2026-11-11 起）**：运行日志统一由 `core/logging.ts` 的 `createLogger(scope)` 输出，格式为 `[wemind/<scope>][INFO|WARN|ERROR|DEBUG] …`，全部写 stderr（MCP 的 stdout 仍是 JSON-RPC 通道）；CLI 用户输出走 stdout 的 `print()`，不加前缀、不加级别。本文正文中的日志样例可能省略了级别标记，实际每行都有。`wemind log --errors` 精确认 `[ERROR]/[WARN]` 标记，升级前写入的旧日志仍按关键词兼容。`WEMIND_LOG_LEVEL=debug` 才输出 DEBUG（目前没有 debug 调用点，属预留级别）。
