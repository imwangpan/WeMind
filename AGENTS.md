# AGENTS.md — WeMind 的 AI 协作者入口

> **适用版本**：WeMind 1.2.0 ｜ **最后核对**：2026-10-28（`@wemind/cli@1.2.0` 待发布 / `1.1.1` 已发布） ｜ **维护约定**：改代码时同步本文件；不确定的结论标注「假设/待实测」。
>
> 这份文件写给 AI agent，也写给人。**先读这里，再按链接深入**；不要一上来通读整个 `docs/repowiki/`。

---

## 0. 30 秒认识项目

WeMind 把**个人微信**变成 AI agent 的输入输出通道，对外有两种形态（**两个包都已发布到 npm**）：

| 形态 | 入口 | 谁长轮询 | 谁生成回复 | 协议 |
|---|---|---|---|---|
| ① MCP Server | `npx -y @wemind/wechat-mcp`（bin `wemind-mcp`） | MCP 客户端（Claude Desktop / Cursor / OpenCode / kiro…） | 客户端 agent | MCP over stdio |
| ② daemon | `npm i -g @wemind/cli` → 命令 **`wemind`**（源码 `packages/wechat-daemon`） | daemon 自己 | daemon 调常驻 **ACP agent**（大脑） | ACP over stdio |

两种形态共享 `@wemind/wechat-ilink-core`（iLink 协议内核，`private`，构建时内联进上面两个包）。

> **硬约束**：同一个 bot token **只能有一个消费者**。形态①和形态②不能同时跑，否则互相抢消息/回环。
>
> **命名硬约束**：包名 `@wemind/cli` ≠ 命令名 `wemind`（`bin` 字段决定命令）。`npx` 按包名解析，所以只能 `npx -y @wemind/cli`，不能 `npx wemind`。

---

## 1. 10 分钟阅读顺序

1. 本文。
2. [`docs/ai/README.md`](docs/ai/README.md) — 术语、数据流、事实状态表。
3. [`docs/repowiki/02-系统架构.md`](docs/repowiki/02-系统架构.md) — 三包协作与进程模型。
4. 按任务读代码：
   - 换/接 ACP 大脑 → `packages/wechat-daemon/src/brain-agents.ts` → `acp-brain.ts` → `mcp-sandbox.ts`；
   - **运行时切换大脑 / 回滚** → `brain-switch.ts`（预检/drain/预热/持久化最后）→ `agent-slot.ts`（槽位）→ `acp-brain.ts` 的 `beginSwitch/drainTurn/warmup`；
   - 消息/回复/图片 → `packages/wechat-daemon/src/index.ts` → `md-reply.ts` / `image-reply.ts`；
   - **多任务 / 进程池 / 任务编号** → `task-manager.ts` → `worker-pool.ts` → `worker-acp.ts`（`class WorkerConn`）→ `task-store.ts`；
   - **会话列表/恢复/改名/删除** → `session-manager.ts` → `session-registry.ts`（登记表）+ `session-map.ts`（指针表）；
   - **交接** → `handoff.ts`；**CLI↔daemon 控制桥** → `control-bridge.ts`；
   - **命令解析与帮助** → `chat-commands.ts`（无副作用模块，`index.ts` 里只做薄包装）；
   - CLI/账号 → `cli.ts` / `manage.ts` / `brain-config.ts`。
5. 任务配方：[`docs/ai/recipes/`](docs/ai/recipes/)。

---

## 2. 仓库地图

```text
packages/
  wechat-ilink-core/    iLink HTTP 客户端、类型、错误码、会话守卫、账号/状态、收发图加解密（私有，不发布）
  wechat-mcp/           MCP server，6 个工具（已发布到 npm，bin: wemind-mcp）
  wechat-daemon/        常驻 daemon + ACP 大脑 + worker + CLI（发布包 @wemind/cli，命令 wemind）
docs/
  repowiki/             完整技术 wiki（人读；AI 可按需检索）
  ai/                   AI 上下文包 + 任务配方（先读这里）
  发布-wemind-npm.md     wemind 独立发布方案（命名/打包/CI/版本同步/验收）
 接入-*.md              各 agent 的接入设计/实测
scripts/                daemon wrapper、pm2、doctor、发布守卫（prepack-guard / check-version）
```

