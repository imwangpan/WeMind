# Daemon 后台常驻原理（详解）

本文详细说明 WeMind 守护进程（daemon）如何做到「开机自启 + 一直在后台收发微信 + 崩了自动恢复」。常驻不是单一机制，而是**三层进程 + 一个看门狗循环 + 一套保活/隔离细节**的组合。

> 相关文件：
> - `scripts/run-daemon.ps1` —— wrapper 看门狗脚本（常驻核心）
> - `scripts/run-all-daemons.ps1` —— 多账号批量启动
> - `packages/wechat-daemon/src/index.ts` —— daemon 本体（poller/worker 循环）
> - `packages/wechat-daemon/src/acp-brain.ts` —— 大脑 ACP 子进程
> - `packages/wechat-daemon/src/manage.ts` —— 管理命令（start/stop/logout/delete）

---

## 1. 整体进程树

```
Windows 计划任务（登录触发）  或  启动文件夹里的 .vbs
        │  （只负责「拉起一次」，并让进程脱离启动它的 shell）
        ▼
   pwsh  run-daemon.ps1                 ← ① wrapper（看门狗，常驻）
        │  while($true){ 跑 node; node 退出后睡 5s 再跑 }
        ▼
   node  packages/wechat-daemon/dist/cli.js daemon   ← ② daemon 本体（业务，常驻）
        │  poller + worker 两个 while(true) 循环，永不自然退出
        ▼
   kiro-cli acp（或其它 ACP agent）       ← ③ 大脑（ACP 子进程，懒启动、可自愈重建）
```

三层进程各写一个 PID 文件到账号数据目录 `~/.wemind/<key>/`：

| 文件 | 属于 | 写入者 | 用途 |
|------|------|--------|------|
| `wrapper.pid` | ① wrapper | `run-daemon.ps1` | 管理命令据此停掉看门狗（否则停了 daemon 会被立刻重拉） |
| `daemon.pid` | ② daemon | `index.ts` 启动时 | 精确定位本账号 node 进程 |
| `brain.pid` | ③ 大脑 | `acp-brain.ts` spawn 后 | 区分「bot 的大脑」与用户自己日常用的 agent，便于清理 |

> **身份校验（防 pid 复用）**：pid 会被系统复用（尤其**重启后**）——只凭「pid 还活着」就杀进程或判定「运行中」，可能**误杀别人的进程**、或反而看不出「其实没起来」。所以所有基于 pid 文件的判断/停止都会先**核对该 pid 的命令行是否确属本程序**（`proc-identity.ts`）：daemon/wrapper 需含 `wechat-daemon/dist/cli.js` 或 `run-daemon.ps1`；大脑需含其启动命令（如 `opencode acp`，据此与用户自己的 `opencode serve` 区分）。查不到命令行时**一律判否、不杀**。

> 停止顺序必须自上而下：**先停 wrapper（断掉看门狗），再停 daemon，最后清大脑**——否则先杀 daemon 只会被 wrapper 在 5 秒后重新拉起。

---

## 2. 第①层：wrapper 看门狗（常驻的核心）

`run-daemon.ps1` 的本质是一个**永不结束的监督循环（supervisor / watchdog）**：

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

这就是「daemon 崩了会自动恢复」的来源。**职责分离**：node 只管业务逻辑，保活完全交给外层 wrapper。daemon 进程内部不做自重启。

> 关于「防挂起」规范的澄清：wrapper 里**故意**用前台阻塞 `& node` + `Start-Sleep`——它的职责就是守着 node。这不违反项目的「shell 防挂起」约定，因为那条约定约束的是「临时在交互 shell 里跑的命令」，而 wrapper 本身是被计划任务/VBS 以脱离方式启动的长期监督进程。

启动时 wrapper 还做几件准备：

- **设 UTF-8 编码**（`[Console]::OutputEncoding` / `$OutputEncoding`）：否则 node/kiro-cli 的中文输出按系统 GBK 代码页解码会乱码（早期踩过）。
- **定位仓库**：用 `$PSScriptRoot` 反推仓库根（脚本在 `<repo>/scripts/`），可移植，不写死路径。
- **解析数据目录**：`WECHAT_ACCOUNT` → `~/.wemind/<account>/`，或 `WECHAT_DATA_DIR` 直接指定；日志写各自目录的 `daemon.log`。
- **解析 node / kiro-cli**：走 PATH；kiro-cli 找不到时兜底到 `%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe`。

