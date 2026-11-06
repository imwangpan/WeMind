# WeMind · AI 上下文包

> **最后核对**：2026-11-05
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
             └─ worker：进程池里 N 个 ACP agent（任务，一条任务一条连接，可「继续」）
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
| `@wemind/wechat-ilink-core` | `packages/wechat-ilink-core` | iLink HTTP、类型、错误码、会话守卫、账号/状态、收发图加解密 | 私有（构建时内联进 `@wemind/wechat-mcp` 与 `@wemind/cli`） |
| `@wemind/wechat-mcp` | `packages/wechat-mcp` | 6 个 MCP 工具 | 已发布（bin `wemind-mcp`） |
| `@wemind/cli` | `packages/wechat-daemon` | daemon + ACP 大脑 + worker + CLI | 已发布（命令 `wemind`） |

依赖方向单向；消费方只依赖 core，mcp 与 daemon 互不耦合。**包名与命令名分离**：装 `@wemind/cli`，敲 `wemind`（`npx` 必须写全包名）。

---

## 3. daemon 一轮消息发生了什么

```text
poller（长轮询，不被大脑阻塞）
  → 收到消息 / 逐条分拣入队（**不合并**：一条消息 = 一次 prompt）
  → 快车道（fastQueue，独立于大脑）：控制指令 / 任务指令 / 可续跑任务的「继续」短句
     （帮助 / 切脑 / 交接 / 会话四件套 / 任务 / MCP 等；「问大脑」前缀不在此列；
       账号级指令（切脑/交接）由非登录者发 → 短提示拒绝，不进大脑；兜底校验，平台限制下正常不触发）
  → 大脑队列（msgQueue，串行）：选择 brain 或 worker（**无前缀消息默认走 brain**；出队时仍有可续跑任务才进任务表，见 `shouldResumeTask()`；回任务要显式寻址 `#编号 正文` / `> 正文` / `任务 …`。**模型/账号侧报错的任务直接转「已中断」**）
  → askBrain(userId, text, onProgress, images)
       ├─ 等切换门（切换大脑进行中时有界等待）
       ├─ ensureProcess(ag)：懒启动 ACP agent，initialize
       ├─ ensureSession(ag, userId)：内存 session → 磁盘 map → load/resume → 否则 new
       ├─ 有交接摘要且目标大脑不是来源 → 作为本条消息的**前缀**带上
       ├─ session/prompt：文本（+ 图片）
       └─ session/update：拼 agent_message_chunk；tool/thought → 进度
  → 成功：写会话登记表（轮次+1/标题首写）、答成才消费交接摘要
  → md-reply / image-reply 处理长文与图片
  → send_text_message（受连续发送额度约束）
