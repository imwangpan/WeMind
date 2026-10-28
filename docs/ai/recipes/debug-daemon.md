# 配方：排查 daemon 不回复 / 大脑异常

> **适用版本**：WeMind 1.2.0 ｜ **最后核对**：2026-10-28
>
> 先跑 [`scripts/doctor.ps1`](../../../scripts/doctor.ps1) 收集环境事实，再按症状定位。不要一上来改代码。

---

## 0. 30 秒分诊

| 症状 | 先看 | 大概率原因 |
|---|---|---|
| `wemind start` 立刻退出 / 日志 `FATAL 大脑不可用`（exit 78） | `wemind brain` | 预设未知、二进制不在 PATH、`binWin` 写错（如只有 `dsh.cmd`） |
| daemon 在跑，但微信完全没反应 | `daemon.log` 有无 `turn start` / `prompt ok` | 没登录、allowFrom 不含你、bot token 被另一个消费者抢走 |
| 反复「⏳ 响应中断了，正在自动重试…」 | `daemon.log` 的 `[wemind/wechat-daemon/acp]` | agent 启动失败、`initialize` 超时、参数不对、`.cmd` 没经 shell |
| 回复突然停 / 「接近微信连续消息上限」 | 进度条数 | iLink 连发上限 ~10；回「继续」恢复 |
| 重启后「它忘了」 | `session/load failed` / `session/resume` | agent 不支持 load，或 resume 参数/cwd 不对 |
| 发图报错/重试 | `prompt FAIL` + `-32602` | agent `image:false`（如 DSH 官方） |
| 桌面已登录但报 `no API key for ... deepseek-official` | 预设的 model / 路由 | DSH 默认路由要 API key；桌面登录对应 `deepseek-account`，需 `set_config_option` 切换 |
| 多账号互相抢消息 | `list` / 进程 | 同一 bot token 起了多个 daemon，或 brain 加载了 `wechat` MCP |
| worker 任务不动 | `wemind task-list` | worker 超时/权限/agent 不支持；看 `.../worker` 日志 |
| 切换大脑失败 / 回滚 | 回执 + `wemind brain` | 目标预设不可用、预热超时（120s）、drain 超时（30s）、`WEMIND_BRAIN` 压着命令 |
| 微信里发命令被短拒 | 回执文案 | owner-only 命令（切脑/交接）由非本人发出 |
| CLI 命令被拒 / 显示「daemon 未运行」 | `wemind list` | 真没跑；**或**升级 CLI 后没重启 daemon（`.bridge` 凭据对不上）；**或**手跑 daemon 时路径特征不匹配 |
| 任务数超上限被拒 | 回执 | `WEMIND_MAX_WORKERS`（默认 3）到了；先 `结束任务 <编号>` 或调大 |
| `wemind start` 说「已启动」但 `list` 显示未运行、日志不更新 | 进程表里的 `cli.js _watchdog` 有没有子进程 | 从 **VS Code 集成终端**启动时被调试引导卡死（见 §3.12）；换普通终端，或升级到带 `stripVscodeDebugEnv` 的版本 |
| 池里进程不回收 / 内存高 | `wemind list` | 空闲回收默认 5 分钟（`WEMIND_WORKER_REAP_MS`）；上限 `WEMIND_IDLE_MAX`（默认 2） |
| 「恢复会话」失败且当前会话没变 | 回执 | **预期行为**（strict）：agent 侧没有那条会话，或在途 load 超时；不会静默新建 |
| 重启后任务显示「已中断」 | `wemind task-list` / 日志 `restored tasks:` | **预期行为**：不自动拉起，回「继续」才续跑 |

---

## 1. 事实收集

```powershell
# 环境 / 账号 / 大脑 / agent 二进制
pwsh -NoProfile -File scripts/doctor.ps1

# 下面统一写 `wemind`（已发布：npm i -g @wemind/cli）。
# 从源码排查时等价于 `node packages/wechat-daemon/dist/cli.js <子命令>`。

# 版本（先确认用户/自己用的是哪一版）
wemind version

# 账号与状态
wemind list

# 大脑解析（某账号）
wemind brain <key|label>

# 真机 ACP 握手（initialize + session/new）
wemind brain check <key|label>

# 任务表 / 进程池（daemon 在跑时代理到进程内；不在也能读盘）
wemind task-list <key|label>

# 会话登记表（同上；`--page N` 翻页）
wemind session list <key|label>

# 最近一次切换的结论（含回滚原因）在 daemon.log 里：`brain switch:` / `control(cli): brain.switch`
```

