# 配方：端到端验收

> **适用版本**：WeMind 1.2.0 ｜ **最后核对**：2026-10-30
>
> 目标：用最短路径证明「微信 → daemon → ACP 大脑 → 微信」真的通，而不是只看编译通过。
> 前置：已构建、已登录一个 bot、`allowFrom` 包含你的微信（登录时自动写入，通常无需手动加）、至少一个 ACP agent 可用。

---

## 0. 分层验收（从便宜到贵）

| 层 | 命令 | 证明什么 |
|---|---|---|
| L1 编译/单测 | `npm run build && npm run typecheck && npm test` | 代码不崩 |
| L2 大脑可用 | `node .../cli.js brain check <key>` | 二进制存在 + 能说 ACP（initialize/session-new） |
| L3 ACP 冒烟 | `node scripts/acp-probe.mjs`（env 指定 agent） | prompt / update / load|resume / 反向请求 |
| L4 微信单轮 | 发一条消息，看 `prompt ok` + 收到回复 | iLink + daemon + brain 全链路 |
| L5 多轮/自愈 | 杀 daemon → 再起 → 追问上一轮 | session 恢复 |
| L6 任务/图片/MCP | 按需 | 专项能力 |
| L7 控制面（1.2.0） | §7.1 的九项（切脑 / 回滚 / 多任务 / 会话 / 交接 / CLI 桥） | 热切换、会话管理、CLI 免重启 |

> 没有 L4 的证据，不要写「已端到端验证」。
> L7 会**改账号状态**（切大脑 / 删会话 / 派任务），跑之前想清楚你是在哪个账号上跑。

DSH 的 L3 示例（隔离凭据；不要把真实 `~/.dsh` 交给探针）：

```powershell
$env:ACP_BIN = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"  # 按实际安装位置调整
$env:ACP_ARGS = '["--profile","acp"]'
$env:ACP_SHELL = "1"
$env:ACP_HOME_ENV = "DSH_HOME"
$env:ACP_HOME = "$env:TEMP\dsh-probe"
$env:ACP_MODEL = '["deepseek-account","deepseek-flash"]'   # 桌面登录必须选 account（探针会显式 set_config_option）；想复现「跟随日常 dsh」，把你**真实**的 `~/.dsh/profiles/acp/cordis.patch.yml` 复制进 ACP_HOME、并去掉 ACP_MODEL——那份里要有你自己写的 `- id: acp`（`wemind brain` 会给片段），否则 dsh 仍会退回 deepseek-official（沙箱副本与之逐字节一致，复制哪份都行；需桌面端在运行）
# 可选：把 ~/.dsh/.credentials.yaml 复制到 ACP_HOME（敏感文件，测完删除）
node scripts/acp-probe.mjs
```

---

## 1. 准备

```powershell
# 1) 构建
npm run build
npm run typecheck
npm test

# 2) 环境事实
pwsh -NoProfile -File scripts/doctor.ps1

# 3) 账号
wemind list
```

> **在 VS Code 集成终端里跑 `npm test`**：VS Code 的「智能自动附加」会给 node 注入调试 bootloader（`NODE_OPTIONS=--require …/ms-vscode.js-debug/bootloader.js` + `VSCODE_INSPECTOR_OPTIONS`），测试里起的真实子进程会偶发卡住/超时——用 `NODE_OPTIONS= npm test`（PowerShell：`$env:NODE_OPTIONS=$null` 后再跑）。1.2.0 起 daemon 自己的脱离式 spawn 已过 `debug-env.ts` 净化，不受影响；受影响的是测试进程本身。

> 下文的 `wemind` 指已发布的 CLI（`npm i -g @wemind/cli`，安装后用 `wemind version` 验证）。
> 在仓库里跑源码版时等价于 `node packages/wechat-daemon/dist/cli.js <子命令>`；两种方式操作同一份 `~/.wemind/` 数据。

如果还没有账号：

```powershell
wemind login --label 我的bot --start
```

> 登录会出二维码，需要你本人扫码；这一步无法由 CI 代跑。

---

## 2. 选大脑 & 自检

```powershell
wemind brain <key>
wemind brain check <key>
```

期望：`可用：✅ ...`，且 `brain check` 打印 `ACP 握手成功（initialize + session/new）`。

如果失败：先看 [`debug-daemon.md`](debug-daemon.md) §3.1，不要直接改代码。

