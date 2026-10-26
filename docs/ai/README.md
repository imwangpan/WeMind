# WeMind · AI 上下文包

> **适用版本**：WeMind 1.0.1 ｜ **最后核对**：2026-10-26（`@wemind/cli@1.0.0` 与 `@wemind/wechat-mcp@1.0.4` 均已发布到 npm）
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
  → 收到消息 / 合并同用户连发
  → 指令拦截（新会话 / MCP / 任务 / 问大脑 …）
  → 选择 brain 或 worker
  → askBrain(userId, text, onProgress, images)
       ├─ ensureProcess()：懒启动 ACP agent，initialize
       ├─ ensureSession()：内存 session → 磁盘 map → load/resume → 否则 new
       ├─ session/prompt：文本（+ 图片）
       └─ session/update：拼 agent_message_chunk；tool/thought → 进度
  → md-reply / image-reply 处理长文与图片
  → send_text_message（受连续发送额度约束）
```

关键点：

- **每用户一个 brain session**，映射在 `<数据目录>/brain-sessions.json`（键 `<agent>:<userId>`，换大脑不丢各自上下文）；
- **worker 是第二个独立 ACP 进程**，单任务 session，映射在 `worker-sessions.json`；
- **自愈**：prompt 超时/失败 → `reset()` 杀进程树 → 下条消息重建并尝试恢复会话；
- **进度**：`tool_call` → 「步骤 N」；`agent_message_chunk` → 「正在整理回复」；任意 `session/update` → 刷新心跳基线；
- **连发上限**：iLink 约 10 条；`index.ts` 预留最后一条给最终答案，进度到第 8 条会暂停并提示「接近上限」。

---

## 4. 术语表

| 术语 | 含义 |
|---|---|
| **ACP** | Agent Client Protocol，JSON-RPC 2.0 over stdio，每行一个 JSON；Zed 提出 |
| **brain** | 对话大脑，`acp-brain.ts`，每用户一个 session |
| **worker** | 远程任务执行器，`worker-acp.ts`，单 session，独立进程 |
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

写文档/回答问题时统一用「推荐中文」，英文原文只在首次出现时括注即可。

| 英文 | 推荐中文 | 说明 / 别译成 |
|---|---|---|
| **spawn** | **启动（子进程）** / 派生 | `spawn` 是进程创建原语，Node 里是 `child_process.spawn()`。别译「生成」（易与数据生成混淆） |
| **stdio** | **标准输入输出**（首次出现写全称，之后可保留 `stdio`） | `st`andar**d** **i**nput/**o**utput 的缩写，不是普通英文词；命令行参数/API 名里保持原文 |
| **stdin / stdout / stderr** | 标准输入 / 标准输出 / 标准错误 | 同上，代码里保留原文 |
| **CLI** | **命令行工具**（指程序）/ **命令行界面**（指形态） | 别译「客户端」；`kiro-cli`、`claude-code` 这类名字里的 CLI 不翻 |
| **agent** | **agent** / 智能体 | 本文统一保留 `agent`（大量专名如 ACP agent、brain agent 依赖它） |
| **ACP** | **ACP（Agent Client Protocol）** | 首次出现给全称，之后直接用 ACP |
| **implement / support ACP** | **实现 / 支持 ACP** | **不要**写「说 ACP」——ACP 是协议（规范），程序是「实现」它。二元化的「会说/不会说」会掩盖「实现完备度不同」这个事实 |
| **protocol / implementation** | **协议**（规范）/ **实现**（具体程序） | 混用是常见错误来源：`session/load` 是协议里可选的，不是「协议不支持」 |
| **reverse request** | **反向请求** | ACP 允许 agent 向 client 发起请求（`session/request_permission`、`fs/*`、`terminal/*`） |
| **capability** | **能力**（`agentCapabilities` 保留原文） | 指「这个实现支持哪些可选特性」，不是权限 |
| **preset** | **预设** | `ACP_AGENT_PRESETS` 的一条 |
| **fallback / degrade** | **降级 / 退化** | 如「缺 `session/load` 时退化为 `session/new`」 |
| **sandbox** | **沙箱** | `BRAIN_HOME` / `WORKER_HOME` |
| **watchdog** | **看门狗** | 崩溃重拉的外层循环 |
| **idempotent** | **幂等** | — |
| **daemon** | **守护进程** | 本文也直接用 daemon / 「常驻进程」 |

---

## 5. 事实状态表（先看这张，别被旧文档带偏）

| 事实 | 状态 | 证据/备注 |
|---|---|---|
| 默认大脑是 `auto`，不是固定 kiro | ✅ 代码 | `brain-agents.ts` `resolveAgent()` |
| kiro 预设可用 | ✅ 实测 | `docs/接入-OpenCode.md` / 现有 daemon |
| opencode 预设可用（`session/load`、无反向请求） | ✅ 实测 | `docs/接入-OpenCode.md` §3.3 |
| 任意兼容 ACP 的 agent 都「无需改代码」 | ⚪ **不成立** | 需要 load/resume、反向请求、首帧/心跳、image 能力适配 |
| `session/load` 是 ACP 通用能力 | ⚪ **不成立** | DSH 只有 `session/resume`；`load` 返回 `-32601` |
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