> `brain check` 默认 60s（`brain-check.ts`）；冷启动慢的 agent 仍可能超时。先看它打印的 stderr，再判定「不可用」。
>
> 排查**当前进程内在用**的大脑别只信 `brain.json`：热切换后进程内槽位与磁盘一致，但 `WEMIND_BRAIN` 环境变量会压过磁盘——`wemind brain` 会打印 source，`wemind session list` 在 daemon 运行时也按进程内大脑列。

---

## 2. 看日志

默认数据目录：`~/.wemind/<key>/`

| 文件 | 用途 |
|---|---|
| `daemon.log` | daemon / acp / worker / task / watchdog / switch 日志 |
| `brain.json` | 账号级大脑选择（`agent` + `worker.agent` + `presets` 各自启动覆盖） |
| `brain-sessions.json` | `<agent>:userId → sessionId`（按大脑分命名空间）；**「当前是哪个会话」的唯一权威** |
| `session-registry.json` | 会话登记表（名字/标题/轮次；**派生**元数据，坏了只影响列表） |
| `tasks.json` | 任务表（编号/agent/状态；重启后未完成的标「已中断」） |
| `task-state.json` | 任务状态快照（顶层字段镜像最近一条，供旧 CLI 读） |
| `handoff.json` | 交接摘要（切脑后注入一次；24h TTL） |
| `control-inbox/` / `control-out/` | CLI ↔ daemon 控制桥；`control-out/.bridge` = daemon 自己的 pid（认桥凭据） |
| `brain-mcps.json` | 当前激活的 MCP |
| `brain-home/` | brain 沙箱（agent 配置/会话） |
| `worker-home/` | worker 沙箱 |
| `daemon.pid` | daemon 进程 |
| `brain.pid` | 大脑进程**身份记录**（JSON：pid/agent/bin/args/shell） |
| `workers.pid.json` | **worker 池**身份记录（JSON 数组：pid/agent/state: busy\|idle/taskId） |

关键日志：

```text
[wemind/wechat-daemon] turn start to=... msgAge=...
[wemind/wechat-daemon/acp] spawn <agent> acp pid=... bin=... args=[...]
[wemind/wechat-daemon/acp] initialized
[wemind/wechat-daemon/acp] session/new ok ...  |  session/load ok ...  |  session/load failed (...), creating new
[wemind/wechat-daemon/acp] → session/prompt#...
[wemind/wechat-daemon/acp] prompt ok ... chunks=N updateTypes=[...]
[wemind/wechat-daemon/acp] turn waits for in-flight brain switch…      # 回合在等切换（不是卡死）
[wemind/wechat-daemon] brain switch: ✅ 已切换对话大脑 … | 切换失败，已回滚到「…」
[wemind/wechat-daemon] control(cli): session.new {"target":…}          # CLI 经控制桥发来的请求
[wemind/wechat-daemon] control: <kind> … -> …                          # 处理结果（微信侧命令同款日志）
[wemind/wechat-daemon] control: denied(not owner) …                    # owner-only 命令被非本人触发
[wemind/wechat-daemon] control: 非法请求（未知 kind / 坏 JSON），已丢弃: …
[wemind/wechat-daemon] task: dispatch(agent=…) / task: inject(#n) / task: stop -> …
[wemind/wechat-daemon/worker] <connId>(<agent>) initialized / session/load ok / exited code=…
[wemind/wechat-daemon] handoff injected from=… to=… chars=… / handoff consumed by …
[wemind/wechat-daemon] restored tasks: interrupted=[3,5]（回「继续」可续跑）
[wemind/wechat-daemon] session registry backfilled: N 条（来自会话指针表）
[wemind/wechat-daemon] replied to ...
```

---

## 3. 常见修法

### 3.1 大脑不可用（exit 78）

```powershell
wemind brain                 # 看 requested / source / 生效 bin
wemind brain set kiro        # 或 opencode / 其它已装预设
wemind brain check
```

- 预设未知 → `brain set` 会列出可选值；
- 二进制找不到 → 安装，或 `brain set <预设> --bin <绝对路径>`；
- Windows 只有 `.cmd` → 预设 `binWin` 必须是实际文件名（`dsh.cmd`）；`onPath()` 不会自动补 `.cmd`；
- 自定义 agent → `WEMIND_BRAIN_BIN` / `WEMIND_BRAIN_ARGS` / `WEMIND_BRAIN_HOME_ENV`。