关键文件：

| 文件 | 职责 |
|---|---|
| `packages/wechat-daemon/src/index.ts` | 消息路由、回合编排、进度节流、brain/worker 分流、控制桥扫描（`scanControlInbox`） |
| `packages/wechat-daemon/src/acp-brain.ts` | 常驻 ACP 客户端（对话大脑）；含 `resumeSession`（strict 恢复）、`beginSwitch/drainTurn/warmup` |
| `packages/wechat-daemon/src/agent-slot.ts` | brain/worker 的 **agent 槽位**（懒解析 + 记忆化；`setAgent` 供热切换用） |
| `packages/wechat-daemon/src/brain-switch.ts` | 热切换：预检 → drain → 预热 → 成功才落盘；失败回滚 |
| `packages/wechat-daemon/src/worker-acp.ts` | 任务 worker 的 ACP 客户端（`class WorkerConn`，一条任务一条连接） |
| `packages/wechat-daemon/src/worker-pool.ts` | worker 进程池（复用/回收/上限；`workers.pid.json` 记录数组） |
| `packages/wechat-daemon/src/task-manager.ts` | 任务表（编号、注入消歧、停止；默认任务大脑 + 粘性） |
| `packages/wechat-daemon/src/task-store.ts` | 任务表落盘 `tasks.json`（损坏降级、中断标记、编号跨重启连续） |
| `packages/wechat-daemon/src/session-manager.ts` | 会话五条指令的实现层（`create`/`resume` 依赖注入） |
| `packages/wechat-daemon/src/session-registry.ts` | 会话登记表（派生元数据：名字/标题/轮次）——**不是**「当前是哪个」的权威 |
| `packages/wechat-daemon/src/handoff.ts` | 交接（摘要落盘 + 前缀注入 + 答成才消费） |
| `packages/wechat-daemon/src/control-bridge.ts` | CLI↔daemon 文件桥（请求/应答/`.bridge` 凭据；**只收预设名与纯数据**） |
| `packages/wechat-daemon/src/chat-commands.ts` | 命令表（解析 + 帮助**同表**驱动） |
| `packages/wechat-daemon/src/pid-record.ts` | `brain.pid` / `workers.pid.json` 身份记录（JSON，含起进程时真实用的 bin/args） |
| `packages/wechat-daemon/src/brain-agents.ts` | `ACP_AGENT_PRESETS`、`resolveAgent()`、`resolveAgentFor(cfg, role)`、`agentProblem()` |
| `packages/wechat-daemon/src/mcp-sandbox.ts` | brain 沙箱、MCP 激活集、记忆/技能继承 |
| `packages/wechat-daemon/src/worker-sandbox.ts` | worker 沙箱（继承全量 MCP，排除 wechat） |
| `packages/wechat-daemon/src/spawn-agent.ts` | 统一 spawn（Windows `.cmd` 经 shell + 逐参数引号） |
| `packages/wechat-daemon/src/brain-check.ts` | `wemind brain check` 的真 ACP 握手 |
| `packages/wechat-daemon/src/manage.ts` | `wemind` 子命令实现（`brain switch`/`session *`/`task-*` 走控制桥） |
| `packages/wechat-mcp/src/tools/*` | 6 个 MCP 工具 |

---

## 3. 常用命令

