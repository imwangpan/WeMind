# WeMind · AI 上下文包

> **适用版本**：WeMind 1.2.0 ｜ **最后核对**：2026-10-28（`@wemind/cli@1.1.1` 已发布，1.2.0 待发布；`@wemind/wechat-mcp@1.0.5` 已发布）
>
> 这是给 AI agent（以及赶时间的人）的**压缩上下文**。目标：用 5–10 分钟建立正确心智模型，然后按任务跳到代码/配方，而不是通读 11 篇 repowiki。
>
> 事实状态约定：**✅ 已实测**（有真机/测试证据）· **🟡 代码已实现但未在目标 agent 实测** · **⚪ 假设/待验证**。不要把小节里的「ACP 通用说法」当成当前 agent 的事实。

---

## 1. 五分钟心智模型

WeMind 只做一件事：**把个人微信的消息，变成某个 AI agent 的输入；把 agent 的输出，发回微信**。做法有两条互斥的路径：

```text
形态① MCP：
  Claude Desktop / Cursor / OpenCode / kiro …
        │  MCP (stdio)：get_messages / send_text_message / send_typing …
        ▼
  @wemind/wechat-mcp  ──►  @wemind/wechat-ilink-core  ──►  腾讯 iLink
  （客户端自己长轮询，自己决定什么时候回）

形态② daemon：
  微信 ──►  daemon（自己长轮询）
             ├─ brain：常驻 ACP agent（对话，每用户一个 session）
             └─ worker：常驻 ACP agent（任务，单 session，可「继续」）
           ──►  daemon 把回复发回微信
```

**为什么需要 daemon**：MCP 形态要求有 IDE/客户端一直开着并主动轮询；daemon 是无人值守的常驻进程，自带多轮记忆、远程任务、多账号。

**「大脑」是什么**：一个支持 ACP（Agent Client Protocol，JSON-RPC over stdio）的 agent CLI 子进程。daemon 通过 `initialize → session/new → session/load|resume → session/prompt → session/update` 驱动它。换大脑 = 换这个子进程怎么启动 + 它的配置目录/MCP 约定。

---

## 2. 三个 package，一条依赖方向

```text
wechat-ilink-core  ◄──  wechat-mcp      （tsdown 内联 core，发布单包）
        ▲
        └──────────────  wechat-daemon（发布为 @wemind/cli，命令 wemind；core 构建时内联）
```

| 包 | 路径 | 职责 | 发布 |
|---|---|---|---|
| `@wemind/wechat-ilink-core` | `packages/wechat-ilink-core` | iLink HTTP、类型、错误码、会话守卫、账号/状态、收发图加解密 | 私有（构建时内联进上面两个包） |
| `@wemind/wechat-mcp` | `packages/wechat-mcp` | 6 个 MCP 工具 | 已发布（bin `wemind-mcp`） |
| `@wemind/cli` | `packages/wechat-daemon` | daemon + ACP 大脑 + worker + CLI | 已发布（命令 `wemind`） |

依赖方向单向；消费方只依赖 core，mcp 与 daemon 互不耦合。**包名与命令名分离**：装 `@wemind/cli`，敲 `wemind`（`npx` 必须写全包名）。

---

## 3. daemon 一轮消息发生了什么

```text
poller（长轮询，不被大脑阻塞）
  → 收到消息 / 逐条入队（**不合并**：一条消息 = 一次 prompt）
  → 指令拦截（帮助 / 切脑 / 交接 / 会话四件套 / 任务 / MCP / 问大脑 …；
     账号级指令（切脑/交接）由非登录者发 → 短提示拒绝，不进大脑；兜底门，平台限制下正常不触发）
  → 选择 brain 或 worker（多任务时按编号寻址；无编号按 waiting > running > 唯一已中断）
  → askBrain(userId, text, onProgress, images)
       ├─ 等切换门（切换大脑进行中时有界等待）
       ├─ ensureProcess(ag)：懒启动 ACP agent，initialize
       ├─ ensureSession(ag, userId)：内存 session → 磁盘 map → load/resume → 否则 new
       ├─ 有交接摘要且目标大脑不是来源 → 作为本条消息的**前缀**注入
       ├─ session/prompt：文本（+ 图片）
       └─ session/update：拼 agent_message_chunk；tool/thought → 进度
  → 成功：写会话登记表（轮次+1/标题首写）、答成才消费交接摘要
  → md-reply / image-reply 处理长文与图片
  → send_text_message（受连续发送额度约束）
```