---

## 3. 启动

```powershell
wemind start <key>
wemind list
```

期望：`运行中(pid ...) brain(pid ...)`（brain 是懒启动，第一条消息后才有 pid）。

---

## 4. 微信单轮（L4）

1. 用**登录者本人**的微信给 bot 发：`你好，只回复 OK`；
2. 看日志：

```powershell
Get-Content "$env:USERPROFILE\.wemind\<key>\daemon.log" -Tail 80
```

期望顺序：

```text
[wemind/wechat-daemon] turn start to=...
[wemind/wechat-daemon/acp] spawn ... 
[wemind/wechat-daemon/acp] initialized
[wemind/wechat-daemon/acp] session/new ok ...   # 首次
[wemind/wechat-daemon/acp] → session/prompt#...
[wemind/wechat-daemon/acp] prompt ok ... chunks=N updateTypes=[...]
[wemind/wechat-daemon] replied to ...
```

3. 微信收到回复。

---

## 5. 多轮 / 自愈（L5）

1. 发「记住暗号 PINEAPPLE，只回复收到」；
2. 杀掉 daemon（`wemind stop <key>`），再 `start`；
3. 发「暗号是什么？只回复暗号」；
4. 期望：回复包含 `PINEAPPLE`，日志出现 `session/load ok` 或 `session/resume ok`。

> 如果出现 `session/load failed ... creating new`，且 agent 支持 resume，说明 M2 的 resume 兜底还没做；记录为缺陷，不要当成「模型记性差」。

---

## 6. 任务 / 图片 / MCP（L6）

### worker（1.2.0：多任务 + 进程池）

CLI：

```powershell
wemind task "在任务目录创建一个 hello.txt，内容为 hello"
wemind task "统计一下仓库里 TODO 的数量" --agent opencode    # 指定 agent（只影响这一条，不改默认任务大脑）
wemind task-list                                           # 编号/agent/状态/轮次/时长
wemind task-reply 2 "继续"                                  # 发给指定编号
wemind task-stop 2                                         # 单条；task-stop 全部 = 全停
```

微信端等价：`任务：xxx`、`任务 opencode：xxx`、`任务列表`、`#2 继续`、`结束任务 2`。

期望：`task-list` 有输出、状态从「跑」到「完成」；任务目录出现文件；结束一条「等你回复」的任务后进程**留着复用**（`wemind list` 仍能看到空闲 worker），空闲 5 分钟后被回收（结束「正在跑」的那条只能力杀，进程不保留）。

**provider 报错不抢消息（2026-10-29 新增，真机最省事的做法是拿一条余额不足的 agent 现成复现）**：派一条注定失败的任务（如当前 `deepseek` 余额不足）→ 推送应是「中断了（**额度/余额不足**）」、`任务列表` 显示「**已中断**」而不是「等你回复」→ **紧接着发一条无编号的普通消息**（如「在吗」）→ 它必须**走大脑**（修复前：被那条 waiting 任务吞掉，又白失败一轮）；**账号修好后**再回「继续」/`#n 继续` 才是能续上的那一步（账号没修好时续跑只是又失败一轮、退回「已中断」，这是预期的）。日志对照 `task <n> turn failed:` 紧跟着的 `task <n> provider issue（…）→ 已转「已中断」，不再接管无编号消息`。

### 图片

- 发一张图 → 支持 image 的 agent 应能描述；不支持（如 DSH 官方）应被友好拦截，而不是反复 `-32602` 重试。
- 看 `promptCapabilities.image`：`wemind brain check` 不打印能力，跑 `scripts/acp-probe.mjs` 看 `initialize`。

### MCP

```text
MCP
加载 <名>
<发一条需要该工具的消息>
卸载 <名>
```

期望：下一条消息生效；`wechat` 被拒绝。

---

## 7. 验收清单