---

## 3. 单实例守卫（命名 Mutex）

如果计划任务、手动启动、多次登录叠加，可能同时跑起多个 wrapper 循环 → 多个 daemon 抢同一个 token、互相打架（早期的坑①）。为此 wrapper 启动时用**命名 Mutex** 做单实例守卫：

```powershell
$dataKey  = WECHAT_DATA_DIR 或 "account:<WECHAT_ACCOUNT>" 或 "account:default"
$sha      = SHA1(dataKey.toLower())
$mutexName= "wemind-daemon-" + sha 前 16 位 hex
$mutex    = New-Object Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) { 记日志「已有实例在跑」; exit 0 }   # 抢不到锁 → 直接退出
```

- 抢到锁才继续；抢不到说明同账号已有 wrapper 在跑，本次直接退出。
- Mutex 名按**数据目录**派生 → **不同账号 = 不同 mutex** → 多账号各自独立、可共存，互不阻塞。
- 进程退出时操作系统自动释放 Mutex（`$global:WeMindMutex` 持有引用保证生命周期覆盖整个 wrapper）。

---

## 4. 第②层：daemon 本体为何「不自己退」

`index.ts` 起来后跑两个**永不返回**的循环（详见架构里的「拉取/处理解耦」）：

- **poller**：`while(true)` 里 `getUpdates` 长轮询（25s 超时，无消息就继续轮询）、更新 token、把消息入队；
- **worker**：`while(true)` 串行从队列取消息喂大脑。

两个循环用 `Promise.all` 并发常驻，所以**正常情况下 node 进程永不自然结束**。它只会因为：

1. **未捕获异常**（曾导致静默 `code=1`，已加全局 `unhandledRejection`/`uncaughtException` 处理器记录而不退出）；
2. **被 `taskkill`**（管理命令停止、或部署时手动重启）；
3. **会话过期 `-14`**：不退出，而是 `pauseSession` 暂停 1 小时、等用户重新登录后再活；

而退出。一旦退出 → 第①层 wrapper 在 5 秒后重拉。

启动时 daemon 还会：写 `daemon.pid`；注册 `exit`/`SIGINT`/`SIGTERM` 清理 pid；`ensureBrainHome()` 准备大脑沙箱；`notifyStart()` 通知 iLink 上线。

---

## 5. 第③层：大脑（ACP 子进程）的生命周期

大脑不是随 daemon 一起起的，而是**懒启动**：第一条消息到来、worker 调用 `askBrain` 时才 `spawn` 一个 ACP agent 进程（用哪个 agent 由账号 `brain.json` / `WEMIND_BRAIN` 决定，未配置则 `auto` 探测；见 [`接入其它-ACP-Agent.md`](接入其它-ACP-Agent.md)），之后**常驻复用**（每用户一个 ACP session，原生多轮记忆）。

自愈：`session/prompt` 超时或失败 → 杀掉可能假死的 agent 进程 → 下一条消息重建，并用 `session/load` 按持久化的 sessionId 恢复上下文。所以大脑这层也有自己的「崩了重建」，且不丢对话历史。

---

## 6. 第〇层：开机自启（怎么第一次被拉起）

wrapper 自己不会开机自动出现，需要一个系统级触发器：

**首选：计划任务（登录触发）**

```powershell
$pwsh    = "C:\Program Files\PowerShell\7\pwsh.exe"          # 必须 PS7 全路径
$wrapper = "<仓库绝对路径>\scripts\run-daemon.ps1"
$action  = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapper`""
Register-ScheduledTask -TaskName "wemind-daemon" `
  -Action $action `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn) `
  -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew) -Force
```