```

关键点：

- **每用户一个 brain session**，映射在 `<数据目录>/brain-sessions.json`（键 `<agent>:<userId>`，换大脑不丢各自上下文）——**这张当前会话表是「当前是哪个会话」的唯一权威**；`session-registry.json` 只是展示用的登记表（名字/标题/轮次），坏了不影响恢复；
- **worker 是 N 个独立 ACP 进程**（进程池，一条任务一条连接），任务会话在 `worker-sessions.json`（键 `<agent>:task-<编号>@<userId>`）；任务表另存 `tasks.json` 供**重启后续跑**（未完成的标「已中断」，回「继续」才续跑）；
- **切换大脑是进程内的**（`brain-switch.ts`）：预检 → 等回合结束 → 启动新大脑 → **成功才写 `brain.json`**；失败退回、槽位留旧大脑；
- **控制桥与微信回合串行**：`askBrain` / `newSession` / `resumeSession` 共用 `acp-brain.ts` 的操作队列；控制桥请求带 `expiresAt`，过期请求 daemon 不执行（排队中的会话操作拿到执行权后再查一次）；
- **自愈**：prompt 超时/失败 → `reset()` 杀进程树 → 下条消息重建并尝试恢复会话；
- **进度**：三档（<5s 只发最终答案；5–15s 第 5s 发「收到」；≥15s 第 5s「收到」+第 15s 第二条，正文已开始→「整理回复」，否则→「还在处理中」；15s 之后不再补发第三条固定提示）。`tool_call` → 「步骤 N」（优先用 purpose，否则从 `rawInput` 取 command/路径/query，截断 60 字）；工具/心跳/图片/重试提示算已有可见进度，会顶替固定提示；第 15s 第二条距上一条非确认进度不足 5s 就跳过（不延后补发）；任意 `session/update` → 刷新心跳基线；
- **连发上限**：iLink 约 10 条；外发管线（串行链、按用户预算、挂起补发、任务推送让位）在 `send-pipeline.ts` 的 `SendPipeline`，`index.ts` 只接真实发送函数和回合编排。预留最后一条给最终答案，进度到第 8 条会暂停并提示「接近上限」；图片也计一条并走同一条串行链，额度不够时改附原链接；大脑回合接近上限时任务推送先让位、回合结束后再发。**多任务与对话大脑共享同一份额度**（按用户计）。

---

## 4. 术语

> **术语表已独立成篇**：[docs/ai/术语表.md](术语表.md) —— WeMind 内部概念（brain / worker / 任务编号 / 控制桥 / 激活集…）、中英术语对照（spawn、stdio、daemon、watchdog、capability、reverse request…）、账号与权限的用词纪律（「登录者」「登录者白名单」，禁用「主号」）、以及注释按段落换行的写作口径。

最常用的几条，先记住：

| 词 | 一句话 |
|---|---|
| **brain** | 常驻 ACP 对话进程，每用户一个 session（`acp-brain.ts`） |
| **worker** | 远程任务执行器，一条任务一条 ACP 连接（`worker-acp.ts` 的 `WorkerConn`） |
| **当前会话表** | `brain-sessions.json`，键 `<agent>:<userId>` —— 「当前是哪个会话」的唯一权威 |
| **会话登记表** | `session-registry.json`，只是派生元数据（名字/标题/轮次），坏了只导致列表空 |
| **严格恢复** | `load`/`resume` 都失败就如实报错，不回退 `new`、不改当前会话记录 |
| **交接** | 摘要写盘（TTL 24h），切走后下一条消息作为前缀带上，答成才消费 |
| **反向请求** | agent → client 的请求；三处入口共用 `acp-reverse.ts`，权限默认拒绝、未知方法回 `-32601` |
| **daemon / watchdog** | `daemon` = 常驻业务进程；「守护进程」专指负责重拉它的 watchdog |


---

## 5. 事实状态表（先看这张，别被旧文档带偏）

> **这张表是结论索引**（「现在是什么」）。逐条的**已知坑、踩坑细节与验证方法**在 [`AGENTS.md`](../../AGENTS.md) §6 / §7——那两节是唯一权威清单，本表只给结论与证据入口，细节以那边为准（两边不一致时按 AGENTS.md 并顺手修本表）。

| 事实 | 状态 | 证据/备注 |
|---|---|---|
| 默认大脑是 `auto`，不是固定 kiro | ✅ 代码 | `brain-agents.ts` `resolveAgent()` |
| kiro agent 可用 | ✅ 实测 | 现有 daemon（v2 2.37.1 真机；v3 探针级）；`docs/接入方案/接入其它-ACP-Agent.md` §5 |
| kiro 只有 v2 一套启动方式 | ⚪ **不成立（2026-11-03）** | v3 拒绝 `--trust-all-tools`/`-a`/`--trust-tools`（会连 `initialize` 都不回）；预设 `kiroEngine: true` 按 `--agent-engine` → 真实 `settings/cli.json` 的 `acp.agentEngine` → CLI 主版本 ≥3 判定（`acp --help`：两者都没设时默认 v2；CLI ≥3 默认 v3 为假设/待实测），v3 时剔除 v2 参数、补 `--agent-engine v3`，免审批改沙箱 `settings/permissions.yaml` 的 allow-all 规则（真实已有则原样保留）。`session/new` 的 `_meta.kiro.policyPreset` 实测无效 |
| opencode agent 可用（`session/load`、无反向请求） | ✅ 实测 | `docs/接入方案/接入-OpenCode.md` §3.3 |
| 任意兼容 ACP 的 agent 都「无需改代码」 | ⚪ **不成立** | 需要 load/resume、反向请求、首帧/心跳、image 能力适配 |
| `session/load` 是 ACP 通用能力 | ⚪ **不成立** | DSH 只有 `session/resume`；`load` 返回 `-32601` |
| 代码按 `initialize` 回包自动适配能力 | ⚪ **不成立** | `acp-brain.ts` / `worker-acp.ts` 发出 `initialize` 后只置 `initialized = true`，**不解析** `agentCapabilities`；image/restore/mcpViaAcp 全部来自 `brain-agents.ts` agent 配置字段 |
| 仓库存在 `Brain` 接口 | ⚪ **不存在** | `acp-brain.ts` 直接导出 `askBrain`/`newSession`/`restart`/`restartForMcpChange` |
| `wemind brain check` 默认 60s | ✅ 代码 | 冷启动慢的 agent 仍可能误报 |
| `deepseek` agent 已内置 | ✅ 代码/实测 | `dsh.cmd` + `DSH_HOME` + `.credentials.yaml` + `model` + `resume` + `mcpViaAcp`（动态 MCP）；微信 brain/worker E2E、MCP（含微信侧全链路）、记忆/技能、图片友好拒绝均已验。**2026-11-03（rc.3）**：预设 `isolateSessions: true`，`prepareAgent()` 落盘 `--patch` 把会话 root 指到 `<账号目录>/agent-sessions/deepseek/<brain\|worker>`（共用沙箱根的 `sessions/` 被 kiro/pi 写过会让 DSH 报 `unsupported flat-file layout`）；`- id: acp` 的 model 被桌面端目录淘汰时 `wemind brain` 用 `acpModelHint` 给替换提示（只提示不代改） |
| `qoder` agent 已内置 | ✅ 代码/实测 | `qodercli --acp --yolo` + `QODER_CONFIG_DIR` + `settingsBase`（剥离 providers/model）+ `.auth/user`/`.auth/machine_id`；M0–M3 全部已验：发图、动态 MCP、冷重启 `session/load`、worker 中断续跑、`memory/` junction 继承 |
| `cline` agent 已内置 | ✅ 代码/实测（3.0.74） | `cline --acp --auto-approve true` + `CLINE_DIR`/`CLINE_DATA_DIR`/`CLINE_MCP_SETTINGS_PATH` 沙箱（`configSubdir: "cline"`）；`providers.json` 同步；`models.json` 模型目录同步（缺它会回退 gpt-4o）；**自定义 provider 由 `credentialEnv`（`clineCredentialEnv()`）从 `providers.json` 自动派生 `CLINE_PROVIDER`+`CLINE_API_KEY`，父进程显式值优先**；`loadSession`/硬杀后 `session/load` 已验证；**图片 ❌**（广告 `image:true` 但 ACP `prompt` 只保留 text → `images:false`）；ACP `mcpServers` 不生效→文件式 MCP；`session/close` 无 |
| `gemini` 预设已内置 | ✅ 代码/探针级实测 + 真机 E2E（0.66.0，2026-11-01） | `gemini --acp --approval-mode yolo --skip-trust`；`GEMINI_CLI_HOME` 指向沙箱根、配置目录 `<它>/.gemini`（`configSubdir: ".gemini"`）；MCP 走配置目录 `settings.json` 的 `mcpServers`（探针实测 `probe_ping` 可调用）；`settingsBase` 只剥 `mcpServers`（保留 model/security，按 JSONC 解析）+ `.env` / `oauth_creds.json` / `google_accounts.json` 凭据同步 + `skills/`/`GEMINI.md` 继承；`loadSession: true`、图片 ✅、工具调用 0 反向请求；**`load` 返回后会异步回放历史** → `replayOnLoad` 先等帧安静；`session/set_config_option` ❌（`--model` 走 `modelArg`）；在 `AUTO_PROBE_ORDER` 第 4 位（opencode → cline → qoder → gemini）。见 [接入-Gemini.md](../接入方案/接入-Gemini.md) |
| `claude-code` 预设已内置（探针级实测 + 真机微信单轮 E2E） | ✅ 探针级实测 + 真机微信单轮 E2E 已通过（2026-10-31；重启续聊 / MCP / 任务待复测） | 全局 `npm i -g @agentclientprotocol/claude-agent-acp`（Node ≥22；`binWin=claude-agent-acp.cmd` + `shell: true`）+ `CLAUDE_CONFIG_DIR` 沙箱（`~/.claude.json` 一并隔离）+ `mcpViaAcp`（目录 `~/.claude.json`；`initialize` 只声明 http/sse，**stdio 实测可用**）+ `sessionMode bypassPermissions`（适配器不解析 CLI flag）；`loadSession: true`、`sessionCapabilities.resume/close/delete/fork/list`；**不在** `AUTO_PROBE_ORDER`（独立安装、各有认证），只能显式选用。见 `docs/接入方案/接入-ClaudeCode.md` |
| `codex` 预设存在且已实测 | ✅ 代码/实测（探针 + 真机 E2E） | 适配器 `@agentclientprotocol/codex-acp` 2.5.0（**全局安装**，口径同 claude-code）：`load`/图片/`set_mode`/`set_config_option(model)` ✅、工具调用 0 反向请求；**stdio MCP ❌**（`mcpCapabilities.acp=false`）→ 不开 `mcpViaAcp`；心跳 60s；**没有沙箱配置目录**（只有 cwd 指向沙箱根）；**不在** `AUTO_PROBE_ORDER`，只能显式选用；真机 E2E：worker 与 brain 通道均通过（见 [接入-Codex.md](../接入方案/接入-Codex.md)） |
| `pi` 预设已内置 | ✅ 代码/探针级实测 + 真机 E2E（2026-11-01：brain、热切换、微信任务） | 社区适配器 `pi-acp`（**全局安装**）+ `requiresBins: ["pi"]`（pi 本体 `npm i -g @earendil-works/pi-coding-agent`，先登录/配好模型；只装适配器会被 `agentProblem()` 提前拒绝）；`PI_CODING_AGENT_DIR` 沙箱根、`settings.json`/`auth.json`/`models*.json` 同步、`skills/` junction + `AGENTS.md` 复制；MCP 走 `<沙箱根>/mcp.json`（kiro 格式，`pi mcp list` 实测）、`mcpViaAcp: false`（pi-acp 只存不读）；免审批无需开关；`loadSession: true`/图片 ✅/0 反向请求；**不在** `AUTO_PROBE_ORDER`；`settingsDefaults: { quietStartup: true }` 关掉 pi-acp 当消息发出来的启动横幅（`## Context` / `## Skills`，用户显式设过则保留）；worker 沙箱在每次派发前按该任务的 agent 重备（`worker-pool.acquire` → `ensureWorkerHome(ag)`，否则派到非默认 agent 时拿空配置跑）；沙箱隔离不完整（pi-acp 从真实 `homedir()` 读 session-map/prompts/skills）。见 [接入-pi.md](../接入方案/接入-pi.md) |
| Qoder 沙箱 MCP 生效 | ✅ 实测 | 沙箱 `settings.json.mcpServers` 可被真实调用；项目级 `.mcp.json` 即使 `--yolo` 也不自动加载 |
| Qoder 可免 `--bin` 绝对路径 | ✅ 代码 | `fallbackBinPaths` 兜底 `~/.qoder/bin/qodercli/qodercli.exe`；**auto 探测也认它**（`presetAvailable()` → `presetBinPath()` 先 `onPath()` 再 `fallbackBinPaths`，2026-11-05 核对） |
| Qoder 用户记忆落点 | ✅ 实测 | `~/.qoder/memory/`；已 junction 进沙箱（写入回流真实目录）。`skills/agents/commands`/`AGENTS.md` 在 1.1.78 不存在 |
| Qoder Desktop 的 MCP 都在 `settings.json` | ⚪ **不一定** | 本机有 `~/.qoder/mcp-router.json`（本地路由）；只登记在路由里的 MCP 不会出现在 `列出 MCP` |
| `onPath()` 会补试 `.cmd` | ⚪ **不会** | 只有 `dsh.cmd` 时 `binWin` 必须写 `dsh.cmd` |
| DSH `0.2.1-rc.2` / `rc.3` 有 resume/list/close | ✅ 实测 | `docs/接入方案/接入-DeepSeek.md` 附录；rc.3 于 2026-11-03 复测 |
| DSH 会话库可以和别的 agent 共用沙箱根 | ⚪ **不成立（2026-11-03，rc.3）** | kiro/pi 写进 `<沙箱>/sessions/` 的平铺文件会让 DSH 报 `unsupported flat-file layout`；用 DSH 自己的 `--patch` 把 `session-persistence-jsonl.root` 指到账号数据目录下（用户自带 `--patch` 则尊重用户） |
| 用户 `- id: acp` 的 model 会一直有效 | ⚪ **不成立（2026-11-03，rc.3）** | 桌面端升级会重写 `llm-pi-ai` 的模型目录，独立一条的 `- id: acp` 不会被迁移；`session/new` 报 `no configured model`。`wemind brain` 检查并给出可粘贴替换（优先 `agent-default-model` 的值），**不自动改真实 profile** |
| DSH `0.2.1-rc.2` 有 `session/load` | ❌ 实测 | `-32601 Method not found` |
| DSH `0.2.1-rc.2` 接受图片 | ❌ 实测 | `image:false`；带图 `-32602` |
| DSH `0.2.1-rc.2` 接受 stdio/HTTP MCP | ✅ 实测 | stdio：假 MCP 在 `session/new`/`resume` 均被模型真实调用（两个方法各调用 2 次）；HTTP 能力已广告、未实测 |
| DSH 能保留多轮上下文（resume 后） | ✅ 实测 | PINEAPPLE：close + 强杀 + resume 后答出 |
| DSH 默认模型路由可直接用 | ⚪ **不成立** | 默认 `deepseek-official/deepseek-v4-flash` 需 `DEEPSEEK_API_KEY`（2026-10-29 用 `acp-probe` 在 `0.2.1-rc.3` 复测，空 home 与桌面登录态下默认值都是它）——根因是桥插件的 bundle patch 写死了 `- id: acp` 的 `provider/model`，用户 profile 只覆盖 `agent-default-model`（另一个服务的键），`- id: acp` 要用户自己写（插件 README 写明的覆盖点）。WeMind 侧**原样复制** `profiles/acp/cordis.patch.yml`、不追加条目（复制前剔除用户自己挂的微信 MCP 条目——跑 `wemind-mcp` 的或 `serverName: wechat` 的 mcp-client，防沙箱里的 agent 抢同一个 bot token）；读默认模型时优先 `- id: acp`、否则 `agent-default-model`（典型 `["magpie","auto/deepseek-v4.1-flash"]`，需桌面端在运行；这个值被桌面端目录淘汰时 `wemind brain` 会提示换成目录里现有的，如 `auto/dfmodel`），会话建立后按它发 `set_config_option`（agent 自己的接口）；缺 `- id: acp` 时 `wemind brain` 给可粘贴的片段、由用户补到真实 profile；读不到才回退 `deepseek-account/deepseek-flash`；显式覆盖 `wemind brain set deepseek --model …`，`--model auto` = 跟随真实 profile 的默认 |
| DSH 首帧很慢 | ⚪ **不成立**（短任务） | 实测 1.0–2.3s；长任务仍可能静默 |
| DSH 会发 thought/tool/usage 帧 | ✅ 实测 | `agent_thought_chunk` / `tool_call` / `usage_update` |
| 微信连发上限约 10 条 | ✅ 实测/代码 | `CONSEC_SEND_LIMIT=10`，预留最后一条 |
| 15s 心跳会占连发额度 | ✅ 代码 | `index.ts` `heartbeat` + `sendProgress`；DSH 有帧时通常不触发 |
| **切大脑要重启 daemon** | ⚪ **已不成立（1.2.0）** | `brain-switch.ts` 进程内切换：等在途回合结束 → 启动新大脑 → 成功才写入磁盘；失败退回 |
| **agent 在进程启动时冻结** | ⚪ **已不成立（1.2.0）** | `agent-slot.ts` 槽位 + 过程内显式传 `ag`；心跳/首帧每回合现算 |
| **任务只能有一条（单任务单进程）** | ⚪ **已不成立（1.2.0）** | 任务表 + `class WorkerConn` + `worker-pool.ts`；编号按用户递增不复用 |
| **任务结束即杀进程** | ⚪ **已不成立（1.2.0）** | 结束「等你回复」的任务时进程**留着复用**（「正在跑」的那条只能力杀——回合没法优雅取消）；空闲超 `WEMIND_WORKER_REAP_MS`(5min) 回收；`wemind stop` 才杀光 |
| **daemon 重启后任务全丢** | ⚪ **已不成立（1.2.0）** | `tasks.json` 读回 → 未完成标「已中断」→ 回「继续」才 `load`/`resume` 续跑（**不自动**） |
| 会话只能保留「当前一条」 | ⚪ **已不成立（1.2.0）** | 登记表 + 五条会话指令（列表/新/恢复/改名/删除）；当前会话表仍是唯一权威 |
| ACP 有 `session/delete` | ✅ **已实测（2026-10-29）**：opencode/qoder 有，DSH 没有（`-32601`） | 当前实现仍只删 WeMind 登记、回复写明 agent 侧归档仍在（三家里有一家没有，就不能依赖它） |
| 各 agent `session/load` 会回放历史帧 | ✅ **已实测（2026-10-29）**：opencode 2 帧/857ms、qoder 3 帧/804ms；DSH 无 load，`resume` 0 帧/195ms | 回放帧在无 prompt 时本就被丢弃（`acp-brain.ts`）；时间远小于超时 |
| 被强杀后各 agent 能 `load`/`resume` 回该任务会话 | ✅ **已实测（2026-10-29）**：DSH（resume）与 opencode（load）能接回同一 sessionId；qoder 任务续跑已实测（2026-10-27，1.1.78） | 「重启后续跑」对这些 agent 成立；接不上时的诚实文案仍保留 |
| 同 agent 两个 worker 共用配置目录不互踩 | ⚪ **一轮样本未见互踩（2026-10-29）** | 不同 agent 各有 `configSubdir`；同 agent 并发等于「两个终端在同一配置目录」，长期风险仍在 |
| 多任务并发时 `sendNotice` 会撞 `ret=-2` | ⚪ **未观察到限流型（2026-10-29）** | 真机里的 `-2` 全是重启后旧 token（见下一行）；额度仍按用户共享，压力大就调小并发 |
| Windows `taskkill /T /F` 杀池中特定进程 | ⚪ **待实测** | daemon 强杀 + `wemind stop` 已验证无孤儿；「杀池中某个特定 pid」与「`session/load` 途中强杀」未单独测 |
| **daemon 重启后、用户下一条消息前的外发** | ✅ **已确认会静默丢失（2026-10-29，已修）** | `state.contextTokens` 是上次运行留下的 token，任务结果/指令答复必然 `-2 (prepare failed)`；现在只在该用户本进程还没发过消息时挂进 `pending-push.ts`，等新 token 到达按序补发（每人 20 条、每轮 5 条且给答复留额度、同一条最多 3 次） |
| 「多个微信账号之间有一个主号」 | ⚪ **不存在** | 一个微信账号 = 一个真人（扫码登录者）；N 个账号 = N 个 daemon，各有自己的 `brain.json`/会话表/沙箱/登录者，互不越界（README「多账号管理」、`repowiki/06` §6.2） |
| 「切 daemon 大脑是跨账号权限」 | ⚪ **不是** | 微信侧只有**该账号的登录者**能切**它自己**那个 daemon（`OWNER_ONLY_KINDS`）；本机 CLI 才可指定任意账号（`wemind brain switch X <key\|label>`），因为「能在本机敲命令 = 机主」 |
| 除登录者外还有谁能把消息发进 bot | ✅ **已确认：没有** | 微信平台限制——**必须扫码登录该 bot 才能给它发消息**，所以每个 bot 只有其登录者能发（用户 2026-10-29 确认）。`allowFrom` 因此是**兜底校验**（默认拒绝、默认只放行登录者）：防的是发送范围将来变化 / daemon 被接到别的入口；旧文档里「换个微信号验证」的写法已删 |