关键点：

- **每用户一个 brain session**，映射在 `<数据目录>/brain-sessions.json`（键 `<agent>:<userId>`，换大脑不丢各自上下文）——**这张指针表是「当前是哪个会话」的唯一权威**；`session-registry.json` 只是展示用的登记表（名字/标题/轮次），坏了不影响恢复；
- **worker 是 N 个独立 ACP 进程**（进程池，一条任务一条连接），任务会话在 `worker-sessions.json`（键 `<agent>:task-<编号>@<userId>`）；任务表另存 `tasks.json` 供**重启后续跑**（未完成的标「已中断」，回「继续」才续跑）；
- **切换大脑是进程内的**（`brain-switch.ts`）：预检 → 等回合 drain → 预热 → **成功才写 `brain.json`**；失败回滚、槽位留旧大脑；
- **自愈**：prompt 超时/失败 → `reset()` 杀进程树 → 下条消息重建并尝试恢复会话；
- **进度**：`tool_call` → 「步骤 N」；`agent_message_chunk` → 「正在整理回复」；任意 `session/update` → 刷新心跳基线；
- **连发上限**：iLink 约 10 条；`index.ts` 预留最后一条给最终答案，进度到第 8 条会暂停并提示「接近上限」；**多任务与对话大脑共享同一份额度**（按用户计）。

---

## 4. 术语表

| 术语 | 含义 |
|---|---|
| **ACP** | Agent Client Protocol，JSON-RPC 2.0 over stdio，每行一个 JSON；Zed 提出 |
| **brain** | 对话大脑，`acp-brain.ts`，每用户一个 session |
| **worker** | 远程任务执行器，`worker-acp.ts` 的 `class WorkerConn`，**一条任务一条连接**（进程池复用） |
| **agent 槽位（agent-slot）** | `agent-slot.ts`：`getAgent("brain"\|"worker")` 懒解析 + 记忆化；`setAgent` 供热切换改写（取代了模块常量） |
| **热切换 / brain-switch** | `brain-switch.ts`：预检 → drain（等回合结束）→ 预热 → **成功才落盘**；失败回滚 |
| **drain** | 切换/停止前「等在跑的回合自然结束」的门（默认 30s，超时=诚实失败，不砍回合） |
| **预热 / warmup** | 切脑时先把新 agent 起起来跑 `initialize` + 建会话，成功才对外宣布切换完成 |
| **会话指针表** | `brain-sessions.json`（键 `<agent>:<userId>`）——**「当前是哪个会话」的唯一权威** |
| **会话登记表** | `session-registry.json`：名字/标题/轮次/最近使用（派生元数据，坏了只导致列表空） |
| **strict 恢复** | `恢复会话` 的语义：`load`/`resume` 都失败就如实报错，**不回退 `new`、不改指针** |
| **交接 / handoff** | `handoff.ts`：摘要落盘（TTL 24h），切走后**下一条消息前缀注入**、**答成才消费**、切回来源不注入 |
| **任务编号** | 按用户单调递增、**不复用**、跨重启不归零；多任务并存时无编号消息必须消歧 |
| **默认任务大脑** | `worker.agent ?? agent`；`切换任务大脑`/`--worker` 可在进程内粘性覆盖（**不落盘**） |
| **进程池 / worker-pool** | `worker-pool.ts`：同 agent 空闲复用 → 回收最旧腾位 → spawn；并发 `WEMIND_MAX_WORKERS`、空闲 `WEMIND_IDLE_MAX`、回收 `WEMIND_WORKER_REAP_MS` |
| **控制桥 / control-bridge** | CLI ↔ daemon 的双向文件桥（`control-inbox/` → `control-out/`）：CLI 写的命令由 daemon 用**与微信同一段实现**执行并回话。**只收预设名与纯数据**（无 `bin`/`args`/`shell`） |
| **`.bridge` 凭据** | `control-out/.bridge` 记着 daemon 的 pid：对不上 = daemon 是**升级前的旧版本**，CLI 写命令发前拒绝、读命令降级 |
| **preset / 预设** | `ACP_AGENT_PRESETS` 里的一条：二进制、ACP 参数、配置目录变量、MCP 格式、记忆继承 |
| **BRAIN_HOME** | brain 的沙箱目录（默认 `<数据目录>/brain-home`），通过 `homeEnvVar` 传给 agent |
| **WORKER_HOME** | worker 的沙箱目录 |
| **configSubdir** | agent 配置目录相对沙箱根的子路径（kiro 空；opencode `opencode`） |
| **catalog** | 可选 MCP 的定义来源（按 agent 各自的配置文件读取） |
| **激活集** | 当前 brain 实际加载的 MCP 名单，存 `brain-mcps.json`；默认空 |
| **curated MCP** | 沙箱里由 WeMind 写入的 MCP 配置；`wechat` 永久禁止 |
| **session/load** | 按 sessionId 恢复会话；**不是所有 agent 都支持** |
| **session/resume** | DSH 的恢复方法；恢复持久会话，但不回放旧更新 |
| **反向请求** | agent 发给 client 的请求（`session/request_permission`、`fs/*`、`terminal/*`）；不应答会挂起 |
| **committed-only** | agent 只在消息提交后发正文（非逐 token），如 DSH 官方 ACP |
| **brain.json** | 账号级大脑选择，`<数据目录>/brain.json`；`wemind brain set` 写入 |
| **auto** | 未配置时的探测顺序：`kiro → opencode → gemini → deepseek → qoder` |