```powershell
npm run build        # core → daemon/mcp
npm run typecheck
npm test             # vitest
npm run lint
npm run check:version    # 包名+版本一致性（发布前必跑）
npm run daemon       # 直接起 daemon（需已构建）
wemind version       # 已安装的 CLI 版本（npm i -g @wemind/cli）
wemind brain         # 查看当前大脑（含预设/自动探测顺序）
wemind brain check   # 真机 ACP 握手
wemind brain switch opencode        # 热切换对话大脑（daemon 在跑就不重启、不打断在途回合）
wemind brain switch opencode --worker   # 设默认任务大脑（粘性，不写 brain.json）
wemind brain handoff # 生成交接摘要（供切走后第一条消息注入）
wemind session list  # 会话列表（daemon 不在也能读，只是按「下次会用的那个大脑」列）
wemind session new 周报 / resume 3 / rename 3 新名字 / delete 3
wemind task-list     # 任务列表（编号/agent/状态）；task-reply <n> "…"、task-stop [n|全部]
node packages/wechat-daemon/dist/cli.js brain   # 从源码跑等价命令
pwsh -NoProfile -File scripts/check-docs.ps1    # 检查 Markdown 相对链接
```

> 首次使用/环境不确定：先跑 [`scripts/doctor.ps1`](scripts/doctor.ps1)。

---

## 4. 不可违背的约束（改代码前必读）

1. **一个 token 一个消费者**：MCP 形态与 daemon 形态二选一；brain 的 MCP 沙箱永久禁止 `wechat`（防回环）。
2. **ACP 是最小方法集，不是「所有 agent 都一样」**：
   - `session/load` 不是通用能力；DSH 只有 `session/resume`，缺失时会退化为 `session/new`；
   - **image / restore(load|resume) / mcpViaAcp 目前来自「预设字段」，不来自 `initialize` 回包**：`acp-brain.ts` 发出 `initialize` 后只置 `initialized = true`，**从不解析** `agentCapabilities`。所以接新 agent 时必须人工读一次 `initialize`（`scripts/acp-probe.mjs`）并把结论写进 `brain-agents.ts` 的预设；不要以为代码会自动适配；
   - agent 可能发反向请求（`session/request_permission`、`fs/*`、`terminal/*`）。`acp-brain.ts` / `worker-acp.ts` 已内置应答器：权限请求默认拒绝，未知 method 回 `-32601`；可信部署可设 `WEMIND_ACP_AUTO_ALLOW=1` 放行一次性权限。
3. **brain 是一个 ACP 进程、worker 是 N 个（进程池）**：协议改动要同步 `acp-brain.ts` 和 `worker-acp.ts`（后者已类化，别再把状态写在模块级）。
4. **MCP 按 agent 分派**：kiro 读 `settings/mcp.json`；opencode 读 `opencode.json` 的 `mcp.servers`；DSH 走 ACP `session/new` 的 `mcpServers`。**不要让 A 读 B 的配置文件**。
5. **微信有连发上限（约 10 条）**：进度消息会占额度；`index.ts` 的 15s 心跳在「无 activity 帧」时会持续发，接入 committed-only agent 要单独处理。
6. **Windows `.cmd`/`.bat` 必须经 shell**：统一用 `spawnAgent()`，不要直接 `spawn(bin,args,{shell:true})`（DEP0190 + 注入面）。
7. **数据按账号隔离**：默认 `~/.wemind/<账号>/`；不要跨账号共用 `brain-sessions.json` / `brain-home`。
8. **切换大脑落盘用 `wemind brain set`**；环境变量 `WEMIND_BRAIN*` 是一次性覆盖，不要写进 profile。
9. **不要把密钥写进预设/源码**；`DEEPSEEK_API_KEY` 等由 daemon 进程环境提供。
10. **注释按段落换行，不按行宽折行**：一段一行（多长都不手工断开，编辑器/阅读器自己折行），只有语义上属于不同段落时才另起一行；列表项 / 标题 / 代码围栏 / 分隔线 / 用法表 / 独立命令行各自成行，「标签：内容」行（`用法：` / `退出码：` / `注意：`）另起一行。缩进保留原样——它表达层级，不是折行标记。`oxfmt` 不重排注释，所以别把英文注释按 120 列折回来。
11. **控制桥只接受「预设名 + 纯数据」**：`control-bridge.ts` 的请求字段只有 `target`（预设名）/`ref`/`name`/`text`/`taskId`/`page`，**没有也不可能有 `bin`/`args`/`shell`**——伪造请求最坏只能「选一个已装的 agent 或清掉自己的会话」，绝不能让 daemon 执行任意程序。`wemind brain set` 带 `--bin/--args/--shell` 时**不走桥**（只写盘 + 需重启），这是刻意的边界，不要为了「顺手热应用」把它拆掉。
12. **「当前是哪个会话」的唯一权威是 `brain-sessions.json`（指针表）**：`session-registry.json` 只是**派生元数据**（名字/标题/轮次），坏了最多导致列表空——它的写失败只许记日志，**不得**抛出拖垮回合；`恢复会话` 是 **strict**：load/resume 都失败就如实报错、**不回退新建、不改指针**（宁可报错，也不要「假恢复」）。
13. **任务侧的两条持久化纪律**：① 结束**在等你回复**的任务时进程**回池**（不杀，空闲回收交给池）；**正在跑**的那条被结束时只能力杀（ACP 回合没法优雅取消），`wemind stop`/daemon 退出则杀光整池。② 任务表 `tasks.json` 只用来做「重启后续跑」——**不自动 spawn**（重启后不主动拉起 3 个 agent）、**不做历史归档**（微信聊天记录本身就是归档）；未完成的标「已中断」，用户回「继续」才续跑。切换大脑时**持久化放最后**（成功才写 `brain.json`）：这样失败回滚无需撤销。