- `-AtLogOn`：登录即触发；
- `ExecutionTimeLimit = 0`：不限时长（否则计划任务会在若干小时后杀掉常驻进程）；
- `MultipleInstances IgnoreNew`：配合 wrapper 的 Mutex 双保险，防重复实例；
- 计划任务的 `Execute` 必须用 **PS7 全路径**，不要用 `pwsh`（依赖 PATH）或 WindowsApps 执行别名（在非交互上下文常解析失败）。

**退路：启动文件夹 + VBS**（环境禁建计划任务时）

在 `shell:startup`（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`）放一个 `.vbs`，用 `WScript.Shell.Run` 以隐藏窗口调 `pwsh ... -File scripts/run-daemon.ps1`。VBS 的 `Run` 能彻底脱离，不残留控制台窗口。

> **为什么一定要「脱离」启动**：无论计划任务、VBS 还是 `Start-Process`，目的都是让 wrapper（及其子孙 node/kiro-cli）**不继承启动者的 stdout 管道**。否则启动它的那个 shell 会一直等管道 EOF → 「看似卡住」。这也是本项目「shell 防挂起」规范的根因。

---

## 7. 多账号：每账号一条独立链

`run-all-daemons.ps1` 读账号注册表 `~/.wemind/accounts.json`，为每个账号起一条独立的 wrapper 链：

```powershell
foreach ($key in $accounts) {
  Start-Process -FilePath $pwsh `
    -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$wrapper) `
    -WindowStyle Hidden -Environment @{ WECHAT_ACCOUNT = $key }   # 显式传账号
}
```

- 每账号不同 `WECHAT_ACCOUNT` → 不同数据目录 + 不同 Mutex + 不同日志 → **完全独立、可共存、互不抢 token**。
- 多账号必须用 `Start-Process -Environment` **显式传** `WECHAT_ACCOUNT`，靠 `$env:` 继承不可靠（坑⑯相关）。
- 重复运行安全：已在跑的账号会被该账号 wrapper 的 Mutex 守卫挡掉。

---

## 8. 生命周期与管理命令

`wemind`（`packages/wechat-daemon`）按 pid 文件链精确操作：

| 命令 | 做什么 |
|------|--------|
| `start <key\|label>` | 起该账号的 wrapper（经 `Start-Process` 脱离） |
| `list` | 列出各账号状态（读 wrapper/daemon/brain pid，并**核对命令行身份**后判断「运行中」） |
| `logout <key>` | 停整条链（wrapper→daemon→brain）+ iLink 下线 + 清凭证，**保留目录** |
| `delete <key>` | 停整条链 + 删数据目录 + 注销注册表 |

停止链时**先杀 wrapper.pid**（断看门狗），再 `taskkill /T` daemon（连带大脑进程树），最后清 brain.pid——顺序错了 daemon 会被 wrapper 立刻重拉。

---

## 9. 故障模式与恢复一览

| 现象 | 机制层 | 表现 / 恢复 |
|------|--------|------------|
| daemon 崩溃（含旧的静默 `code=1`） | ① wrapper | 日志 `daemon exited (code=...)` → 5s 后重拉；已加全局异常处理器从源头减少崩溃 |
| 大脑（agent）假死/超时 | ③ acp-brain | 杀进程 → 下条消息重建 + `session/load` 恢复上下文 |
| 网络抖动 `getUpdates fetch failed` | ② poller | try/catch + 2s 后重试，不崩 |
| 登录会话过期 `-14` | ② daemon | 暂停 1 小时，等重新登录后自动恢复 |
| 重复启动 / 多实例 | ① Mutex | 抢不到锁的 wrapper 直接退出 |
| 开机没起来 | 〇 触发器 | 检查计划任务是否存在/启用、PS7 路径、`ExecutionTimeLimit=0` |
| 开机没起来（陈旧 pid 被复用） | 〇/① pid 文件 | pid 存活还须**身份校验**确属本程序，否则看门狗会误判「已有实例」而静默退出 |

---

## 10. 一句话总结

> **计划任务/VBS 负责「开机拉起一次」并脱离 shell；wrapper 的 `while` 循环负责「崩了再拉」（看门狗）；node 的两个 `while(true)` 负责「自己不退」；Mutex 负责「不重复」；pid 文件链负责「能精确停」。五者叠起来 = 稳定的后台常驻。**