> **规矩**：新增 agent 接入文档时，必须写清「已实测 / 仅代码 / 未验证」，并给版本与日期。

---

## 6. 源码地图（按任务）

| 任务 | 先读 | 再读 |
|---|---|---|
| 接新 ACP agent | `brain-agents.ts` | `acp-brain.ts`、`mcp-sandbox.ts`、`docs/ai/recipes/add-acp-agent.md` |
| 改 ACP 自愈/超时 | `acp-connection.ts`（帧/超时/模型与模式，brain 与 worker 共用） | `acp-brain.ts` / `worker-acp.ts`（进程生命周期与会话持久化各自实现）、`brain-check.ts` |
| 改反向请求应答（权限 / fs / terminal） | `acp-reverse.ts` | `acp-reverse.test.ts`；brain、worker、`brain check` 三处共用 |
| 改 ACP 连接公共层 | `acp-connection.ts`：帧分类、请求/回合超时、模型与模式、回放静默 | `acp-connection.test.ts`（覆盖上述全部）；brain 与 worker 共用，改一处两边生效 |
| 改 MCP 挂载 | `mcp-sandbox.ts` | `agent-mcp.ts`、`worker-sandbox.ts`、`sandbox-inherit.ts`（记忆/技能继承与换 agent 清理）、`docs/ai/recipes/add-mcp.md` |
| **改热切换大脑** | `brain-switch.ts`（预检 → 等在途回合结束 → 启动新大脑 → 成功才落盘 → 失败退回） | `acp-brain.ts` 的 `beginSwitch`/`drainTurn`/`warmup`、`agent-slot.ts`（槽位）、`daemon-control.ts` 的 `AI`/`切换大脑` 分支 |
| **改多任务 / 进程池 / 任务编号** | `worker-pool.ts`（`planAcquire`/`planReap` 纯函数；`acquire` 起进程前按这条任务的 agent 调 `ensureWorkerHome(ag)`） | `worker-acp.ts`（`class WorkerConn`）、`task-manager.ts`、`task-store.ts`、`docs/repowiki/07` |
| **改会话五条指令 / 恢复语义** | `session-manager.ts`（操作层） | `session-registry.ts`（登记表，派生元数据）、`session-map.ts`（当前会话表，唯一权威）、`acp-brain.ts` 的 `resumeSession`（严格恢复） |
| **改交接** | `handoff.ts`（写入磁盘 / 带上 / 消费） | `index.ts` 的 `workerLoop` 前缀带上、`daemon-control.ts` 的 `交接` 分支 |
| 改微信消息/回复 | `index.ts`、`send-pipeline.ts` | `md-reply.ts`、`image-reply.ts`、`pending-push.ts` |
| 改 CLI | `cli.ts`（分派 `cli-dispatch.ts`） | `manage.ts` + 按主题拆出的 `cli-context.ts` / `cli-task.ts` / `cli-session.ts` / `cli-brain.ts` / `cli-login.ts` |
| 改数据/账号 | `wechat-ilink-core/src/store/*` | `brain-config.ts`、`docs/repowiki/08` |
| 排查不回复 | `docs/ai/recipes/debug-daemon.md` | `daemon.log`、`brain.json`、`brain check` |
| 端到端验收 | `docs/ai/recipes/run-e2e.md` | `scripts/doctor.ps1` |