### 4.1 中英术语对照（写作口径）

**用法**：写文档/回答问题时用「推荐译法」；**英文原词只在首次出现时括注**（如「启动为子进程（spawn）」），之后不必重复。
**原则**：① 有公认中文译名且不产生歧义的，一律用中文；② 是缩写、字面值或生态专名的（`stdio`、`CLI`、`ACP`、`brain`），保留原文；③ 代码、命令、API 名**永远**不翻译。

#### A. 进程与 I/O（最常被译错的一组）

| 英文 | 推荐译法 | 详细说明（含义 · 为什么这样译 · 常见误译） |
|---|---|---|
| **spawn** | **启动（子进程）**；需强调父子关系时用「**派生**」 | 原义「产卵」，在操作系统语境是**创建并执行一个新进程**的通用说法（与 `fork`/`exec` 同族）。Node 里对应 `child_process.spawn()`：创建子进程、**立即执行**指定程序、把它的标准流交给父进程读写。<br>**为什么用「启动」**：中文技术语境里「启动一个进程/子进程」最自然、读者零成本理解；需要体现「它是我派生的、生命周期依附于我」时用「派生」。<br>**别译**：❌「生成」（与数据生成混淆）、❌「孵化」（无对应技术含义）、❌「唤起」（指唤醒休眠，不是创建）。 |
| **stdio** | **标准输入输出**（首次写全称，之后可保留 `stdio`） | `st`andar**d** **i**nput / **o**utput 的缩写，指进程自带的三个流：标准输入（stdin）、标准输出（stdout）、标准错误（stderr）。<br>**为什么保留原文**：它不是普通英文单词，而是 Node API 名（`spawn(..., { stdio: "inherit" })`）和 CLI 参数的字面值，翻译后反而无法对应代码。<br>**别译**：❌「标准IO」（半中半英，不如写全称）、❌「控制台输出」（错，`stdio` 不等于终端）。 |
| **stdin / stdout / stderr** | 标准输入 / 标准输出 / 标准错误 | 说明语境时用中文，引用代码/参数时保留原文（`stdio: ["ignore", logFd, logFd]`）。 |
| **CLI** | 指**程序**时译「**命令行工具**」；指**形态/界面**时译「**命令行界面**」 | command-line interface 的首字母缩写。<br>**判断方法**：能「安装、运行」（如 `wemind` 是 CLI）→ 命令行工具；说「相比 GUI」（图形界面）这种对比 → 命令行界面。中文技术写作里**保留 CLI** 也完全可接受，尤其 `kiro-cli`、`claude-code` 这类名字里的 CLI 绝不能翻。<br>**别译**：❌「客户端」（CLI 与 client 是两回事：`@wemind/cli` 是命令行工具，MCP 客户端才是 client）、❌「命令行程序包」。 |
| **daemon** | **守护进程** / 常驻进程 | 后台长期运行、无人值守的进程。本文也直接用 `daemon`（因为大量专名如 daemon 形态、`wechat-daemon` 目录依赖它）。 |
| **watchdog** | **看门狗** | 外层监督循环：子进程退出后自动重拉。本文有 `runWatchdog()`、`wrapper.pid`。<br>**别译**：❌「监视器」（过泛）。 |
| **wrapper** | **包装进程** / 外层 | 包在真正业务进程外面、负责保活/传参的那一层（`wrapper.pid`）。 |