### 3.2 daemon 在跑但不回复

1. `wemind list` 确认账号 `运行中`；
2. 确认你已在 `allowFrom`：`wemind allowlist <key>` / `wemind allow <key> <userId>`；
3. 看 `daemon.log` 有没有 `turn start`：
   - 没有 → 消息没被拉取（登录/token/多消费者）；
   - 有但没有 `prompt ok` → ACP 层问题，转 3.3；
4. 确认没有第二个 MCP/daemon 用同一 token（回环/抢消息）。

### 3.3 ACP 启动/握手失败

```powershell
# 手动起一次，确认它能说 ACP
wemind brain check

# 或直接看 spawn 参数
wemind brain
```

- `spawn` 后立刻 `acp exited` → 二进制/参数/`shell` 不对；
- 卡在 `initialize` → 不是 ACP，或参数没进入 ACP server 模式；
- Windows `.cmd`/`npx` → `shell: true`（预设或 `WEMIND_BRAIN_SHELL=1`）；
- 路径含空格/`&` → 用绝对路径 + `shell`，并确认 `spawnAgent` 的引号逻辑；
- 反向请求无应答 → 现在会静默丢弃；接入新 agent 时先做应答器（见 `docs/ai/recipes/add-acp-agent.md`）。

### 3.4 重启后上下文丢失

```powershell
# 看日志有没有：
#   session/load failed (...), creating new
#   session/load ok | session/resume ok
```

- agent 不支持 `session/load` → 需要 `session/resume` 兜底；DSH 属此类；
- `resume` 失败 → 检查 `cwd`、`mcpServers`、会话是否已持久化；
- 想彻底重来 → 微信「新会话」，或删 `brain-sessions.json` + `brain-home/sessions/`。

### 3.5 连发上限 / 进度刷屏

- 现象：一串「还在思考」「仍在处理」，然后「接近上限，我先暂停进度」；
- 原因：无 `session/update` 帧时，`index.ts` 每 15s 发一条进度；
- 处置：让用户回「继续」恢复；接入 committed-only agent 时调 `heartbeatMs` / 降低进度频率。

### 3.6 图片失败

```text
prompt FAIL ... -32602 Invalid params: inline image prompts were not advertised
```

- agent `initialize.promptCapabilities.image=false`；
- DSH 官方 0.2.1-rc.2 属此类；换支持图片的 agent，或在 `askBrain` 前拦截并友好提示。

### 3.7 桌面登录了但报 no API key（DSH）

```text
-32603 Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"
```

- `session/new` 默认模型是 `deepseek-official/*`，需要 `DEEPSEEK_API_KEY`；
- 桌面端登录态是 `deepseek-account/*`，必须在 `session/new` 后用 `session/set_config_option` 切换：
  `{ sessionId, configId: "model", value: "[\"deepseek-account\",\"deepseek-flash\"]" }`；
- 预设层应加 `model` 字段；`resume` 会保留上次选择，但配置变更后要重设；
- 如果坚持 official 路由，就配 `DEEPSEEK_API_KEY`（daemon 环境）。

### 3.8 切换大脑失败 / 回滚（1.2.0）

先分清**两段回执**：预检失败只有一条（没动任何东西），预热失败才有「已回滚到「旧大脑」」。

```powershell
wemind brain <key|label>                  # requested / source / 生效 bin
Select-String -Path "$env:USERPROFILE\.wemind\<key>\daemon.log" -Pattern "brain switch:|control\(cli\): brain.switch"
```

| 回执/日志 | 原因 | 处置 |
|---|---|---|
| `未知预设` / `不可用：…` | 预检拒绝，**没 spawn** | `wemind brain` 看预设名；`wemind brain check <预设>` 单独验 |
| `当前有回合正在进行（等了 30 秒…）` | drain 超时 | 稍后重发；长回合可调大 `WEMIND_SWITCH_DRAIN_MS` |
| `预热超时（120s …）` | 目标 agent 起不来/太慢 | 查它单独能否 ACP（`scripts/acp-probe.mjs`）；调 `WEMIND_SWITCH_TIMEOUT_MS` |
| `切换失败，已回滚到「X」：<原因>` | 握手/会话阶段失败 | 槽位仍是旧大脑，`brain.json` **未被改写**；下一条消息懒重建旧大脑（日志会再 `spawn`）——这是预期，不是"没起来" |
| `⚠️ 环境变量 WEMIND_BRAIN=… 仍在生效` | 一次性 env 压着命令 | 从进程环境里去掉；否则重启后会回到 env 指的大脑 |
| `正在切到「X」，等它完成后再试。` | 并发切换（不同目标） | 等前一次结束；同目标重复请求会复用同一次切换 |