| # | 项 | 通过标准 |
|---|---|---|
| 1 | 构建/单测 | 全绿 |
| 2 | `brain check` | `initialize + session/new` 成功 |
| 3 | 单轮 | 日志 `prompt ok`，微信收到非空回复 |
| 4 | 多轮 | 重启后追问，上下文还在（load/resume） |
| 5 | 新会话 | `新会话 [名字]` 后旧上下文清空、列表可见 |
| 6 | 自愈 | 杀进程后下一条能重建并恢复 |
| 7 | 长任务 | 不因首帧误杀；进度不刷屏 |
| 8 | 反向请求 | 有则应答，不卡死 |
| 9 | 图片 | 按 agent 能力工作或友好拒绝 |
| 10 | MCP | 加载/卸载生效；`wechat` 禁止 |
| 11 | worker | 派发/中断/继续可用（多任务见 §7.1） |
| 12 | 多账号 | 沙箱/会话隔离 |
| 13 | 热切换 | 不重启 daemon 换大脑，在途回合跑完 |
| 14 | 切换回滚 | 坏 bin 被拒，旧大脑继续答，`brain.json` 未变 |
| 15 | 多任务并行 | 两条不同 agent 同时跑且都出结果 |
| 16 | 任务上限 | 第三条被拒且提示清楚（CLI 答复＝拒绝原因，不是「已派发」） |
| 17 | 中断续跑 | 重启后标「已中断」，回「继续」接上 |
| 18 | 会话四件套 | 列表 / 恢复 / 重命名 / 删除 与权限都对 |
| 19 | 交接 | 摘要只带上一次，切回来源不带上 |
| 20 | CLI 热切换 | `wemind brain switch` 在 daemon 运行时免重启生效 |

### 7.1 控制面九项（1.2.0 新增，手工）

按顺序跑；每项都**先看 `wemind list` + `wemind brain`**，再看微信答复。日志关键字：`switch`、`drain`、`warmup`、`rollback`、`pool`、`reap`。

**① 切脑（`wemind brain switch <agent 名>` / 微信 `切换大脑 <agent 名>`）**

1. 记下当前大脑（`wemind brain`）；
2. 切换到一个**已装且能起**的另一个 agent；
3. 期望：答复两段（「正在切换…」+「已切换」）；`brain.json` 已更新；**daemon pid 不变**（没重启）；下一条消息由新大脑答。

**② 切脑失败退回**：把目标 agent 的 bin 改成一个不存在的路径（`wemind brain set <agent 名> --bin <坏路径> --restart` 或手改 `brain.json` 的 `presets` 段），再切过去。

期望：答复写明「切换失败，已退回原来那个「旧大脑」」；`brain.json` **未被改写**；旧大脑**还能继续答**（下一条消息即验证）；`wemind brain` 显示的仍是旧大脑。

**③ 多任务并行**：`任务 kiro：…` + `任务 opencode：…` 同时发出（或微信端 `任务 <agent 名>：正文` 两条）。

期望：两条都出结果；`wemind task-list` 显示两行不同 agent；`wemind list` 显示池里有对应进程。

**④ 任务上限**：把 `WEMIND_MAX_WORKERS` 调成 2，派第三条。

期望：**派发时**即被拒并提示上限（不是静默排队）；已跑的两条不受影响。**CLI 的答复必须是那句拒绝原因**（`⚠️ 任务 #3 没起得来：…上限…`），不能报「已派发」——这条答复由 daemon 在 `acquire` 之后写进 `task-out/<命令 id>.json`（1.2.0 补的回结果通道，见 `docs/本地双入口-命令派发与查看回复.md` §3.1b）；`task-reply 9 "…"` 回复一个不存在的编号时同理，应回「没有 #9 号任务」而不是「已发送」。若 daemon 是**旧版本**（不写答复），CLI 会退回「已发送…」并附一句「没等到 daemon 答复」——这也是预期行为，不是故障。

**⑤ 任务中断续跑**：派一条长任务 → 跑到一半 `taskkill /PID <daemon> /T /F`（或 `wemind stop <key>`）→ 重启 daemon。

期望：`任务列表` 显示该任务「已中断」；回「继续」（或 `#n 继续`）**才**拉进程续跑，上下文接上；agent 不支持恢复时给「这次接不上」这类诚实文案（并指出重试无效、要重来就结束这条任务后重新派），**不**假装成功；编号不归零（新任务编号接着排）。

**⑥ 会话四件套**：会话 A 塞暗号 → `新会话 测试2` → `会话列表` → `恢复会话 <序号>` → 问暗号。

期望：暗号回来；列表里 `←当前` 指对了；`恢复会话` 一个不存在的 id → **失败且当前会话不变**（严格恢复，不回退新建）；`删除会话` 删当前会话后，下一条消息开新的；非 owner 用户只看得到自己的会话。

**⑦ 交接**：在当前大脑聊几轮 → `交接` → `切换大脑 <新 agent>` → 问一个**只有旧上下文能答**的问题。