#### B. 协议与协议实现（最容易混淆的一组）

| 英文 | 推荐译法 | 详细说明 |
|---|---|---|
| **ACP** | **ACP（Agent Client Protocol）** | 首次出现给全称，之后直接用 `ACP`。ACP 是**协议**：规定 client（WeMind daemon）与 agent 之间如何交换 JSON-RPC 消息。 |
| **protocol** | **协议**（规范） | ⚠️ **协议是可选的，实现是可变的**：`session/load` 在 ACP 里是**可选方法**，写「协议不支持 load」是错的，正确说法是「这个 agent 的实现没有提供 `session/load`」。 |
| **implementation** | **实现**（具体程序） | 一个程序对某协议的具体落地。同一协议的不同实现，完备度差别很大——这正是 WeMind 要给每个 agent 配 preset 的原因。 |
| **implement / support ACP** | **实现 ACP** / **支持 ACP** | **不要写「说 ACP」**。理由：「会说/不会说」是二元判断，会掩盖「实现完备度不同」这个事实（有的实现支持 load、有的只有 resume、有的不发流式帧）。而「实现/支持」天然可分级。<br>更精确时用可验证的事实：「它以 ACP server 身份响应 `initialize`/`session/new`/`session/prompt`」。 |
| **minimal method set** | **最小方法集** | WeMind 实际用到的 ACP 方法子集：`initialize` → `session/new` → `session/prompt` + 流式 `session/update`。缺任一即不可用。 |
| **capability** | **能力**（保留 `agentCapabilities` 原文） | 指「这个实现支持哪些**可选特性**」（load/resume/image/mcp），**不是权限**。别译「权限」——权限是 permission，见下条。注意：本仓库当前**不消费** `initialize` 回包，能力全部来自预设字段，见事实表。 |
| **permission** | **权限** | 与 capability 区分：`agentCapabilities` 是能力声明；`session/request_permission` 是运行时**请求授权**。 |
| **reverse request** | **反向请求** | ACP 的反向通道：**agent → client** 的请求（`session/request_permission`、`fs/read_text_file`、`terminal/create` 等）。与正常方向（client → agent）相反，故称「反向」。<br>⚠️ 关键：**不应答会挂起**。WeMind 内置应答器：权限默认拒绝、未知方法回 `-32601`。 |
| **streaming** | **流式** | agent 边生成边推送增量（`session/update` 的 `agent_message_chunk`），而不是一次性返回完整答案。 |
| **handshake** | **握手** | 连接建立时的协商：`initialize` 交换版本与 `agentCapabilities`。 |
| **session** | **会话** | 一段带上下文的多轮对话。ACP 里由 `session/new`（新建）、`session/load` / `session/resume`（恢复）管理。 |
| **handshake / probe** | **握手 / 探针** | 探针 = 主动探测能力的小脚本（本仓库 `scripts/acp-probe.mjs`、`wemind brain check`）。 |

#### C. WeMind 内部概念