---

## 5. 「改哪里」速查

| 任务 | 从这里开始 |
|---|---|
| 新增 ACP agent 预设 | `brain-agents.ts` 的 `ACP_AGENT_PRESETS`；按 [`docs/ai/recipes/add-acp-agent.md`](docs/ai/recipes/add-acp-agent.md) |
| 改 ACP 协议/自愈/超时 | `acp-brain.ts` + `worker-acp.ts`（两边同步） |
| 改**热切换**（drain/预热/回滚） | `brain-switch.ts` + `acp-brain.ts`（`beginSwitch/drainTurn/warmup`）；回执在 `index.ts` 的 `AI`/`切换大脑` 分支 |
| 改**多任务/进程池/编号** | `worker-pool.ts`（策略纯函数 `planAcquire/planReap`）+ `worker-acp.ts`（`WorkerConn`）+ `task-manager.ts` + `task-store.ts` |
| 改**会话管理** | `session-manager.ts`（操作层）+ `session-registry.ts`（登记表）；`acp-brain.ts` 的 `resumeSession` 是 strict 恢复 |
| 改**交接** | `handoff.ts`（落盘/注入/消费）+ `index.ts` 的 workerLoop 前缀注入 |
| 改**CLI 与微信的对等** | `control-bridge.ts`（协议）+ `index.ts` 的 `handleControlRequest` + `manage.ts`（CLI 侧） |
| 改命令/帮助 | `chat-commands.ts`（**同表驱动解析与帮助**，改一处两处都变） |
| 加/改 MCP 注入 | `mcp-sandbox.ts` / `agent-mcp.ts` / `worker-sandbox.ts`；按 [`docs/ai/recipes/add-mcp.md`](docs/ai/recipes/add-mcp.md) |
| 改微信消息处理/回复 | `index.ts`、`md-reply.ts`、`image-reply.ts` |
| 加 CLI 子命令 | `cli.ts`（注册）+ `manage.ts`（实现） |
| 改数据目录/账号 | `wechat-ilink-core/src/store/*`、`brain-config.ts` |
| 排查 daemon 不回复 | [`docs/ai/recipes/debug-daemon.md`](docs/ai/recipes/debug-daemon.md) |
| 跑端到端验收 | [`docs/ai/recipes/run-e2e.md`](docs/ai/recipes/run-e2e.md) |

---

## 6. 已知坑 / 文档漂移（2026-10-24 已核对）