---

## 7. 文档维护约定

1. 每篇接入/架构文档顶部写：`最后核对日期 / 实测范围`（**不写「适用版本」**）。全库文档描述当前分支的最新代码，**不绑定已发布版本号**；发布版本号只在 `package.json`、`CHANGELOG` 与发布文档中记录。
2. 把「ACP 通用」与「该 agent 实测」分开写；后者给命令与输出。
3. 变更代码时同步更新：`AGENTS.md` 的「已知坑」、本文件的「事实状态表」、[术语表](术语表.md)（涉及新概念/用词时）、对应 recipe。
4. 不在文档里复制易变细节（版本号、完整方法列表）；给「怎么查」（`initialize`、`wemind brain`）而不是「背答案」。
5. 内部链接用相对路径；新增文件后跑 `pwsh -NoProfile -File scripts/check-docs.ps1`（CI 也可用）。

---

## 8. 任务配方

- [接入一个新的 ACP Agent](recipes/add-acp-agent.md)
- [新增/调试 MCP 挂载](recipes/add-mcp.md)
- [排查 daemon 不回复](recipes/debug-daemon.md)
- [端到端验收](recipes/run-e2e.md)

---

## 9. 机器可读索引

根目录 [`llms.txt`](../../llms.txt) 给 LLM 爬取/检索用；`AGENTS.md` 是首轮入口；本文件是压缩上下文。深读再去 `docs/repowiki/`。