| 英文 | 推荐译法 | 详细说明 |
|---|---|---|
| **brain** | **对话大脑** / `brain` | 常驻 ACP 进程，负责日常聊天问答（每用户一个 session）。因为大量代码/路径名含 brain，正文也直接写 `brain`。 |
| **worker** | **任务工作机** / `worker` | 独立 ACP 进程，跑漫长任务，单 session，可「继续」续跑。 |
| **preset** | **预设** | `ACP_AGENT_PRESETS` 里的一条配置：二进制、ACP 参数、配置目录变量、MCP 格式、记忆继承、能力覆盖等。 |
| **sandbox** | **沙箱** | 隔离目录（`BRAIN_HOME` / `WORKER_HOME`），让 agent 读到的是干净配置而非你的真实配置。 |
| **fallback / degrade** | **回退 / 降级（退化）** | 如「agent 缺 `session/load` 时**退化为** `session/new`（上下文丢失但能继续用）」。 |
| **activation set** | **激活集** | 当前 brain 实际加载的 MCP 名单（`brain-mcps.json`），默认空。 |
| **curated MCP** | **WeMind 写入的 MCP 配置** | 沙箱里由 WeMind 生成的 MCP 定义；`wechat` 永久禁止（防回环）。 |
| **committed-only** | **仅提交后发正文** | 指 agent 不逐 token 推流、只在生成完成后一次性发正文（如 DSH 官方 ACP），需靠心跳兜底。 |
| **idempotent** | **幂等** | 同一操作重复执行结果一致。 |
| **atomic write** | **原子写** | 先写临时文件再 `rename` 覆盖，避免写一半被读到半截 JSON。 |

#### D. 通用工程词（本项目高频）

| 英文 | 推荐译法 | 说明 |
|---|---|---|
| **agent** | `agent`（保留英文）或「智能体」 | 本文保留 `agent`：大量专名依赖它（ACP agent、brain agent、coding agent），翻译反而更绕。**注意「AI Agent」在本文有三重含义**（MCP 客户端 / ACP 大脑 / 编码助手），见根 README 的区分。 |
| **root cause / triage** | **根因 / 定位分类** | 排障时先说清属于哪层（poller / brain / worker / wrapper）。 |
| **regression** | **回归** | 已修好的问题又出现；CI 里也指「跑全部测试」。 |
| **provenance** | **来源证明** | npm 发布时的构建来源证明（`--provenance`），把包与某次 CI 构建绑定。 |
| **prepack** | `prepack`（保留，npm 生命周期名） | `npm pack`/`publish` 前自动执行的钩子；本项目用它跑产物守卫。 |
| **guard** | **守卫** | 如 `prepack-guard.mjs`：不满足条件就拒绝打包。 |
| **smoke test** | **冒烟测试** | 最小可用性验证（本仓库：真装 tarball 跑 `wemind version`）。 |

---

## 5. 事实状态表（先看这张，别被旧文档带偏）

