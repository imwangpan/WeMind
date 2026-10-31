# AGENTS.md — WeMind 的 AI 协作者入口

> **适用版本**：WeMind 1.2.0 ｜ **最后核对**：2026-10-30（`@wemind/cli@1.2.0` 已发布 / `1.1.1` 上一版） ｜ **维护约定**：改代码时同步本文件、全部相关文档与测试用例（硬性要求，见 §4.15）；不确定的结论标注「假设/待实测」。
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
   - **运行时切换大脑 / 回滚** → `brain-switch.ts`（预检/等在途回合结束/启动新大脑/持久化最后）→ `agent-slot.ts`（槽位）→ `acp-brain.ts` 的 `beginSwitch/drainTurn/warmup`；
   - 消息/回复/图片 → `packages/wechat-daemon/src/index.ts` → `md-reply.ts` / `image-reply.ts`；
   - **多任务 / 进程池 / 任务编号** → `task-manager.ts` → `worker-pool.ts` → `worker-acp.ts`（`class WorkerConn`）→ `task-store.ts`；
   - **会话列表/恢复/改名/删除** → `session-manager.ts` → `session-registry.ts`（登记表）+ `session-map.ts`（当前会话表）；
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
| `packages/wechat-daemon/src/acp-brain.ts` | 常驻 ACP 客户端（对话大脑）；含 `resumeSession`（严格恢复）、`beginSwitch/drainTurn/warmup` |
| `packages/wechat-daemon/src/agent-slot.ts` | brain/worker 的 **agent 槽位**（懒解析 + 记忆化；`setAgent` 供热切换用） |
| `packages/wechat-daemon/src/brain-switch.ts` | 热切换：预检 → 等在途回合结束 → 启动新大脑 → 成功才写入磁盘；失败退回 |
| `packages/wechat-daemon/src/worker-acp.ts` | 任务 worker 的 ACP 客户端（`class WorkerConn`，一条任务一条连接） |
| `packages/wechat-daemon/src/worker-pool.ts` | worker 进程池（复用/回收/上限；`workers.pid.json` 记录数组） |
| `packages/wechat-daemon/src/task-manager.ts` | 任务表（编号、编号寻址、停止；默认任务大脑 + 进程内覆盖） |
| `packages/wechat-daemon/src/task-store.ts` | 任务表写入磁盘 `tasks.json`（损坏降级、中断标记、编号跨重启连续） |
| `packages/wechat-daemon/src/session-manager.ts` | 会话五条指令的实现层（`create`/`resume` 依赖注入） |
| `packages/wechat-daemon/src/session-registry.ts` | 会话登记表（派生元数据：名字/标题/轮次）——**不是**「当前是哪个」的权威 |
| `packages/wechat-daemon/src/handoff.ts` | 交接（摘要写入磁盘 + 作为前缀带上 + 答成才消费） |
| `packages/wechat-daemon/src/control-bridge.ts` | CLI↔daemon 文件桥（请求/应答/`.bridge` 凭据；**只收 agent 名与纯数据**） |
| `packages/wechat-daemon/src/task-inbox.ts` | 任务收件箱两个通道（`task-inbox/` 命令 + `task-out/` 答复，两侧共用；派发的答复等起进程有结果才发） |
| `packages/wechat-daemon/src/chat-commands.ts` | 命令表（解析 + 帮助**同表**驱动） |
| `packages/wechat-daemon/src/pid-record.ts` | `brain.pid` / `workers.pid.json` 身份记录（JSON，含起进程时真实用的 bin/args） |
| `packages/wechat-daemon/src/brain-state.ts` | `brain-runtime.json`：daemon 实际生效的大脑（启动/热切换写入；`list` 只在 daemon 活着时采信） |
| `packages/wechat-daemon/src/brain-agents.ts` | `ACP_AGENT_PRESETS`（含 `model` / `realProfile` / `envDefaults` / `sessionMode` 字段）、`resolveAgent()`、`resolveAgentFor(cfg, role)`、`agentEnv()`、`agentProblem()` |
| `packages/wechat-daemon/src/profile-model.ts` | 真实 profile 用户层三件事：`readProfileDefaultModel`（读默认模型——**优先用户自己写的 `- id: acp`**，否则 `agent-default-model`）；`acpOverrideHint`（缺 `- id: acp` 时在 `wemind brain` 里给出可粘贴的片段——**只提示，不替 agent 改配置**，§4.14）；`stripWechatMcpEntries`（复制进沙箱前剔除用户自己挂的微信 MCP 条目，防回环，§4.1） |
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
wemind brain         # 查看当前大脑（含可选 agent/自动探测顺序）
wemind brain check   # 真机 ACP 握手
wemind brain switch opencode        # 热切换对话大脑（daemon 在跑就不重启、不打断在途回合）
wemind brain set opencode --extra-args "--log-level debug"   # 只追加启动参数（--args 是整段替换，漏掉 ACP 模式参数会握手超时）
wemind brain switch opencode --worker   # 设默认任务大脑（本次运行内一直生效，不写 brain.json）
wemind brain handoff # 生成交接摘要（供切走后第一条消息带上）
wemind session list  # 会话列表（daemon 不在也能读，只是按「下次会用的那个大脑」列）
wemind session new 周报 / resume 3 / rename 3 新名字 / delete 3
wemind task-list     # 任务列表（编号/agent/状态）；task-reply <n> "…"、task-stop [n|全部]
node packages/wechat-daemon/dist/cli.js brain   # 从源码跑等价命令
pwsh -NoProfile -File scripts/check-docs.ps1    # 检查 Markdown 相对链接
```

> 首次使用/环境不确定：先跑 [`scripts/doctor.ps1`](scripts/doctor.ps1)。

---

## 4. 不可违背的约束（改代码前必读）

1. **一个 token 一个消费者**：MCP 形态与 daemon 形态二选一；brain 的 MCP 沙箱永久禁止 `wechat`（防它把消息发回自己）。agent **自己的配置文件里**挂的微信 MCP 也在此约束内：DSH 的 `cordis.patch.yml` 复制进两个沙箱前会剔除这类条目并告警（真实文件不动，见 `stripWechatMcpEntries`）。
2. **ACP 是最小方法集，不是「所有 agent 都一样」**：
   - `session/load` 不是通用能力；DSH 只有 `session/resume`，缺失时会退化为 `session/new`；
   - **image / restore(load|resume) / mcpViaAcp 目前来自「agent 配置字段」，不来自 `initialize` 回包**：`acp-brain.ts` 发出 `initialize` 后只置 `initialized = true`，**从不解析** `agentCapabilities`。所以接新 agent 时必须人工读一次 `initialize`（`scripts/acp-probe.mjs`）并把结论写进 `brain-agents.ts` 的 agent；不要以为代码会自动适配；
   - agent 可能发反向请求（`session/request_permission`、`fs/*`、`terminal/*`）。`acp-brain.ts` / `worker-acp.ts` 已内置应答器：权限请求默认拒绝，未知 method 回 `-32601`；可信部署可设 `WEMIND_ACP_AUTO_ALLOW=1` 放行一次性权限。
3. **brain 是一个 ACP 进程、worker 是 N 个（进程池）**：协议改动要同步 `acp-brain.ts` 和 `worker-acp.ts`（后者已类化，别再把状态写在模块级）。
4. **MCP 按 agent 分派**：kiro 读 `settings/mcp.json`；opencode 读 `opencode.json` 的 `mcp.servers`；DSH 走 ACP `session/new` 的 `mcpServers`。**不要让 A 读 B 的配置文件**。
5. **微信有连发上限（约 10 条）**：进度消息会占额度；`index.ts` 的 15s 心跳在「无 activity 帧」时会持续发，接入 committed-only agent 要单独处理。
6. **Windows `.cmd`/`.bat` 必须经 shell**：统一用 `spawnAgent()`，不要直接 `spawn(bin,args,{shell:true})`（DEP0190 + 注入面）。
7. **数据按账号隔离**：默认 `~/.wemind/<账号>/`；不要跨账号共用 `brain-sessions.json` / `brain-home`。**一个账号一个 daemon、各有自己的「登录者」**（扫码登录它的那个微信号；不是「主号」，账号之间没有任何隶属关系）：换大脑是**账号级**的，微信侧只有该账号的登录者能切**它自己**那个 daemon，本机 CLI 可用 `key|label` 指定任意账号（范围/限制/两入口区别见 README「多账号管理」与 `docs/repowiki/06`）。
8. **切换大脑写入磁盘用 `wemind brain set`**；环境变量 `WEMIND_BRAIN*` 是一次性覆盖，不要写进 profile。
9. **不要把密钥写进 agent/源码**；`DEEPSEEK_API_KEY` 等由 daemon 进程环境提供。
10. **注释按段落换行，不按行宽折行**：一段一行（多长都不手工断开，编辑器/阅读器自己折行），只有语义上属于不同段落时才另起一行；列表项 / 标题 / 代码围栏 / 分隔线 / 用法表 / 独立命令行各自成行，「标签：内容」行（`用法：` / `退出码：` / `注意：`）另起一行。缩进保留原样——它表达层级，不是折行标记。`oxfmt` 不重排注释，所以别把英文注释按 120 列折回来。
11. **控制桥只接受「agent 名 + 纯数据」**：`control-bridge.ts` 的请求字段只有 `target`（agent 名）/`ref`/`name`/`text`/`taskId`/`page`，**没有也不可能有 `bin`/`args`/`shell`**——伪造请求最坏只能「选一个已装的 agent 或清掉自己的会话」，绝不能让 daemon 执行任意程序。`wemind brain set` 带 `--bin/--args/--extra-args/--shell/--model` 时**不走桥**（只写入磁盘；其中 `--bin`/`--args`/`--extra-args`/`--model` 可用随后的 `wemind brain switch <同名 agent>` 当场应用——`sameAgent()` 按 name/bin/args/model 判「是不是同一个」；`--shell` 不在判据里，只能重启 daemon），这是刻意的边界，不要为了「顺手当场应用」把它拆掉。
12. **「当前是哪个会话」的唯一权威是 `brain-sessions.json`（当前会话表）**：`session-registry.json` 只是**派生元数据**（名字/标题/轮次），坏了最多导致列表空——它的写失败只许记日志，**不得**抛出拖垮回合；`恢复会话` 是**严格恢复**：load/resume 都失败就如实报错、**不回退新建、不改当前会话记录**（宁可报错，也不要「假恢复」）。
13. **任务侧的两条持久化纪律**：① 结束**在等你回复**的任务时进程**留着复用**（不杀，空闲回收交给池）；**正在跑**的那条被结束时只能力杀（ACP 回合没法优雅取消），`wemind stop`/daemon 退出则杀光整池。② 任务表 `tasks.json` 只用来做「重启后续跑」——**不自动 spawn**（重启后不主动拉起 3 个 agent）、**不做历史归档**（微信聊天记录本身就是归档）；未完成的标「已中断」，用户回「继续」才续跑。切换大脑时**持久化放最后**（成功才写 `brain.json`）：这样失败退回无需撤销。
14. **优先「用」agent，而不是「改造」它**：WeMind 是**调用方**——模型、MCP、权限、会话、技能这些能力优先直接用 agent 自己的配置与接口（ACP 方法如 `session/set_config_option` / `mcpServers`、CLI 参数、它自己的配置文件），WeMind 只负责选择、传值与编排，**不替 agent 合成或重写配置**来改变它的行为。遇到「agent 的默认不符合需求」：先找它自己提供的开关（文档 / `initialize` / `session/new` 的 `configOptions`）；确实没有，才写适配层，并在代码与文档里写清「为什么不直接用它的」「补的是它的哪个缺口」。判断标准：**我们是在调用一个已有能力，还是在替它发明一个？** 沙箱（`BRAIN_HOME`/`WORKER_HOME`）是**隔离**手段（每账号一份可丢弃的 home、brain/worker 各自的 MCP 视图、微信会话不污染日常会话库），**不是**用来造配置的——镜像真实配置时按原样复制。**注意别把这条读成「什么都别动」**：MCP 视图（brain 默认空 + 按需加载，worker 全量但**永远排除 `wechat`**）是**安全边界**、不是改造 agent——`wechat` 永久禁止进大脑沙箱（一个 token 一个消费者，防回环，见 §4.1），这条不因「用 agent 原样配置」而放松（DSH 的 profile 副本会剔除用户自己挂的微信 MCP 条目——只剔这一种，其余原样保留）；同理，凭据只同步副本、不写进 agent 源码这些纪律都照旧。
15. **改代码必须同一次改完三件套：代码 + 测试 + 文档**。任何行为 / 接口 / 命令 / 参数 / 环境变量 / 配置字段 / 数据文件结构 / 日志文案的变化，都在**同一个提交**里补齐，不接受「先合代码、文档以后补」「测试回头加」：
    - **测试**：新增或改变逻辑要有对应用例（正常路径 + 失败/边界路径）；改了既有语义就同步改断言，不许用「旧用例本来就不准」跳过；至少 `npm test` 全绿。
    - **文档**（按读者找全，漏一个都算文档与代码不一致）：
      - 面向用户：`README.md`、`docs/新手教程.md`、`packages/*/README.md`（`packages/wechat-daemon/README.md` 会随 npm 包发布，**改了 CLI/环境变量必须同步**）、`docs/使用指南-*.md`、`docs/速查-*.md`；
      - 技术细节：`docs/repowiki/*`、`docs/接入-*.md`（各 agent 的实测结论）；
      - AI 上下文：本文件 `AGENTS.md`、`docs/ai/README.md`、`docs/ai/recipes/*`——**命令 / 参数 / 环境变量 / 数据文件 / 目录结构 / 新增模块的变化，AGENTS.md 与 `docs/ai/README.md` 是硬性同步项**（它们标注的「适用版本 / 最后核对」也要跟着改）。
    - **自检**：`npm run typecheck` + `npm test` + `npm run lint` + `pwsh -NoProfile -File scripts/check-docs.ps1`（相对链接不许断）。
    - 反例（都按缺陷处理）：改了命令参数没更新 `--help`/README；新增环境变量只写在代码注释里；改了优先级规则但 `docs/接入其它-ACP-Agent.md` 的表还是旧的；改了行为却没有一条能覆盖它的测试。

---

## 5. 「改哪里」速查

| 任务 | 从这里开始 |
|---|---|
| 新增 ACP agent | `brain-agents.ts` 的 `ACP_AGENT_PRESETS`；按 [`docs/ai/recipes/add-acp-agent.md`](docs/ai/recipes/add-acp-agent.md) |
| 改**默认模型 / 模型跟随日常 dsh** | `brain-agents.ts` 的 `realProfile` + `profile-model.ts`（读真实 profile 的默认模型——优先 `- id: acp`，否则 `agent-default-model`）+ 两个沙箱的 `syncProfilePatch`（**原样复制** `profiles/<名>/cordis.patch.yml`；缺 `- id: acp` 只提示、不代改） |
| 改 ACP 协议/自愈/超时 | `acp-brain.ts` + `worker-acp.ts`（两边同步） |
| 改**热切换**（等在途回合结束/启动新大脑/回滚） | `brain-switch.ts` + `acp-brain.ts`（`beginSwitch/drainTurn/warmup`）；答复在 `index.ts` 的 `AI`/`切换大脑` 分支 |
| 改**多任务/进程池/编号** | `worker-pool.ts`（策略纯函数 `planAcquire/planReap`）+ `worker-acp.ts`（`WorkerConn`）+ `task-manager.ts` + `task-store.ts` |
| 改**会话管理** | `session-manager.ts`（操作层）+ `session-registry.ts`（登记表）；`acp-brain.ts` 的 `resumeSession` 是严格恢复 |
| 改**交接** | `handoff.ts`（写入磁盘/带上/消费）+ `index.ts` 的 workerLoop 前缀带上 |
| 改**CLI 与微信的对等** | `control-bridge.ts`（协议）+ `index.ts` 的 `handleControlRequest` + `manage.ts`（CLI 侧） |
| 改命令/帮助 | `chat-commands.ts`（**同表驱动解析与帮助**，改一处两处都变） |
| 加/改 MCP 挂载 | `mcp-sandbox.ts` / `agent-mcp.ts` / `worker-sandbox.ts`；按 [`docs/ai/recipes/add-mcp.md`](docs/ai/recipes/add-mcp.md) |
| 改微信消息处理/回复 | `index.ts`、`md-reply.ts`、`image-reply.ts` |
| 加 CLI 子命令 | `cli.ts`（注册）+ `manage.ts`（实现） |
| 改数据目录/账号 | `wechat-ilink-core/src/store/*`、`brain-config.ts` |
| 排查 daemon 不回复 | [`docs/ai/recipes/debug-daemon.md`](docs/ai/recipes/debug-daemon.md) |
| 跑端到端验收 | [`docs/ai/recipes/run-e2e.md`](docs/ai/recipes/run-e2e.md) |

---

## 6. 已知坑 / 文档与代码不一致（2026-10-24 已核对）

- **默认大脑不是 kiro**：未配置时是 `auto`，按 `kiro → opencode → gemini → deepseek → qoder → cline` 探测；写入磁盘配置在 `<数据目录>/brain.json`。
- **`wemind list` 的 `agent=` 是「实际生效」而不是「配置文件」**（2026-10-31 修）：daemon 在跑时优先读 `<数据目录>/brain-runtime.json`（启动成功/热切换成功后写入，含 `source`），与 `brain.json` 不同时显示 `X（运行，来源 env；配置 Y）`；daemon 没跑时仍只显示配置/自动探测。**不能拿 `brain.pid` 判断刚启动时用哪个大脑**——ACP 是懒启动，第一条消息之前根本没有 `brain.pid`；这正是 `WEMIND_BRAIN=cline` 启动却显示 deepseek 的原因。`stop` 会删 `brain-runtime.json`。
- **内置预设 8 个，`auto` 只探测其中 6 个原生 ACP**：8 个里**已实测的有 kiro / opencode / deepseek / qoder / cline**；`gemini` 与两个需第三方适配器的示例预设 `claude-code`（`npx -y @agentclientprotocol/claude-agent-acp`；旧包 `@zed-industries/claude-code-acp` 已弃用，新包 **Node ≥22**）/ `codex`（社区 `codex-acp`）均**未实测**。两个适配器还**不在 `AUTO_PROBE_ORDER`**（`npx` 几乎总在 PATH 上，参与探测会把它们误选出来），要显式选用：`wemind brain set|switch <agent 名>`、一次性的 `WEMIND_BRAIN=<agent 名>`，或微信「切换大脑 <agent 名>」。完整表见 [`docs/接入其它-ACP-Agent.md`](docs/接入其它-ACP-Agent.md) §5。
- **DeepSeek 已内置 agent**：官方 DSH `dsh --profile acp`；桌面端通常要用 `wemind brain set deepseek --bin "<...>\dsh.cmd"` 落绝对路径，并依赖 `DSH_HOME` 沙箱里的 `.credentials.yaml`（从 `~/.dsh` 同步）。微信 brain/worker E2E、动态 MCP（`mcpViaAcp`）、记忆/技能继承均已验证。详见 [`docs/接入-DeepSeek.md`](docs/接入-DeepSeek.md)。
- **「无需改代码」有边界**：只对满足「有 `session/load`、不发反向请求、首帧快、MCP 走配置文件」的 agent 成立。DSH 不满足，但已用 agent 配置字段 + M2 适配补齐。
- **仓库没有 `Brain` 接口（当前建议）**：ACP agent 本身就是大脑边界；目前只有 ACP 一种实现，当前建议先不抽接口，避免增加间接层。等真的要做「裸 API 大脑」时再抽 `ask/newSession/restart` 契约，并同步 `index.ts` 调用方。
- **会话映射按大脑分开存**：`brain-sessions.json` 键为 `<agent>:<userId>`、`worker-sessions.json` 为 `<agent>:task`；换大脑不会再拿旧 agent 的 sessionId 去 `session/load`（Qoder 回 `-32602 INVALID_SESSION_IDENTIFIER`，DSH 回 `-32601`），切回原大脑仍能恢复上下文。旧格式（裸 `userId` / `task`）首次读取时自动迁移并回写（`session-map.ts`）。
- **`wemind brain check` 默认 60s**：冷启动慢的 agent 仍可能误报；这是已知项，不要把它当「agent 不可用」的唯一证据。
- **`onPath()` 按精确文件名**：只有 `dsh.cmd` 没有无扩展名 `dsh` 时，`binWin` 必须写 `dsh.cmd`。
- **DSH 0.2.1-rc.2 实测**：无 `session/load`（`-32601`）、`image:false`（带图 `-32602`）、有 `session/resume`；**resume 后多轮上下文保留**（PINEAPPLE，含 `taskkill /T /F` 强杀）；stdio/HTTP MCP 可用；会发 `agent_thought_chunk`/`tool_call`/`usage_update`；stdout 会混入非 JSON 日志行（解析器要容错）。
- **Qoder 已内置 agent**：`qoder` → `qodercli --acp --yolo`（**直接起本体**，不要用 `qoder` 分发器，它多套一层 `cmd → powershell`）；`QODER_CONFIG_DIR` 指向沙箱，登录态要同时同步 `.auth/user` + `.auth/machine_id`（缺一个就 `Authentication required`）；`~/.qoder` 与 Qoder Desktop 共用，沙箱设置由 `settingsBase` 复制（剥离 `providers`/`model`，防 BYOK 明文密钥进沙箱）；`memory/` 以 junction 与日常使用共享，`skills/agents/commands`/`AGENTS.md` 在 1.1.78 不存在（空操作）。M0–M3 已验证（含发图、动态 MCP、worker 中断续跑、冷重启 `session/load`）。详见 [`docs/接入-Qoder.md`](docs/接入-Qoder.md)。
- **Cline 已内置 agent（原生 ACP，3.0.74 实测；`cline-acp` 适配器已归档，官方让直接用 `cline --acp`）**：`CLINE_DIR` / `CLINE_DATA_DIR` / `CLINE_MCP_SETTINGS_PATH` 都指到沙箱的 `cline/` 子目录（不用沙箱根：大脑 cwd 就是沙箱根），`configSubdir: "cline"`、`mcpConfigFile: "mcp.json"`、`catalogFile: "data/settings/cline_mcp_settings.json"`（`{mcpServers}`，与 kiro 同格式）。`providers.json` 登录态 + `models.json` 模型目录同步（**缺后者时 `session/new` 会回退 `gpt-4o`**，自定义 provider 下 prompt 直接报错——2026-10-31 真机修复）。**认证是硬前置**：ACP 的 `isSessionReady` 只恢复它自己的 3 种登录（`cline` / `cline-pass` / `openai-codex`，从 `data/settings/providers.json` 读）；自定义/API-key provider（如 `openai-compatible`）**不会**被 `lastUsedProvider` 选中——WeMind 的 `credentialEnv`（`clineCredentialEnv()`）在 spawn 前从 `providers.json` 派生 `CLINE_PROVIDER` + `CLINE_API_KEY`（只认 `lastUsedProvider` 且有非空 `apiKey`；父进程显式设了任一变量就完全不接管）。OAuth 条目/文件不可用时才需要手工 env，否则 `session/new` 报 `-32000 Authentication required`（`wemind brain check` 与微信失败回复都会给提示，见 `authHint()`）。Cline **不使用** ACP `session/new.mcpServers`（只存不用）→ `mcpViaAcp: false`；`loadSession` 可用、硬杀后 `session/load` 能接回上下文；**图片 ❌**（广告 `image:true`，但 ACP `prompt` 的 `de()` 只保留 text 块 → 预设 `images:false`，daemon 友好拒绝）；`session/close` 未实现（`-32601`，WeMind 不调用）。详见 [`docs/接入-Cline.md`](docs/接入-Cline.md)。
- **内置预设默认免审批（2026-10-30）**：8 个预设各自用 agent 自己的机制，**不要**给它们加统一的 `--yolo` 之类 flag 来「顺手统一」——适配器类（claude-code / codex）根本不解析 CLI 参数。现状：kiro `acp --trust-all-tools`（v2 引擎；**kiro CLI 3.0 若把 `acp` 默认切到 v3，这批 v2-only flag 会被拒绝启动**，v3 的正解是 `session/new` 带 `_meta.kiro.policyPreset: ["allow-all"]`，届时再改，别提前发）；gemini `--acp --approval-mode yolo --skip-trust`（目录未信任会把 yolo 静默降回 default）；qoder `--acp --yolo`；cline `--acp --auto-approve true`；opencode 在沙箱 `opencode.json` 里写 `"permission": "allow"`（`opencode acp` **不接受** `--auto`，官方 issue #52216；用户自己配了 `permission` 就保留用户的）；DSH 预设 `envDefaults: { DSH_PERMISSION_MODE: "danger-full-access" }`（官方 bundle 的默认值来源，文档正文未收录，升级后可能失效——失效时退回 workspace-write，只影响越界写）；claude-code / codex 由 `session/set_mode` 在会话建立/恢复后切模式（`bypassPermissions` / `agent-full-access`；codex 另有 `INITIAL_AGENT_MODE` 兜底），调用失败只记日志、不拖垮会话。**审批类 env 用 `envDefaults` 不是 `env`**：父进程已设同名变量时保留父进程的值（部署方可收紧权限），日志 `env defaults kept from parent: …`；`WEMIND_ACP_SESSION_MODE=0/false/off` 关闭 `session/set_mode`，其它非空值 = 覆盖 modeId。`applySessionMode` 会核对会话回包的 `modes.availableModes`（不含目标模式就跳过并记日志，如 claude-code 以 root 跑且没设 `IS_SANDBOX=1`），brain 与 worker 各一份实现（改要同步）。宿主应答器**仍默认拒绝** `session/request_permission`（边缘 ask 规则、MCP 工具审批才会触发），`WEMIND_ACP_AUTO_ALLOW=1` 才逐次放行——「免审批」是 agent 侧默认，不是把宿主改成默认放行。
- **codex 预设：`binWin` 已按 npm shim 改成 `codex-acp.cmd` + `shell: true`**（2026-10-30）：`npm i -g @agentclientprotocol/codex-acp` 在 Windows 上产出 `codex-acp.cmd`，`onPath()` 按精确文件名判定，所以预设必须写 `.cmd`（配 `shell: true`，走 `spawnAgent()`）。用 standalone 二进制的用户 `wemind brain set codex --bin "<绝对路径>"`。仍未实测，换发行方式前先核对上游。
- **DSH 模型：跟着你自己的 profile 走（2026-10-29 核实到根因，别改源码）**：`dsh --profile acp` 的 ACP 桥插件（`@deepseek-ai/dsh-acp`）默认模型写死在它**自己的 bundle patch** 里——`app.asar` 内 `@deepseek-ai/dsh-acp-app/cordis.patch.yml` 的 `- id: acp` 带 `config: {provider: deepseek-official, model: deepseek-v4-flash}`（该路由要 `DEEPSEEK_API_KEY`，一 prompt 就 `no API key`）；而 profile 用户层只覆盖 `llm-pi-ai` / `agent-default-model` / `web-search-deepseek`，**`- id: acp` 要靠用户自己补**（插件 README 原话：a later patch can replace that row's complete config）——这才是「配置组合出 magpie、`session/new` 仍报 deepseek-official」的原因。**WeMind 的纪律是「用 agent，不改造它」（§4.14）**：两个沙箱把真实 `~/.dsh/profiles/acp/cordis.patch.yml`（桌面端维护的 provider 目录/默认模型）**原样复制**进来、不追加任何条目；这份文件里没有 `- id: acp` 时，`wemind brain` 会直接给出可粘贴的片段、让你补到**真实 profile**（补完终端 `dsh` 与微信大脑才是同一个模型；实测有这条时沙箱副本同样带它，`session/new` 的 currentValue 直接是 `["magpie","auto/deepseek-v4.1-flash"]`、prompt 正常、`resume` 保持）。`profile-model.ts` 读默认模型时**优先 `- id: acp`、否则 `agent-default-model`**，WeMind 按这个值在会话建立后发一次 `session/set_config_option`（agent 自己的 ACP 接口；幂等，显式 `--model` 覆盖也走它）；预设仍带 `realProfile: "acp"` 负责「同步 + 读默认」。显式覆盖：`wemind brain set deepseek --model '…'`（或 `presets.deepseek.model`）；`--model auto`/`default` = 跟随真实 profile 的默认（读不到就不下发）；完全没写 `model` 且读不到时才回退 `deepseek-account/deepseek-flash`。**magpie 走桌面端本机网关 `127.0.0.1:3425`，桌面端（DeepSeek Harness）要在运行**——和日常 dsh 用 magpie 的前提一样。`--model` 只写盘：daemon 在跑时用 `wemind brain switch deepseek`（或微信「切换大脑」）应用——`sameAgent` 已把 model 纳入判据，会重启 ACP 子进程并重设模型（不重启 daemon）；不 switch 就重启 daemon。
- **节点版本**：仓库声明 Node ≥20；DSH CLI 需要 ≥22（本机 Node 24 可用）。
- **发布相关（2026-10-30 核对，`1.2.0` 已发布）**：包已发布为 `@wemind/cli`（命令 `wemind`）；**包名 ≠ 命令名**，`npx` 只能写 `npx -y @wemind/cli`。**版本号单一来源**：只改 `packages/wechat-daemon/package.json`（`src/version.ts` 运行时读它，勿手写常量），升版本用 `npm run release:patch|minor|major`（= `npm version -w @wemind/cli --no-git-tag-version` + `check:version` 自检）；`npm publish` **不会**自动 build，发前必须 `npm run build`。进程身份特征是**三组**进程特征串（`wemind`+`cli.js`、`wechat-daemon`+`dist`+`cli.js`、`run-daemon.ps1`）：第二组专为「在仓库根用**相对路径**手跑」（`node packages/wechat-daemon/dist/cli.js …`，本节 §3 教的写法）而加——只有 `wemind`+`cli.js` 时，相对路径的命令行里既没有仓库名也没有包名，`isOurProcess()` 会判否，表现为 **daemon 明明活着、CLI 却显示「未运行」且控制桥拒绝发送**（2026-10-28 修）。本地 `npm test` 计数受 `.agents/` worktree 副本干扰已由 `vitest.config.ts` 排除。详见 [`docs/发布-wemind-npm.md`](docs/发布-wemind-npm.md)。
- **升级 CLI 后要先重启 daemon（2026-10-28）**：新 CLI 的热切换/会话/任务命令都要 daemon 认识控制桥，凭据是 `<数据目录>/control-out/.bridge`（内容 = daemon 自己的 pid）。对**旧版** daemon：**必须由 daemon 执行的写命令**（`session new`/`resume`、`brain switch|worker|handoff`）会在**发出前**就拒绝并提示「`wemind stop <key> && wemind start <key>`」；**本来就是文件操作**的 `session rename`/`delete` 照常直接改登记表（不加说明行），`session list` 则直接读登记表并附一行「按下次会用的那个大脑列」的说明，`task-list`/`task-status` 从来不经过控制桥（读 `tasks.json`，只在 daemon 没跑时注明是上次记录）。改完 daemon 侧代码别忘了 `npm run build` 再重启。
- **`WEMIND_BRAIN` 压过命令式切换（2026-10-28）**：环境变量优先级高于 `brain.json`，所以 `wemind brain switch X` 在**当前进程**里生效并写入磁盘，但重启后若 `WEMIND_BRAIN` 还在，会回到 env 指的大脑——答复里有警告，别把 env 写进 profile（§4.8）。
- **切脑与 `wemind stop` 的窄窗口（2026-10-28，已知项）**：切换的 `restart()` 与新进程写 pid 记录之间约 1s，此刻执行 `wemind stop` 可能漏杀新起的 ACP 子进程（与既有的 `/加载` 触发 `restart()` 同类形态，不是本次新引入）。
- **多任务共享同一份微信额度（2026-10-28）**：连发上限（约 10 条）是**按用户**计的，N 条任务的进度 + 对话大脑的回复都算同一份额度。worker 进度默认安静、结果推送走既有 ret=-2 退避；扛不住就调小 `WEMIND_MAX_WORKERS`。
- **同 agent 并发 = 两个终端在同一个配置目录里跑（2026-10-28，2026-10-29 一轮复测）**：不同 agent 各有 `configSubdir` 天然隔离；同一 agent 的两个 worker 进程共用其配置目录——opencode 两条并发一轮样本内**未见互踩**，长期风险仍在。
- **provider 报错的任务不抢消息（2026-10-29）**：任务是「waiting 就接管下一条无编号消息」（谁在等就喂谁），所以一条**余额不足**的任务会一直吞掉用户的日常消息、每次白失败一轮（真机踩过：它把「在吗」吃掉了）。现在 `task-manager.ts` 的 `providerIssue()` 认出模型/账号侧错误（额度/余额、密钥鉴权、计费、模型不存在）→ 该任务**直接转「已中断」**（`interrupted` 不在 `liveTasks` 里，路由自然放行）→ 账号修好后回「继续」/`#n 继续` 续跑。判据是关键字表（错误措辞来自各 agent 的 provider、不统一），**限流优先不归类**（先查 429/rate limit/overloaded 再查账号关键字：Google 的按分钟 429 原文就写着「Quota exceeded … requests per minute」，顺序反了会把限流误判成额度问题）；**认不出的一律按老规矩停在「等你回复」**——宁可多抢一次，也不把偶发失败误判成账号问题。改这里的判据别顺手放宽。
- **大脑侧的 provider 报错也只试一次（2026-10-29）**：agent 会把 provider 的一切回合失败都包成 `-32603 … turn failed: …`，所以余额不足这类**永久**错误按协议错误码看就是「后端瞬时错误」——老口径重试 3 次（每次都要冷启动一个 agent 进程），最后丢给用户一句「稍后把消息再发一次」。现在 `index.ts` 的 `brainFailurePlan()` 先过与任务侧**同一张** `providerIssue()` 关键字表：认出额度/余额、密钥鉴权、计费、模型不存在 → **只试 1 次**，并直接把原因回复给用户（「（这次没答上来：额度/余额不足。这类问题重试不会好——把账号/模型处理好后把消息再发一次就行）」）；「密钥/鉴权」「模型不可用」两类再加一句**要重启一次 daemon** 才会读到新登录态/模型（运行中的 daemon 不重读 brain.json、不重新同步凭据）；**限流优先仍按 backend 重试 3 次**（判据顺序别改）。日志行 `brain error (try 1, provider：额度/余额不足)`。
- **VS Code 集成终端里 `wemind start` 会「假启动」（2026-10-29 修）**：VS Code 的「智能自动附加」给终端里每个 node 注入 `NODE_OPTIONS=--require <…>/ms-vscode.js-debug/bootloader.js` + `VSCODE_INSPECTOR_OPTIONS`（`deferredMode:true`），被注入的进程要**等调试器接上才执行主脚本**；终端里的前台命令会被接上（`stop`/`list` 看着一切正常），但 `start` **脱离出去的后台守护进程不会被接** → 进程活着、一行 JS 不跑：答复说「已启动」，实际 `daemon.log` / `wrapper.pid` 不更新、daemon 没起（`wemind list` 显示未运行，进程表里只有一个没有子进程的 `cli.js _watchdog`）。现在 `watchdog-runner.ts` 的两次脱离式 spawn 都过 `debug-env.ts` 的 `stripVscodeDebugEnv()`：只摘 VS Code 自己那段 `--require`，用户其它 `NODE_OPTIONS` 原样保留。同一注入也是「本机跑测试偶发超时」的原因——测试用 `NODE_OPTIONS=` 前缀跑。
- **权限口径（2026-10-29 统一，平台事实已确认）**：**必须扫码登录该 bot 才能给它发消息**（微信平台限制），所以每个 bot 只有它的**登录者**（扫码登录它的那个微信号）能发。文档一律用「**登录者**」与「**登录者白名单**（`allowFrom`，**默认拒绝**；它是**兜底校验**，正常只含登录者一个 userId，防发送范围变化/别的入口）」，作用范围写成「**整个账号（仅登录者）**」/「**登录者的会话**」/「**登录者的任务**」；**禁用**「账号本人 / 授权用户 / **主号 / 主账号**」——「主号」会被读成「多个微信账号之间有一个有权限的主号」，`label` 只是别名（示例统一用 `工作号`）。**一个微信账号 = 一个真人、一个 daemon**：微信侧换大脑只能由该账号的登录者切**它自己**那个（`OWNER_ONLY_KINDS`），本机 CLI 才能用 `key|label` 指定任意账号（范围/限制/两入口区别见 README「多账号管理」与 `docs/repowiki/06`「多账号下的范围、两个入口」）。
- **重启后旧 `context_token` 期间的外发要挂起（2026-10-29 修）**：`state.contextTokens` 从磁盘恢复，daemon 重启后仍是上次运行留下的 token；该用户发来下一条消息之前，任务结果（`setTaskPush`）与 CLI 指令答复（`sendNotice`）必然 `ret=-2 (prepare failed)`，`reply()` 重试仍是同一个旧 token（修复前**静默丢失**，真机复现：任务跑完只在 `任务列表` 里看得到）。现在这类「必须送达」的外发**只在该用户本进程还没发过消息时**（`freshTokenUsers`）失败才挂进 `pending-push.ts` 的内存队列（每人 20 条、超出丢最旧）；该用户下一条消息一到，poller 等这一批消息的计数重置**全部做完**后补发（每个发件人一次）：按入队顺序、计入连发额度、每轮最多 5 条且不越过本回合留给答复的额度，排在该批消息触发的进度/答案之前；重置计数改按「还没发完的条数」（`inflightSends`）算、不清零——否则排队中的发送会把最终答案挤到限流上。补发失败（任何原因）重新挂起，同一条最多 3 次。本进程收到过该用户消息之后，`-2` 按限流处理、不挂起；回合内的普通回复不挂起。队列不跨重启（任务结果仍在 `tasks.json`）。日志关键词「`send -2（旧 token）→ 挂起`」「`新 token 已到 → 补发挂起消息`」「`补发 N 次仍失败 → 重新挂起`」「`放弃这条挂起的推送`」。
- **原「待实测」清单已批量实测（2026-10-29，结论见 [`docs/ai/recipes/run-e2e.md`](docs/ai/recipes/run-e2e.md) §7.3）**：① `session/delete` opencode/qoder 有、DSH 无（`-32601`）；② `session/load` 回放 opencode 2 帧/857ms、qoder 3 帧/804ms，DSH `resume` 0 帧/195ms；③ 冷启动 `initialize`/`session/new`：DSH 5.8s/50ms、opencode ~650ms/~800ms、qoder 1.7s/1.5s——均远小于 `REQ_TIMEOUT=30s`，暂不加 `reqTimeoutMs`；④ opencode+qoder 两条任务并行结果都送达，未见限流型 `ret=-2`；⑥ 同 agent 并发一轮样本未见互踩（见本节「同 agent 并发」条）；⑦ 强杀后 DSH（`resume`）/opencode（`load`）能接回原任务会话，qoder 任务续跑未单独测。
- **仍未单独测（2026-10-30）**：⑤ Windows `taskkill /T /F` 在 `session/load` 途中、以及**杀掉池中某个特定进程**时的行为。

---

## 7. 验证标准（别只看「代码写完」）

> 前提：**代码 + 测试 + 文档**在同一次改动里一起完成（§4.15）。下表是「代码对了」之后还要过的最低验证；文档类同步不满足这一条，就当作没做完。

| 改动 | 最低验证 |
|---|---|
| 纯逻辑 | `npm run typecheck` + `npm test` |
| agent 配置/沙箱 | `wemind brain` + `wemind brain check` + 单测 |
| **Cline** | `npm i -g cline`；`wemind brain set cline` 后 `wemind brain check`（OAuth 登录直接过；自定义 provider 由 `credentialEnv` 自动复用 `providers.json` 的 key，显式 env 优先）；`加载 <mcp>` 后看沙箱 `cline/mcp.json`；杀 daemon 再起，追问上下文仍在（`session/load`） |
| **模型跟随日常 agent**（DSH） | 真实 `~/.dsh/profiles/acp/cordis.patch.yml` 里有 `- id: acp`（`wemind brain` 会给可粘贴的片段）；沙箱那份与真实**逐字节一致**（WeMind 不追加）；`wemind brain`「生效」`model=` = 该文件里的值（优先 `- id: acp`，否则 `agent-default-model`）；桌面端改模型 → 重启 daemon 或 `wemind brain switch deepseek` 后跟着变（改过 `brain.json` 的显式 `model` 则不跟随） |
| ACP 协议 | 冒烟：`initialize → session/new → prompt → update`；重建后 `load/resume`；无未应答反向请求 |
| 消息/回复 | 真机微信一条消息 → `daemon.log` 出现 `prompt ok` → 收到回复 |
| MCP | `加载 <名>` → 下条消息生效；`wechat` 仍被禁止 |
| worker | 派发任务 → 中断 → 回「继续」→ 能续上 |
| **热切换大脑** | 真机 kiro↔opencode；启动新大脑期间发消息**只 spawn 一次**（看 log）；未知/不可用的 agent 被拒；故意坏 bin → 回滚 + 旧大脑继续答 + `brain.json` 未变 |
| **多任务并行** | `任务 kiro：…` + `任务 opencode：…` 同时跑且都出结果；第三条超上限被拒；结束「等你回复」的任务后进程留着复用、空闲 5 分钟后消失（`wemind list`/进程管理器验；结束「正在跑」的那条只能力杀）；`wemind stop` 一次杀光所有 worker |
| **任务中断续跑** | 跑到一半 `taskkill` daemon → 重启后 `任务列表` 显示「已中断」→ 回「继续」上下文确实接上；agent 不支持恢复时给诚实文案且编号连续 |
| **provider 报错不抢消息** | 派一条注定失败的任务（如 DSH 余额不足）→ 推送说「中断了（额度/余额不足）」且 `任务列表` 显示「已中断」→ 之后发一条**无编号**的普通消息要**走大脑**（不能再白喂给那条任务）→ **账号修好后**回「继续」能续跑（没修好时续跑只是又失败一轮、退回「已中断」，这是预期） |
| **重启后补发** | 重启 daemon → **不在微信发消息**、本地派一条任务 → 日志见「`send -2（旧 token）→ 挂起`」→ 微信发任意一条消息 → 日志「`新 token 已到 → 补发挂起消息 N 条`」且结果真的收到（旧 token 的 `-2` 不再静默丢） |
| **会话四件套** | 会话 A 塞暗号 → 新会话 → 列表 → 恢复 → 暗号回来；恢复不存在的 id → 失败且当前会话不变；删当前会话后下条消息开新的；会话与任务只见登录者自己的 |
| **交接** | 交接 → 切脑 → 问只靠旧上下文能答的问题 → 文件已消费、第二条不重复带上 |
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
- Cline 接入实测：[`docs/接入-Cline.md`](docs/接入-Cline.md)
- DeepSeek 后续待办（M3–M5）：[`docs/待办-DeepSeek-M3-M5.md`](docs/待办-DeepSeek-M3-M5.md)
- 任务编号语义与记录体积（暂缓）：[`docs/待办-任务编号与记录体积.md`](docs/待办-任务编号与记录体积.md)
- 机器可读索引：[`llms.txt`](llms.txt)

---

> **给 AI 的最后一句**：本仓库的文档总体质量高，但「通用 ACP 说法」不等于「当前 agent 的事实」。改 ACP 相关代码前，先用 `initialize` 看 capabilities，再用一次真实 prompt 验证，不要只信文档。