- **默认大脑不是 kiro**：未配置时是 `auto`，按 `kiro → opencode → gemini → deepseek → qoder` 探测；落盘配置在 `<数据目录>/brain.json`。
- **DeepSeek 已内置预设**：官方 DSH `dsh --profile acp`；桌面端通常要用 `wemind brain set deepseek --bin "<...>\dsh.cmd"` 落绝对路径，并依赖 `DSH_HOME` 沙箱里的 `.credentials.yaml`（从 `~/.dsh` 同步）。微信 brain/worker E2E、动态 MCP（`mcpViaAcp`）、记忆/技能继承均已验证。详见 [`docs/接入-DeepSeek.md`](docs/接入-DeepSeek.md)。
- **「无需改代码」有边界**：只对满足「有 `session/load`、不发反向请求、首帧快、MCP 走配置文件」的 agent 成立。DSH 不满足，但已用预设字段 + M2 适配补齐。
- **仓库没有 `Brain` 接口（当前建议）**：ACP agent 本身就是大脑边界；目前只有 ACP 一种实现，当前建议先不抽接口，避免增加间接层。等真的要做「裸 API 大脑」时再抽 `ask/newSession/restart` 契约，并同步 `index.ts` 调用方。
- **会话映射按大脑分命名空间**：`brain-sessions.json` 键为 `<agent>:<userId>`、`worker-sessions.json` 为 `<agent>:task`；换大脑不会再拿旧 agent 的 sessionId 去 `session/load`（Qoder 回 `-32602 INVALID_SESSION_IDENTIFIER`，DSH 回 `-32601`），切回原大脑仍能恢复上下文。旧格式（裸 `userId` / `task`）首次读取时自动迁移并回写（`session-map.ts`）。
- **`wemind brain check` 默认 60s**：冷启动慢的 agent 仍可能误报；这是已知项，不要把它当「agent 不可用」的唯一证据。
- **`onPath()` 按精确文件名**：只有 `dsh.cmd` 没有无扩展名 `dsh` 时，`binWin` 必须写 `dsh.cmd`。
- **DSH 0.2.1-rc.2 实测**：无 `session/load`（`-32601`）、`image:false`（带图 `-32602`）、有 `session/resume`；**resume 后多轮上下文保留**（PINEAPPLE，含 `taskkill /T /F` 强杀）；stdio/HTTP MCP 可用；会发 `agent_thought_chunk`/`tool_call`/`usage_update`；stdout 会混入非 JSON 日志行（解析器要容错）。
- **Qoder 已内置预设**：`qoder` → `qodercli --acp --yolo`（**直接起本体**，不要用 `qoder` 分发器，它多套一层 `cmd → powershell`）；`QODER_CONFIG_DIR` 指向沙箱，登录态要同时同步 `.auth/user` + `.auth/machine_id`（缺一个就 `Authentication required`）；`~/.qoder` 与 Qoder Desktop 共用，沙箱设置由 `settingsBase` 复制（剥离 `providers`/`model`，防 BYOK 明文密钥进沙箱）；`memory/` 以 junction 与日常使用共享，`skills/agents/commands`/`AGENTS.md` 在 1.1.78 不存在（空操作）。M0–M3 已验证（含发图、动态 MCP、worker 中断续跑、冷重启 `session/load`）。详见 [`docs/接入-Qoder.md`](docs/接入-Qoder.md)。
- **DSH 模型路由是坑**：`session/new` 默认 `deepseek-official`（需 `DEEPSEEK_API_KEY`）；桌面登录态对应 `deepseek-account`，必须用 `session/set_config_option { configId:"model", value:'["deepseek-account","deepseek-flash"]' }` 显式切换，否则报 `no API key`。
- **节点版本**：仓库声明 Node ≥20；DSH CLI 需要 ≥22（本机 Node 24 可用）。
- **发布相关（2026-10-28 核对）**：包已发布为 `@wemind/cli`（命令 `wemind`）；**包名 ≠ 命令名**，`npx` 只能写 `npx -y @wemind/cli`。**版本号单一来源**：只改 `packages/wechat-daemon/package.json`（`src/version.ts` 运行时读它，勿手写常量），升版本用 `npm run release:patch|minor|major`（= `npm version -w @wemind/cli --no-git-tag-version` + `check:version` 自检）；`npm publish` **不会**自动 build，发前必须 `npm run build`。进程身份特征是**三组** marker（`wemind`+`cli.js`、`wechat-daemon`+`dist`+`cli.js`、`run-daemon.ps1`）：第二组专为「在仓库根用**相对路径**手跑」（`node packages/wechat-daemon/dist/cli.js …`，本节 §3 教的写法）而加——只有 `wemind`+`cli.js` 时，相对路径的命令行里既没有仓库名也没有包名，`isOurProcess()` 会判否，表现为 **daemon 明明活着、CLI 却显示「未运行」且控制桥拒绝投递**（2026-10-28 修）。本地 `npm test` 计数受 `.agents/` worktree 副本干扰已由 `vitest.config.ts` 排除。详见 [`docs/发布-wemind-npm.md`](docs/发布-wemind-npm.md)。
- **升级 CLI 后要先重启 daemon（2026-10-28）**：新 CLI 的热切换/会话/任务命令都要 daemon 认识控制桥，凭据是 `<数据目录>/control-out/.bridge`（内容 = daemon 自己的 pid）。对**旧版** daemon：**必须由 daemon 执行的写命令**（`session new`/`resume`、`brain switch|worker|handoff`）会在**发出前**就拒绝并提示「`wemind stop <key> && wemind start <key>`」；**本来就是文件操作**的 `session rename`/`delete` 照常直接改登记表（不加说明行），`session list` 则直接读登记表并附一行「按下次会用的那个大脑列」的说明，`task-list`/`task-status` 从来不经过控制桥（读 `tasks.json`，只在 daemon 没跑时注明是上次快照）。改完 daemon 侧代码别忘了 `npm run build` 再重启。
- **`WEMIND_BRAIN` 压过命令式切换（2026-10-28）**：环境变量优先级高于 `brain.json`，所以 `wemind brain switch X` 在**当前进程**里生效并落盘，但重启后若 `WEMIND_BRAIN` 还在，会回到 env 指的大脑——回执里有警告，别把 env 写进 profile（§4.8）。
- **切脑与 `wemind stop` 的窄窗口（2026-10-28，已知项）**：切换的 `restart()` 与新进程写 pid 记录之间约 1s，此刻执行 `wemind stop` 可能漏杀新起的 ACP 子进程（与既有的 `/加载` 触发 `restart()` 同类形态，不是本次新引入）。
- **多任务共享同一份微信额度（2026-10-28）**：连发上限（约 10 条）是**按用户**计的，N 条任务的进度 + 对话大脑的回复都算同一份额度。worker 进度默认安静、结果推送走既有 ret=-2 退避；扛不住就调小 `WEMIND_MAX_WORKERS`。
- **同 agent 并发 = 两个终端在同一个配置目录里跑（2026-10-28）**：不同 agent 各有 `configSubdir` 天然隔离；同一 agent 的两个 worker 进程共用其配置目录（会话/缓存文件是否互踩**待实测**）。
- **本次待实测（2026-10-28，先量再写进文档）**：① ACP 是否有 `session/delete`；② 各 agent `session/load` 是否回放历史帧、规模多大；③ 各 agent 冷启动 `initialize`/`session/new` 真实耗时（对 `REQ_TIMEOUT=30s` 的余量）；④ 多任务并行时两条以上 `sendNotice` 是否撞 `ret=-2`；⑤ Windows `taskkill /T /F` 在 `session/load` 途中、以及**杀掉池中某个特定进程**时的行为；⑥ 同 agent 两进程共用配置目录是否互踩；⑦ 被强杀后各 agent 能否 `session/load|resume` 回该任务会话（「重启后续跑」的可行边界由这条决定）。清单在 [`docs/ai/recipes/run-e2e.md`](docs/ai/recipes/run-e2e.md)。