期望：新大脑答得出；`handoff.json` 被消费（第二条**不再**重复带上）；切**回**来源大脑时摘要不带上（留着下次切走用）。

**⑧ CLI 热切换**：daemon 在跑时执行 `wemind brain switch <agent 名>`、`wemind brain set <agent 名>`（纯 agent 名，应等价于热切换）、`wemind session new/list/rename/delete`。

期望：全部经控制桥生效（`control-out/<id>.json` 有应答、`control-inbox/` 排空）；微信里 `会话列表` 能看到 CLI 改的名字；故意切到一个坏 bin 的 agent → 答复「已回滚」且 `brain.json` **未变**（`brain set` 这条会说清「没有写入磁盘」）。对**旧版** daemon：需要 daemon 执行的命令（`session new`/`resume`、`brain switch`、`brain set <agent 名>`）应在**发出前**拒绝并给出 `wemind stop <key> && wemind start <key>`，`session list`/`rename`/`delete`/`task-list` 照常（list 附一行说明）——两者都不算失败，算预期行为。

**⑨ 切换窗口内 stop**：切换刚答复成功、约 1 秒内执行 `wemind stop <key>`，然后 `wemind list` / 任务管理器看有没有残留 ACP 子进程。

期望：**已知窗口**，可能漏杀新起的 ACP 子进程——记录现象即可，不要当成新缺陷；下次 `start` 前手工确认没有孤儿。

### 7.2 待实测（先量再写进文档，2026-10-28 清单）

下列问题**没有**静态答案，测完把结论落到对应文档：

| # | 问题 | 怎么测 | 结论影响 |
|---|---|---|---|
| 1 | ACP 是否有 `session/delete` | `scripts/acp-probe.mjs` 或手发该 method，看是否 `-32601` | 「删除会话」到底能不能删 agent 侧存档（当前按「不能」设计） |
| 2 | 各 agent `session/load` 是否回放历史帧、规模多大 | 长会话 load 后看帧数与耗时 | 恢复会话的等待时长与提示文案 |
| 3 | 各 agent 冷启动 `initialize`/`session/new` 真实耗时 | 空 HOME 起一次计时 | 对 `REQ_TIMEOUT=30s` 的余量；是否要给 agent 加 `reqTimeoutMs` |
| 4 | 多任务并行时两条以上 `sendNotice` 是否撞 `ret=-2` | 真机微信并发派 2–3 条任务 | 进度/结果推送是否需要进一步退避 |
| 5 | Windows `taskkill /T /F` 在 `session/load` 途中、以及**杀池中某个特定进程**时的行为 | 分别在 load 中、空闲时杀单个 pid | 回收策略与孤儿检测 |
| 6 | 同一 agent 两个进程共用配置目录是否互踩（kiro/opencode/qoder 各一次） | 同 agent 并发两条任务 | 是否要禁止同 agent 并发 |
| 7 | 被强杀后各 agent 能否 `session/load\|resume` 回该任务会话（kiro/opencode/qoder/DSH 各一次） | ⑤ 的做法，四家各跑一遍 | 「重启后续跑」的**可行边界** |

### 7.3 实测结论（2026-10-29，本机；deepseek DSH 0.2.1-rc.2 / opencode 2.0.32 / qoder 1.1.78；cline 3.0.74 于 2026-10-30 补测）

测量脚本：`%TEMP%\acp-measure.mjs`（起真进程 → `initialize`/`session/new` 计时 → 一轮 prompt → 在新会话上探 `session/delete` → **强杀** → 新进程 `session/load`，失败再 `session/resume` → 数回放帧 → 用第二问验证上下文是否还在）。三家全程**零反向请求**。