| 事实 | 状态 | 证据/备注 |
|---|---|---|
| 默认大脑是 `auto`，不是固定 kiro | ✅ 代码 | `brain-agents.ts` `resolveAgent()` |
| kiro 预设可用 | ✅ 实测 | `docs/接入-OpenCode.md` / 现有 daemon |
| opencode 预设可用（`session/load`、无反向请求） | ✅ 实测 | `docs/接入-OpenCode.md` §3.3 |
| 任意兼容 ACP 的 agent 都「无需改代码」 | ⚪ **不成立** | 需要 load/resume、反向请求、首帧/心跳、image 能力适配 |
| `session/load` 是 ACP 通用能力 | ⚪ **不成立** | DSH 只有 `session/resume`；`load` 返回 `-32601` |
| 代码按 `initialize` 回包自动适配能力 | ⚪ **不成立** | `acp-brain.ts` / `worker-acp.ts` 发出 `initialize` 后只置 `initialized = true`，**不解析** `agentCapabilities`；image/restore/mcpViaAcp 全部来自 `brain-agents.ts` 预设字段 |
| 仓库存在 `Brain` 接口 | ⚪ **不存在** | `acp-brain.ts` 直接导出 `askBrain`/`newSession`/`restart` |
| `wemind brain check` 默认 60s | ✅ 代码 | 冷启动慢的 agent 仍可能误报 |
| `deepseek` 预设已内置 | ✅ 代码/实测 | `dsh.cmd` + `DSH_HOME` + `.credentials.yaml` + `model` + `resume` + `mcpViaAcp`（动态 MCP）；微信 brain/worker E2E、MCP（含微信侧全链路）、记忆/技能、图片友好拒绝均已验 |
| `qoder` 预设已内置 | ✅ 代码/实测 | `qodercli --acp --yolo` + `QODER_CONFIG_DIR` + `settingsBase`（剥离 providers/model）+ `.auth/user`/`.auth/machine_id`；M0–M3 全部已验：发图、动态 MCP、冷重启 `session/load`、worker 中断续跑、`memory/` junction 继承 |
| Qoder 沙箱 MCP 生效 | ✅ 实测 | 沙箱 `settings.json.mcpServers` 可被真实调用；项目级 `.mcp.json` 即使 `--yolo` 也不自动加载 |
| Qoder 可免 `--bin` 绝对路径 | ✅ 代码 | `fallbackBinPaths` 兜底 `~/.qoder/bin/qodercli/qodercli.exe`；auto 探测仍只看 PATH |
| Qoder 用户记忆落点 | ✅ 实测 | `~/.qoder/memory/`；已 junction 进沙箱（写入回流真实目录）。`skills/agents/commands`/`AGENTS.md` 在 1.1.78 不存在 |
| Qoder Desktop 的 MCP 都在 `settings.json` | ⚪ **不一定** | 本机有 `~/.qoder/mcp-router.json`（本地路由）；只登记在路由里的 MCP 不会出现在 `列出 MCP` |
| `onPath()` 会补试 `.cmd` | ⚪ **不会** | 只有 `dsh.cmd` 时 `binWin` 必须写 `dsh.cmd` |
| DSH `0.2.1-rc.2` 有 resume/list/close | ✅ 实测 | `docs/接入-DeepSeek.md` 附录 |
| DSH `0.2.1-rc.2` 有 `session/load` | ❌ 实测 | `-32601 Method not found` |
| DSH `0.2.1-rc.2` 接受图片 | ❌ 实测 | `image:false`；带图 `-32602` |
| DSH `0.2.1-rc.2` 接受 stdio/HTTP MCP | ✅ 实测 | stdio：假 MCP 在 `session/new`/`resume` 均被模型真实调用（marker×2）；HTTP 能力已广告、未实测 |
| DSH 能保留多轮上下文（resume 后） | ✅ 实测 | PINEAPPLE：close + 强杀 + resume 后答出 |
| DSH 默认模型路由可直接用 | ⚪ **不成立** | 默认 `deepseek-official` 需 `DEEPSEEK_API_KEY`；桌面登录是 `deepseek-account`，必须 `set_config_option` |
| DSH 首帧很慢 | ⚪ **不成立**（短任务） | 实测 1.0–2.3s；长任务仍可能静默 |
| DSH 会发 thought/tool/usage 帧 | ✅ 实测 | `agent_thought_chunk` / `tool_call` / `usage_update` |
| 微信连发上限约 10 条 | ✅ 实测/代码 | `CONSEC_SEND_LIMIT=10`，预留最后一条 |
| 15s 心跳会占连发额度 | ✅ 代码 | `index.ts` `heartbeat` + `sendProgress`；DSH 有帧时通常不触发 |
| **切大脑要重启 daemon** | ⚪ **已不成立（1.2.0）** | `brain-switch.ts` 进程内切换：drain → 预热 → 成功才落盘；失败回滚 |
| **agent 在进程启动时冻结** | ⚪ **已不成立（1.2.0）** | `agent-slot.ts` 槽位 + 过程内显式传 `ag`；心跳/首帧每回合现算 |
| **任务只能有一条（单任务单例）** | ⚪ **已不成立（1.2.0）** | 任务表 + `class WorkerConn` + `worker-pool.ts`；编号按用户递增不复用 |
| **任务结束即杀进程** | ⚪ **已不成立（1.2.0）** | 结束「等你回复」的任务时进程**回池**复用（「正在跑」的那条只能力杀——回合没法优雅取消）；空闲超 `WEMIND_WORKER_REAP_MS`(5min) 回收；`wemind stop` 才杀光 |
| **daemon 重启后任务全丢** | ⚪ **已不成立（1.2.0）** | `tasks.json` 读回 → 未完成标「已中断」→ 回「继续」才 `load`/`resume` 续跑（**不自动**） |
| 会话只能保留「当前一条」 | ⚪ **已不成立（1.2.0）** | 登记表 + 五条会话指令（列表/新/恢复/改名/删除）；指针表仍是唯一权威 |
| ACP 有 `session/delete` | ⚪ **待实测** | 仓库内无调用；`删除会话` 只删 WeMind 登记，回复里写明 agent 侧归档仍在 |
| 各 agent `session/load` 会回放历史帧 | ⚪ **待实测** | 回放帧在无 prompt 时本就被丢弃（`acp-brain.ts`），恢复用 strict 语义 |
| 被强杀后各 agent 能 `load`/`resume` 回该任务会话 | ⚪ **待实测** | 「重启后续跑」的可行边界由这条决定（kiro/opencode/qoder/DSH 各一次） |
| 同 agent 两个 worker 共用配置目录不互踩 | ⚪ **待实测** | 不同 agent 各有 `configSubdir`；同 agent 并发等于「两个终端在同一配置目录」 |
| 多任务并发时 `sendNotice` 会撞 `ret=-2` | ⚪ **待实测** | 额度按用户共享；需真机微信验 |
| Windows `taskkill /T /F` 杀池中特定进程 | ⚪ **待实测** | 决定池回收/结束任务的清理是否干净 |
| 「多个微信账号之间有一个主号」 | ⚪ **不存在** | 一个微信账号 = 一个真人（扫码登录者）；N 个账号 = N 个 daemon，各有自己的 `brain.json`/会话表/沙箱/登录者，互不越界（README「多账号管理」、`repowiki/06` §6.2） |
| 「切 daemon 大脑是跨账号权限」 | ⚪ **不是** | 微信侧只有**该账号的登录者**能切**它自己**那个 daemon（`OWNER_ONLY_KINDS`）；本机 CLI 才可指定任意账号（`wemind brain switch X <key\|label>`），因为「能在本机敲命令 = 机主」 |
| 除登录者外还有谁能把消息发进 bot | ✅ **已确认：没有** | 微信平台限制——**必须扫码登录该 bot 才能给它发消息**，所以每个 bot 只有其登录者能发（用户 2026-10-29 确认）。`allowFrom` 因此是**兜底闸门**（默认拒绝、默认只放行登录者）：防的是投递范围将来变化 / daemon 被接到别的入口；旧文档里「换个微信号验证」的写法已删 |