---

## 7. 验证标准（别只看「代码写完」）

| 改动 | 最低验证 |
|---|---|
| 纯逻辑 | `npm run typecheck` + `npm test` |
| 预设/沙箱 | `wemind brain` + `wemind brain check` + 单测 |
| ACP 协议 | 冒烟：`initialize → session/new → prompt → update`；重建后 `load/resume`；无未应答反向请求 |
| 消息/回复 | 真机微信一条消息 → `daemon.log` 出现 `prompt ok` → 收到回复 |
| MCP | `加载 <名>` → 下条消息生效；`wechat` 仍被禁止 |
| worker | 派发任务 → 中断 → 回「继续」→ 能续上 |
| **热切换大脑** | 真机 kiro↔opencode；预热期间发消息**只 spawn 一次**（看 log）；未知/不可用预设被拒；故意坏 bin → 回滚 + 旧大脑继续答 + `brain.json` 未变 |
| **多任务并行** | `任务 kiro：…` + `任务 opencode：…` 同时跑且都出结果；第三条超上限被拒；结束「等你回复」的任务后进程回池、空闲 5 分钟后消失（`wemind list`/进程管理器验；结束「正在跑」的那条只能力杀）；`wemind stop` 一次杀光所有 worker |
| **任务中断续跑** | 跑到一半 `taskkill` daemon → 重启后 `任务列表` 显示「已中断」→ 回「继续」上下文确实接上；agent 不支持恢复时给诚实文案且编号连续 |
| **会话四件套** | 会话 A 塞暗号 → 新会话 → 列表 → 恢复 → 暗号回来；恢复不存在的 id → 失败且当前会话不变；删当前会话后下条消息开新的；非 owner 只见自己的 |
| **交接** | 交接 → 切脑 → 问只靠旧上下文能答的问题 → 文件已消费、第二条不重复注入 |
| **CLI 热切换 / 控制桥** | daemon 在跑时 `wemind brain switch` 免重启生效；daemon 停时 `session list` 仍可用；`session rename` 后微信 `会话列表` 可见；旧版 daemon → 「必须由 daemon 执行」的命令发前拒绝，文件类命令照常（`session list` 附一行说明） |