排「预热期间是不是起了两个进程」：数 `spawn` 行——一次切换**只应有一行**。

### 3.9 CLI 命令被拒 / 显示 daemon 未运行（1.2.0）

`wemind list` 说「运行中」却仍拒绝，按这个顺序看：

1. **daemon 是升级前启动的旧版本**：**必须由它执行的**写命令（`session new`/`resume`、`brain switch|worker|handoff`）在**发出前**就拒绝，并给 `wemind stop <key> && wemind start <key>`；本来就是文件操作的 `session rename`/`delete` 照常直接改登记表（**不会**加说明行），`session list` 直接读登记表并附一行「按下次会用的那个大脑列」，`task-list`/`task-status` 从来不经过桥（读 `tasks.json`，只在 daemon 没跑时注明「上次快照」）。**按提示重启一次**即可——这不是故障。
2. **`.bridge` 凭据对不上**：`control-out/.bridge` 里应是 daemon 自己的 pid，且等于 `daemon.pid`。手动改过/删过 `control-out/` 都会让它失配。
3. **daemon 是手跑的老 dist**：`wemind list` 靠命令行特征认进程（`proc-identity.ts`）。用**相对路径**起 daemon（`node packages/wechat-daemon/dist/cli.js daemon`）在旧 dist 里会被判成「不是我们的进程」→ 显示「未运行」且桥拒绝。修法：`npm run build` 后重启（1.2.0 已补相对路径的特征，见 `AGENTS.md` §6）。
4. **真没跑**：`wemind start <key>`；纯读命令（`session list`、`task-list`）不需要 daemon。

现场证据：`control-inbox/` 若堆着请求文件 = daemon 没在扫（没跑/不认桥）；排空后 `control-out/<id>.json` 会给出 `ok` 与 `text`。

### 3.10 任务侧症状（多任务 / 进程池，1.2.0）

| 症状 | 看 | 说明 |
|---|---|---|
| 派不出去 | 回执 | 超出 `WEMIND_MAX_WORKERS`（默认 3）会被**派发时**拒绝；无编号消息在**多条任务**并存时回消歧清单（`#编号` 指定） |
| 任务「跑」但一直没结果 | `.../worker` 日志 | 找 `exited code=` / `prompt FAIL`；worker 单轮硬上限 30min（`WEMIND_WORKER_CAP_MS`）、无帧 3min（`WEMIND_WORKER_IDLE_MS`） |
| 任务列表为空但进程还在 | `workers.pid.json` | 进程**回池**是预期：任务结束不杀进程，空闲 5min（`WEMIND_WORKER_REAP_MS`）或超出 `WEMIND_IDLE_MAX`（默认 2）才回收 |
| 池占资源多 | `wemind list` | 调小 `WEMIND_MAX_WORKERS` / `WEMIND_IDLE_MAX`；`wemind stop <key>` 一次杀光整池 |
| 重启后状态「已中断」 | 日志 `restored tasks: interrupted=[…]` | **预期**：不自动拉起，回「继续」/`#n 继续` 才续跑 |
| 续跑接不上 | 回执 | agent 不支持 load/resume 或会话已被它自己清理 → 会给「请用文字重述」，**不**改指针、不假装成功 |
| 同 agent 并发时行为怪 | 池信息 | 同一 agent 的两个 worker **共用它的配置目录**（等价"两个终端在同一个目录里跑"）——已知形态；不同 agent 各自子目录天然隔离 |
| CLI 说「没等到 daemon 回执」 | `task-out/` | 命令照常执行（这一行只是回执丢了）：**老版 daemon 不认回执腿**（重启一次即可），或 daemon 正在退出。查实际状态用 `task-list`/`task-status`——别把这一行当「没派上」 |
| CLI 说「已投递」而不是「已派发」 | `task-out/`、`tasks.json` | 同上（等不到回执）：`task-out/` 里没有 `<命令 id>.json` 说明 daemon 没写回执；任务本身在 `tasks.json` 里能看到就是跑起来了。派发的回执**要等起进程**（冷启动可能几十秒），CLI 最多等 30s |