> **规矩**：新增 agent 接入文档时，必须写清「已实测 / 仅代码 / 未验证」，并给版本与日期。

---

## 6. 源码地图（按任务）

| 任务 | 先读 | 再读 |
|---|---|---|
| 接新 ACP agent | `brain-agents.ts` | `acp-brain.ts`、`mcp-sandbox.ts`、`docs/ai/recipes/add-acp-agent.md` |
| 改 ACP 自愈/超时 | `acp-brain.ts` | `worker-acp.ts`（同步）、`brain-check.ts` |
| 改 MCP 注入 | `mcp-sandbox.ts` | `agent-mcp.ts`、`worker-sandbox.ts`、`docs/ai/recipes/add-mcp.md` |
| 改微信消息/回复 | `index.ts` | `md-reply.ts`、`image-reply.ts` |
| 改 CLI | `cli.ts` | `manage.ts` |
| 改数据/账号 | `wechat-ilink-core/src/store/*` | `brain-config.ts`、`docs/repowiki/08` |
| 排查不回复 | `docs/ai/recipes/debug-daemon.md` | `daemon.log`、`brain.json`、`brain check` |
| 端到端验收 | `docs/ai/recipes/run-e2e.md` | `scripts/doctor.ps1` |

---

## 7. 文档维护约定

1. 每篇接入/架构文档顶部写：`适用版本 / 最后核对日期 / 实测范围`。
2. 把「ACP 通用」与「该 agent 实测」分开写；后者给命令与输出。
3. 变更代码时同步更新：`AGENTS.md` 的「已知坑」、本文件的「事实状态表」、对应 recipe。
4. 不在文档里复制易变细节（版本号、完整方法列表）；给「怎么查」（`initialize`、`wemind brain`）而不是「背答案」。
5. 内部链接用相对路径；新增文件后跑 `pwsh -NoProfile -File scripts/check-docs.ps1`（CI 也可用）。

---

## 8. 任务配方

- [接入一个新的 ACP Agent](recipes/add-acp-agent.md)
- [新增/调试 MCP 注入](recipes/add-mcp.md)
- [排查 daemon 不回复](recipes/debug-daemon.md)
- [端到端验收](recipes/run-e2e.md)

---

## 9. 机器可读索引

根目录 [`llms.txt`](../../llms.txt) 给 LLM 爬取/检索用；`AGENTS.md` 是首轮入口；本文件是压缩上下文。深读再去 `docs/repowiki/`。