日志前缀：`[wemind/wechat-daemon]`、`.../acp`、`.../worker`、`.../task`、`.../watchdog`、`.../wrapper`。

---

## 8. 文档索引

- AI 上下文包：[`docs/ai/README.md`](docs/ai/README.md)
- 任务配方：[`docs/ai/recipes/`](docs/ai/recipes/)
- **发布方案与检查清单（已发布 1.1.1，本次 1.2.0）**：[`docs/发布-wemind-npm.md`](docs/发布-wemind-npm.md)
- 面向用户的新手教程：[`docs/新手教程.md`](docs/新手教程.md)
- 远程任务（多任务/指定 agent/续跑）：[`docs/使用指南-远程任务（worker）.md`](docs/使用指南-远程任务（worker）.md)
- 数据目录与环境变量速查：[`docs/速查-数据目录与环境变量.md`](docs/速查-数据目录与环境变量.md)
- 项目概览：[`docs/repowiki/01-项目概览.md`](docs/repowiki/01-项目概览.md)
- 系统架构：[`docs/repowiki/02-系统架构.md`](docs/repowiki/02-系统架构.md)
- ACP 大脑与沙箱：[`docs/repowiki/06-ACP-大脑与沙箱.md`](docs/repowiki/06-ACP-大脑与沙箱.md)
- 接入其它 agent：[`docs/接入其它-ACP-Agent.md`](docs/接入其它-ACP-Agent.md)
- OpenCode 接入实测：[`docs/接入-OpenCode.md`](docs/接入-OpenCode.md)
- DeepSeek 评估与实测：[`docs/接入-DeepSeek.md`](docs/接入-DeepSeek.md)
- Qoder 接入设计与实测：[`docs/接入-Qoder.md`](docs/接入-Qoder.md)
- DeepSeek 后续待办（M3–M5）：[`docs/待办-DeepSeek-M3-M5.md`](docs/待办-DeepSeek-M3-M5.md)
- 机器可读索引：[`llms.txt`](llms.txt)

---

> **给 AI 的最后一句**：本仓库的文档总体质量高，但「通用 ACP 说法」不等于「当前 agent 的事实」。改 ACP 相关代码前，先用 `initialize` 看 capabilities，再用一次真实 prompt 验证，不要只信文档。