| # | 结论 |
|---|---|
| 1 | **`session/delete` 存在性两家有、一家无**：opencode **有**（~8ms）、qoder **有**（130ms）；DSH **没有**（`-32601`）。当前实现「删除会话只删登记项、不动 agent 侧存档」因此仍是唯一可移植的默认；opencode/qoder 侧日后可以做成真删，但要有「删失败就只删登记项」的降级。 |
| 2 | **`session/load` 回放**：opencode **857ms / 2 帧**、qoder **804ms / 3 帧**；DSH 无 `session/load`，`session/resume` **195ms / 0 帧**。回放帧在无 prompt 时本就被丢弃（`acp-brain.ts`），不会突然冒出旧正文；恢复等待远小于超时，不需要额外提示。 |
| 3 | **冷启动**：DSH `initialize` **5834ms**（同进程第二次 2213ms）、`session/new` **50ms**；opencode `initialize` ~650ms、`session/new` ~800ms；qoder **1718ms / 1493ms**。全部远小于 `REQ_TIMEOUT=30s` → **暂不需要给 agent 加 `reqTimeoutMs`**。 |
| 4 | **多任务并行推送到微信**：opencode + qoder 两条任务并行、结果都送达，**没有观察到限流型 `ret=-2`**。真机上出现的 `-2` 全部属于「daemon 重启后、用户下一条消息之前」的旧 `context_token`（见下方 7.4）——那条已修。 |
| 5 | **`taskkill /T /F`**：强杀 daemon 后后台守护进程 5s 内拉起新 daemon；`wemind stop` 一次杀光 wrapper+daemon+worker，**无孤儿**。**「`session/load` 进行中强杀」与「杀池中某个特定 pid」未单独测**。 |
| 6 | **同 agent 并发**（opencode 两条）：两轮都完成，一轮样本内**没有**观察到配置目录互踩；长期风险仍需留意（等价「两个终端同目录跑」）。 |
| 7 | **强杀后接回原任务会话**：**DSH（`session/resume`）与 opencode（`session/load`）实测能接回同一 sessionId**；qoder 在切脑场景能复用旧会话。qoder 的**任务**中断续跑未单独测（按同一 ACP 路径推断可用）。 |
| 8 | **Cline 3.0.74（2026-10-30）**：`initialize` 广告 `loadSession:true`、`image:true`、3 个 authMethods；`session/prompt` 首帧 **4.1s** / 首字 **4.4s**（带 thought 帧）；带图 prompt 被接受（~10s，取决于模型）；**强杀后 `session/load` 成功、上下文保留**（PINEAPPLE，首字 2.1s）；`session/close` **不存在**（`-32601`，WeMind 不调用）；全程 0 反向请求；`session/new`/`load` 的 `mcpServers` 参数**只存不用** → MCP 必须走配置文件。认证：自定义 provider 由 `credentialEnv` 从 `providers.json` 自动派生 `CLINE_PROVIDER`/`CLINE_API_KEY`（2026-10-31 补；显式 env 优先），OAuth 走 Cline 自己的 restore；`models.json` 必须同步进沙箱（缺它会回退 `gpt-4o`，真机 #16 复现、补文件后 #17 成功）。 |

### 7.4 真机踩到的坑：重启后旧 `context_token`（2026-10-29 已修）

现象：`taskkill` daemon（或 `wemind stop` 后再 `start`）之后，**在微信没发新消息之前**跑完的任务，结果一条都收不到；`daemon.log` 里是：

```text
send -2(限流或token失效) → 退避 1.5s 后重试
send error: [sendMessage] errcode=-2 ... (prepare failed)
```

三条都失败（长结果、短结果、失败提示各一条），重试也没用——`reply()` 的重试传的还是同一个旧 token，`sendOrdered` 又把错误吞成了日志。根因不是长度也不是限流：**`state.contextTokens` 是从磁盘恢复的，重启后仍是上次运行的 token；新 token 只有该用户发来下一条消息时才到**。

复现：`wemind stop <key> && wemind start <key>` → 不在微信发消息 → 本地 `wemind task "…"` 派一条短任务 → 等它跑完 → 结果没到（修复前）。修复后同样的步骤：日志出现「`send -2（旧 token）→ 挂起，累计 N 条`」→ 在微信发任意一条消息 → 日志「`新 token 已到 → 补发挂起消息 N 条`」→ 补发真的到达（排在那一批消息触发的进度/答案之前）。挂起只在「该用户本进程还没发过消息」时有意义（此后 `-2` 按限流处理、不挂起）；队列只在内存、每人上限 20 条、每轮最多补发 5 条且不越过本回合留给答复的额度、同一条最多补发 3 次（超过放弃并记日志）；daemon 再重启一次队列会丢，但结果仍在 `tasks.json`/`任务列表`。

### 7.5 真机踩到的坑：provider 报错的任务吞掉日常消息（2026-10-29 已修）