### 3.11 「恢复会话」失败（strict，1.2.0）

`恢复会话 <序号>` 走的是 **load → resume，都失败就如实报错**，**不回退新建、不改当前指针**。所以：

- 回执说失败、而当前会话没变 → **这就是设计**，不是半成功；
- 常见原因：该 agent 不支持 `session/load`（走 `resume`）、会话已被 agent 自己清理、load 超时（冷启动慢）；
- 列表里**看不到**那条会话 → 是登记表（`session-registry.json`）缺项，不是会话不存在：重启 daemon 会按指针表回填（日志 `session registry backfilled:`），或直接看 `brain-sessions.json`。

### 3.12 `start` 回执「已启动」但 daemon 没起来（VS Code 终端注入，2026-10-29 修）

症状：`wemind start` 打印「已启动自带看门狗…已启动 daemon」，但 `wemind list` 显示未运行；`daemon.log`、`wrapper.pid`、账号目录的 mtime 全都不更新；进程表里只有一个 `node …cli.js _watchdog`，**没有子进程**。

原因：VS Code 集成终端的「智能自动附加」给终端里每个 node 进程注入 `NODE_OPTIONS=--require …/ms-vscode.js-debug/bootloader.js` 和 `VSCODE_INSPECTOR_OPTIONS`（`deferredMode:true` 等）——被注入的进程**要等调试器接上才执行主脚本**。终端里的前台命令（`stop`/`list`/`start` 本体）会被接上，所以输出都正常；但 `start` **脱离出去的看门狗不会被接**，于是卡在「等调试器」里，既不写 `wrapper.pid` 也不拉 daemon。

处置：1.2.0 起 `watchdog-runner.ts` 的两次脱离式 spawn（看门狗、看门狗拉 daemon）都先过 `debug-env.ts` 的 `stripVscodeDebugEnv()`，已修。旧版本撞上时：换一个**非 VS Code 集成终端**（Windows Terminal / 普通 PowerShell）执行 `wemind start <key>`，或先清变量再跑：

```powershell
Remove-Item Env:VSCODE_INSPECTOR_OPTIONS -ErrorAction SilentlyContinue
$env:NODE_OPTIONS = $null
wemind start <key>
```

识别要点：卡死的看门狗只占一个 `cli.js _watchdog` 进程、无子进程；正常时它在 5 秒内就会写出 `wrapper.pid` 并拉出 `cli.js daemon`。

---

## 4. 不要做的事

- 不要为了「让它回」而关掉 `allowFrom`；
- 不要让 brain 加载 `wechat` MCP；
- 不要在同一 token 上同时跑 MCP 形态与 daemon；
- 不要把 `WEMIND_BRAIN*` 写进系统 profile 当默认（用 `brain.json`）；
- 不要在文档里把「未实测」写成「已支持」；
- **不要手改 `control-inbox/` 里的请求去"加参数"**：桥只认预设名与纯数据，没有 `bin`/`args`/`shell` 字段——这是刻意的安全边界，不是缺功能；
- **不要为了切脑去删 `brain-sessions.json`**：删了是丢上下文，不是换大脑；换大脑用 `切换大脑` / `wemind brain switch`；
- **不要把 `session-registry.json` 当权威**：它只是派生元数据；「当前是哪个会话」只认 `brain-sessions.json`。

---

## 5. 参考

- [`docs/repowiki/05-守护进程-Daemon.md`](../../repowiki/05-守护进程-Daemon.md)
- [`docs/repowiki/06-ACP-大脑与沙箱.md`](../../repowiki/06-ACP-大脑与沙箱.md)（槽位 / 热切换 / 会话管理 / 进程身份）
- [`docs/repowiki/07-远程任务-Worker.md`](../../repowiki/07-远程任务-Worker.md)（进程池 / 任务表）
- [`docs/repowiki/10-部署与运维.md`](../../repowiki/10-部署与运维.md)
- [`docs/本地双入口-命令派发与看敲.md`](../../本地双入口-命令派发与看敲.md)（控制桥协议）
- [`docs/ai/recipes/run-e2e.md`](run-e2e.md)（验收与待实测清单）
- [`docs/daemon-常驻原理.md`](../../daemon-常驻原理.md)