现象：一条任务失败在**模型/账号侧**（余额不足）之后停在「等你回复」，而「谁在等就喂谁」会把用户之后的**每一条无编号消息**都送进那条任务——每次又白失败一轮，日常对话也断了。真机复现就是「DeepSeek 余额不足期间派一条任务，然后发『在吗』」：`在吗` 没进大脑，任务又 push 一条同样的失败提示（所以微信里会看到**两条一模一样的**「中断了（执行出错）」，那不是重复发送、是两次不同的失败事件）。

修法：`task-manager.ts` 的 `providerIssue()` 认出这类错误（额度/余额、密钥鉴权、计费、模型不存在）→ 该任务**直接转「已中断」**（不在 `liveTasks` 里 → 不再接管无编号消息）→ 账号修好后回「继续」/`#n 继续` 续跑。**限流（429/rate limit/overloaded）不在这一类**（等一会儿重试就会好，仍停在「等你回复」），所以判据里限流的判断**优先**——Google 的按分钟 429 写的是「Quota exceeded … requests per minute」，只按关键字会把限流误判成额度问题；**认不出的一律按老规矩**——宁可多抢一次，也不把偶发失败误判成账号问题。同一次修复把续跑前缀改成中性文案（原先写死「daemon 重启时中断了」），并统一提示「先核对上一步是否已产生副作用」。

复盘要点：这条坑**只有真机、只有真实失败**才会暴露——离线 e2e 的假 agent 从不回 provider 错误，单测也只覆盖到「失败后停在 waiting」。凡是「状态机决定消息去哪」的改动，验收都要带上「失败之后**下一条无关消息**的去向」这一问。

实测（2026-10-29，本机真 daemon + DSH 余额不足）：重启 daemon（顺带把上一版留下的 waiting 任务 #12 读回成「已中断」）→ 本地派 #13 → 日志 `w1 ← session/prompt#4 ERROR … Insufficient Balance` → `task 13 turn failed: …` → `任务列表` 显示 `#13 [deepseek] 已中断 · 0 轮`，最近输出是「中断了（**额度/余额不足**）。这类错误重试也不会好——修好后回复「#13 继续」…」；`workers.pid.json` 为空、无残留 `dsh` 进程（失败时 `ask()` 已 `kill()` → `release()` 把死连接摘出池，不会留死壳被下一条任务复用）。

## 8. 清理 / 回滚

```powershell
wemind stop <key>                 # 一次杀光 daemon + brain + 全部 worker
# 换回大脑（1.2.0）：
wemind brain switch kiro          # daemon 在跑 → 热切换；没跑 → 只写入磁盘，下次启动生效
wemind brain set kiro --restart <key>   # 老写法：写入磁盘 + 重启 daemon（仍可用）
```

清空对话记忆（**不是**回滚，是重置）：

- 删 `<数据目录>/brain-sessions.json`（当前会话表，权威）+ `<数据目录>/session-registry.json`（登记表，派生）+ `<数据目录>/brain-home/<agent>/sessions/`；
- 单个会话不用删文件：微信里 `删除会话 <序号>` 即可（只删登记项，agent 侧存档仍在磁盘上）。

清空任务侧：

- 删 `<数据目录>/tasks.json`（任务表；删了下条任务编号从头开始）+ `<数据目录>/task-state.json`；
- 残留进程看 `workers.pid.json`；确认没有孤儿 ACP 进程再重跑，否则同 agent 两个进程会共用配置目录。

不要删 `account.json`，除非你要重新扫码登录。

---

## 9. 参考

- [`docs/新手教程.md`](../../新手教程.md)
- [`docs/使用指南-远程任务（worker）.md`](../../使用指南-远程任务（worker）.md)（多任务、编号、续跑）
- [`docs/repowiki/05-daemon.md`](../../repowiki/05-daemon.md)
- [`docs/repowiki/06-ACP-大脑与沙箱.md`](../../repowiki/06-ACP-大脑与沙箱.md)（槽位 / 热切换 / 会话管理 / 进程身份）
- [`docs/repowiki/07-远程任务-Worker.md`](../../repowiki/07-远程任务-Worker.md)（进程池 / 任务编号）
- [`docs/本地双入口-命令派发与查看回复.md`](../../本地双入口-命令派发与查看回复.md)（控制桥）
- [`docs/ai/recipes/debug-daemon.md`](debug-daemon.md)
- [`scripts/acp-probe.mjs`](../../../scripts/acp-probe.mjs)
