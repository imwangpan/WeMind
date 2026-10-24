# 接入 DeepSeek（评估与实施方案）

> **状态**：官方 DSH **已接入，微信 brain + worker E2E 均通过**（2026-10-24，M1/M2 已实现）；真机实测 `dsh 0.2.1-rc.2`：`initialize` / `session/new` / `prompt` / 工具调用 / `close` / `resume`（上下文保留）/ `load`（-32601）/ 带图（-32602）/ stdio MCP 已验。
> **范围**：daemon 的常驻「大脑」（形态②，ACP）。MCP 客户端形态另见 §2.4。
> **相关文档**：[接入-OpenCode.md](接入-OpenCode.md)（同类接入的实测样板）· [接入其它-ACP-Agent.md](接入其它-ACP-Agent.md)（ACP 换大脑通用指南）· [repowiki/06-ACP-大脑与沙箱](repowiki/06-ACP-大脑与沙箱.md)。

---

## 0. TL;DR

- **DeepSeek 本身不是现成的 ACP CLI**。要像 kiro / opencode 一样当 daemon 大脑，实际接入的是 **DeepSeek Harness（`dsh`）的 ACP profile**；另有一个社区适配器 `deepseek-acp` 和「裸 API」两条备选。
- **推荐方案 A（长期）**：官方 `@deepseek-ai/dsh --profile acp`。官方维护、与 DeepSeek 模型/工具/沙箱同源；代价是 WeMind 侧要补 4 类通用能力（**模型路由选择**、`session/resume` 兜底、反向请求应答、首帧/心跳）。
- **方案 B（暂不采用）**：社区 `deepseek-acp`。按你的要求先只用官方 DSH；B 仅保留为备查（若官方 `image` 永远不打开且收图是硬需求，再讨论）。
- **方案 C（不推荐作平替）**：直接调 DeepSeek OpenAI 兼容 API。需要新写一层「Brain」和工具循环，等于自造迷你 agent，能力与 kiro/opencode 不对等；仅在「只要聊天、不要工具」时考虑。
- **已实测（2026-10-24，桌面端 `dsh 0.2.1-rc.2`）**：
  - ACP 只广告 `sessionCapabilities {close,list,resume}`（**无 load**）、`mcpCapabilities {http:true}`、`promptCapabilities {image:false}`；
  - `session/load` → **-32601**；`session/resume` 在 `close` + 强杀后可用，且**多轮上下文保留**（PINEAPPLE 实测通过）；
  - 带图 `session/prompt` → **-32602**（inline image not advertised）；
  - `session/new` 默认模型是 `deepseek-official/deepseek-v4-flash`，**该路由需要 `DEEPSEEK_API_KEY`**；桌面端登录态对应的是 `deepseek-account/deepseek-flash`，**必须用 `session/set_config_option` 显式切换**，否则即使桌面已登录也会报 `no API key`；
  - 首帧实测约 **1.0–2.3s**（简单/工具提示），正文在回合结束前一次性提交；会发 `agent_thought_chunk` / `tool_call` / `usage_update` 保持活动；
  - 未观察到反向请求；stdio `mcpServers` 被 `session/new` 接受；stdout 会混入一行非 JSON 日志（当前客户端会忽略）。
- **微信 E2E 已通（2026-10-24）**：`spawn deepseek` → 旧 opencode session 不可 resume（`-32602 session is not resumable`）→ 回退 `session/new` → `model set` → `prompt ok` → 用户收到「你好！很高兴见到你 😊」。**后续微信侧 `session/resume ok ... mcp=[test-echo]` 亦已实证**（M3 微信链路测试中）。
- **Worker E2E 已通（2026-10-24）**：`task` 派发 → `spawn deepseek worker` → `model set` → `session/new` → `prompt ok`（2.3s，含 tool_call）→ `hello.txt`；`task-reply` 第二轮读文件输出 `hello`；`task-stop` 后 idle。
- **微信侧动态 MCP + 图片拒绝已实测（2026-10-24）**：`MCP`/`加载 test-echo`/调用（答 `MCP-OK`，调用记录落盘）/`卸载` 全链路通过；发图收到友好拒绝（`image unsupported by current brain; rejected gracefully`）。
- 工作量：**M0 冒烟 0.5 人日；MVP 2–3 人日；含 MCP/worker/记忆继承的完整对齐 5–7 人日**。
- 最大未决项从「凭据隔离」变成「**模型路由 + 凭据来源**」：桌面登录可用，但需把 `DSH_HOME` 的 `.credentials.yaml` 带进沙箱（或改用 `DEEPSEEK_API_KEY`），并显式选 `deepseek-account` 路由（§8 R1/R18）。

---

## 1. 评估边界：三种「接入 DeepSeek」

| 路线 | 实际接入物 | 与 kiro/opencode 对等？ | 结论 |
|---|---|---|---|
| **A. 官方 DSH ACP** | `dsh --profile acp`（`@deepseek-ai/dsh`） | 基本对等（工具、MCP、沙箱、会话） | **推荐长期方案** |
| **B. 社区 ACP 适配器** | `npx deepseek-acp`（`xintaofei/deepseek-acp`） | 对等，且 ACP 面更丰富 | **推荐冒烟/回退** |
| **C. 裸 DeepSeek API** | OpenAI 兼容 `chat/completions` | 不对等（无文件/命令/MCP/技能） | 仅聊天场景备选 |

> 一句话：**A 是「用 DeepSeek 的 agent」，C 是「用 DeepSeek 的模型」**。WeMind 现在的 `kiro` / `opencode` 都是前者，所以主方案也应是前者。

---

## 2. WeMind 侧现状（只列与接入相关的约束）

### 2.1 daemon 的大脑机制

`acp-brain.ts` 维护一个常驻 ACP agent 子进程，只使用标准 ACP 方法：

| 方法 | WeMind 的用法 | 硬依赖 |
|---|---|---|
| `initialize` | 握手，`clientCapabilities: {}` | 是 |
| `session/new` | 每用户一个会话，`cwd = BRAIN_HOME`，`mcpServers: []` | 是 |
| `session/load` | 进程重建后按 `sessionId` 恢复多轮上下文 | **是（当前唯一恢复路径）** |
| `session/prompt` | 发一轮消息（文本 + 可选图片） | 是 |
| `session/update` | 拼 `agent_message_chunk`；`tool_call`/`tool_call_update` 进步；`agent_thought_chunk` 标记思考 | 是（弱依赖） |

`worker-acp.ts` 是同一套逻辑的「任务执行」副本（独立进程、独立 session、更长超时），所以**大脑侧的任何协议适配都要同步到 worker**。

### 2.2 预设与沙箱

- 预设表：`packages/wechat-daemon/src/brain-agents.ts` 的 `ACP_AGENT_PRESETS`。
- 选择优先级：`WEMIND_BRAIN`（env）> `<数据目录>/brain.json` > `auto`（`kiro → opencode → gemini → deepseek`）。
- 沙箱：`BRAIN_HOME`（默认 `<数据目录>/brain-home`），通过预设的 `homeEnvVar` 指向 agent 的配置目录；`configSubdir` 决定配置目录在沙箱内的相对位置。
- MCP：brain 默认空；微信指令「加载/卸载」改激活集，重启 ACP 生效；`wechat` 永久禁止（防回环）。**传输方式按 agent 分派**：kiro/opencode 写各自的配置文件；DSH 走 ACP `session/new` 的 `mcpServers`；catalog 也按 agent 各自的约定读取（详见 §5.3 M3）。
- 记忆继承：`mirrorRealKiro()` 把 `realHome` 下的 `inheritDirs` 目录 junction 进沙箱，`inheritFiles` 单文件拷入。

### 2.3 现有客户端对「新 agent」的隐含假设

这些是 kiro / opencode 实测下来「没出问题」的假设，换成 DSH 必须逐条复核：

1. **agent 不发反向请求**（`session/request_permission`、`fs/*`、`terminal/*`）。当前 `handleFrame` 只处理响应和 `session/update`，其它带 `id` 的帧会被静默丢弃 → 一旦 DSH 发权限请求，双方会互相等到超时。
2. **`session/load` 可用**。DSH 官方 ACP 明确没有 `session/load`（只有 `session/resume`）。
3. **首帧来得快**。`FIRST_FRAME_MS` 默认 25s；DSH 官方 ACP 以「已提交消息」为单位发正文，纯推理阶段可能长时间没有 `agent_message_chunk`。
4. **MCP 走 agent 配置文件**。DSH 的 MCP 通过 ACP `session/new` 的 `mcpServers` 挂载，不读 kiro 的 `settings/mcp.json`——每个 agent 只读自己的配置。
5. **静默期靠 activity 帧刷新心跳**。`index.ts` 每 15s 检查 `lastProgressAt`，只有 `session/update` 帧会刷新它；committed-only 的 DSH 会被当成「一直静默」，从而每 15s 发一条进度，烧掉微信的 10 条连发额度。

> 结论：**协议层不是「完全不用改」**。好消息是这 5 条都能做成通用能力，不只服务 DeepSeek。

### 2.4 不在本文范围：DSH 作为 MCP 客户端

另一种方向是把 WeMind 的 `@wemind/wechat-mcp` 配进 DSH，让 DSH 主动调微信工具（DSH 是 MCP 客户端，微信是工具集）。这属于「形态①」，与本文的「DSH 当大脑」是反方向；两者**不能对同一个 bot token 同时跑**（会抢消息/回环）。本文只做形态②。

---

## 3. DeepSeek 侧可用的三个入口

### 3.1 官方：`@deepseek-ai/dsh` + `--profile acp`

**事实（截至 2026-10-24）**：

- npm 最新 `@deepseek-ai/dsh@0.2.1-rc.2`，bin `dsh`；依赖 `@deepseek-ai/dsh-acp-app` / `@deepseek-ai/dsh-acp` 同版本。
- **桌面端已自带 CLI**：安装在 `<DeepSeek Harness 安装目录>` 下的 `resources\runtime\cli\bin\dsh.cmd`（常见为 `$env:LOCALAPPDATA\Programs\DeepSeek Harness\...`；安装器也可能把它放在其它盘/目录，用 `Get-Command dsh` 或实际安装位置确认）。`dsh --version` 输出 **0.2.1-rc.2**；**该目录只有 `dsh.cmd`（没有无扩展名的 `dsh`）**，所以预设的 `binWin` 要写 `dsh.cmd`（或 `WEMIND_BRAIN_BIN` 指向实际绝对路径），否则 `onPath("dsh")` 找不到。
- 启动：`dsh --profile acp`，stdio 上的纯 ACP JSON-RPC；`dsh --profile acp --help` 打印帮助后退出，不占 stdin/stdout。
- 随附 profile 默认用 `deepseek-official` + `deepseek-v4-flash` 建会话；实测 `session/new` 返回的 `configOptions` 含 `model`（`deepseek-official/deepseek-v4-flash`、`deepseek-account/deepseek-flash`、`deepseek-account/deepseek-v4-pro`）和 `reasoning_effort`（默认 `high`）。
- 官方 ACP 的定位是 **automation-only**：只暴露标准 ACP v1，不提供 DSH 专属的编辑器呈现（标题、计划卡片、终端卡片、elicitation 等）。
- 0.2.x 的协议面（HEAD 文档 + 本机实测）：
  - `session/new` / `session/list` / `session/resume` / `session/close` / `session/prompt` / `session/cancel` / `session/set_config_option`；
  - `session/update` 包含**已提交的 assistant 消息与 thought、通用工具生命周期、配置变化、上下文用量**；
  - **不支持 `session/load`**、fork、删除、transcript 回放、附加目录、SSE/ACP 传输 MCP；
  - `session/new` 会校验并挂载 **stdio / HTTP MCP**；初始连接失败会回滚未发布的 Agent；
  - 图片：仅在持久附件存储 + 当前路由支持时公布/接受。
- **实测 capabilities（2026-10-24，`dsh 0.2.1-rc.2`）**：

  ```json
  {
    "protocolVersion": 1,
    "agentInfo": { "name": "deepseek-harness-acp", "version": "0.0.1" },
    "agentCapabilities": {
      "mcpCapabilities": { "http": true },
      "promptCapabilities": { "image": false, "audio": false, "embeddedContext": false },
      "sessionCapabilities": { "close": {}, "list": {}, "resume": {} }
    },
    "authMethods": []
  }
  ```

  - 无 `loadSession`；`session/load` → `-32601 Method not found`。
  - `session/resume` 在 `session/close` 后、以及 `taskkill /T /F` 强杀后都成功；**真实多轮验证通过**（先记 `PINEAPPLE`，重启后 resume 再问，答出 `PINEAPPLE`）。
  - 带图 `session/prompt` → `-32602 Invalid params: inline image prompts were not advertised by this connection`。
  - `session/new` 不需要 API key；真正 `session/prompt` 才需要凭据，且**取决于选中的 provider 路由**：
    - 默认 `deepseek-official/deepseek-v4-flash`：需要 `DEEPSEEK_API_KEY`，否则 `-32603 ... no API key for provider route "deepseek-official"`；
    - `deepseek-account/deepseek-flash` / `deepseek-v4-pro`：使用桌面端登录态（`$DSH_HOME/.credentials.yaml` 的 `deepseek-account-platform/default` token），无需 API key。
  - **切换模型**：`session/set_config_option` 的参数是 `{ sessionId, configId: "model", value: "[\"deepseek-account\",\"deepseek-flash\"]" }`；成功后 configOptions 的 `currentValue` 立即变化。`resume` 会保留这个选择。
  - **实测首帧**：简单 prompt 约 2.26s；工具 prompt 首帧 1.23s、正文 3.86s；`session/update` 出现 `agent_thought_chunk` / `tool_call` / `tool_call_update` / `usage_update` / `agent_message_chunk`。
  - 未观察到 `session/request_permission` 等反向请求（本轮 3 次 prompt）。
  - stdio `mcpServers` 被 `session/new` 接受（用一个假 stdio MCP 验证）；HTTP 能力已广告。
  - **stdout 不纯**：DSH 会输出 `[llm-deepseek-account] model listing ...` 这类非 JSON 行；当前 `acp-brain.ts` 的解析器会忽略，不影响 JSON-RPC，但排查时不要把它当协议帧。

- **版本敏感**：更早的 `0.1.0-rc.6` 被社区实测为「仅支持新会话、不广告 load/resume/list、只返回已提交文本、拒绝非空 `mcpServers`」（见 `dsh-openclaw-acp` 的 README）。所以**必须锁版本、以实际安装版本实测为准**。

**优点**：官方维护、与模型/工具/沙箱同源、无第三方供应链；resume / list / close、工具生命周期、stdio+HTTP MCP 已具备，桌面登录态可用。
**缺点**：无 `session/load`；正文非逐 token；**当前 `image:false`（微信收图不可用）**；默认模型路由需要 API key，**必须显式选 `deepseek-account` 才能复用桌面登录**；ACP 面偏「自动化」；仍是 RC；Node 要求高（见 §8）。

### 3.2 社区：`deepseek-acp`

**事实（截至 2026-10-24）**：

- npm `deepseek-acp@0.9.0`，bin `deepseek-acp`；`engines.node >= 22`。
- 定位：把 DeepSeek Harness 包成**面向编辑器的完整 ACP agent**；自带 DSH 内核 `0.1.5-rc.1`（比官方 0.2.1 旧）。
- 启动：`deepseek-acp`（无参数即 server 模式）；`--setup` 交互式写入 `$DSH_HOME/.credentials.yaml`（`DEEPSEEK_API_KEY`，0600）。
- 能力：逐 token 流式、`agent_thought_chunk`、工具卡片、`session/load`/`list`/`resume`/`close`、按会话挂 MCP（stdio/HTTP）、图片、权限提示、技能、`usage_update`、上下文压缩。
- 沙箱：默认 `workspace-write`，可写根 `{session cwd, 系统临时目录}`；越界默认拒绝，模型可通过 `session/request_permission` 申请单次提权；Windows 用 PowerShell。
- 明确不做：`fs/write_text_file` 代理、后台任务、上游 `packages/extensions/`。

**优点**：对 WeMind 现有客户端最友好（`session/load`、流式、工具事件、MCP 都有），M0 打通成本最低。
**缺点**：非官方（README 自述「not affiliated with DeepSeek」）；内核比官方旧；第三方供应链与长期维护风险；同样会发 `session/request_permission`。

### 3.3 裸 API：DeepSeek OpenAI 兼容接口

- 只需要「聊天」时，写一个 `api-brain.ts`：`stream: true` 的 `chat/completions`、每用户历史落盘、图片走 `image_url`。
- 但 WeMind 的 `askBrain` 契约背后是「会自己用工具的 agent」；裸 API 要补齐工具循环（读文件、跑命令、搜网页、MCP），否则和 kiro/opencode 不是同一档能力。
- 现状：仓库里**没有** `Brain` 接口抽象（`acp-brain.ts` 直接暴露 `askBrain`/`newSession`/`restart`，`index.ts` 直接调用），所以方案 C 还需要一次接口抽取 + 调用方改造，**不是「加个文件」**。

### 3.4 对比总表

| 维度 | 官方 `dsh --profile acp` | 社区 `deepseek-acp` | 裸 API |
|---|---|---|---|
| 身份 | DeepSeek 官方 | 第三方（MIT） | 自研 |
| 版本 | 0.2.1-rc.2（桌面端自带 `dsh.cmd`） | 0.9.0（内核 0.1.5-rc.1） | — |
| 安装 | 无需另装（桌面端 CLI）；或 `npm i -g @deepseek-ai/dsh@0.2.1-rc.2` | `npx -y deepseek-acp@0.9.0` / 全局 | 无 |
| Node | 22+（本机 24 满足） | ≥22 | 仓库现有 ≥20 |
| `session/load` | ❌（有 `session/resume`） | ✅ | 自维护 |
| 会话恢复 | `resume` 保留上下文（实测）；`close`/强杀后可用 | `load` | 自维护 |
| 逐 token 正文 | ❌（已提交消息） | ✅ | ✅（流式） |
| 首帧 | 实测 1.0–2.3s（简单/工具） | 未测 | 取决于网络 |
| 工具进度 | ✅（`tool_call`/`usage`/`thought`） | ✅（卡片） | 需自建 |
| MCP | ✅ stdio/HTTP（session/new，实测 stdio 接受） | ✅ stdio/HTTP | 需自建 |
| 图片 | ❌ 实测 `image:false`，带图 `-32602` | ✅（README 称） | ✅ |
| 认证 | 桌面登录走 `deepseek-account`；默认 `deepseek-official` 需 `DEEPSEEK_API_KEY` | `DEEPSEEK_API_KEY` | API key |
| 模型 | `deepseek-account/{deepseek-flash,v4-pro}`；需 `set_config_option` 切换 | 会话内选择 | 自选 |
| 反向请求 | 本轮未观察到；权限请求可能存在 | 可能有 | 无 |
| 沙箱 | DSH `workspace-write` | 同源 | 无 |
| 供应链/维护 | 官方 | 第三方 | 自己 |

---

## 4. 兼容性评估（对照 WeMind 的硬依赖）

| # | WeMind 依赖 | 官方 dsh | 社区 deepseek-acp | 处置 |
|---|---|---|---|---|
| 1 | `initialize` + `clientCapabilities:{}` | ✅ 标准 ACP v1 | ✅ | 直接复用 |
| 2 | `session/new`（绝对 cwd） | ✅；会返回两个 provider 组 | ✅ | 直接复用 |
| 3 | `session/prompt`（text + image） | ❌ 实测 `image:false`，带图 → `-32602` | ✅ | **收图需走 B 或等官方；MVP 对 DSH 禁用图片并友好提示** |
| 4 | `agent_message_chunk` 拼正文 | ✅（回合末整段） | ✅（逐 token） | 可复用；官方有 thought/tool/usage 帧保持活动 |
| 5 | `tool_call` / `tool_call_update` 进步 | ✅（实测 2 次工具调用） | ✅ | 可复用 |
| 6 | `agent_thought_chunk` 思考态 | ✅（实测） | ✅ | 可复用 |
| 7 | `session/load` 自愈恢复 | ❌ `-32601`（有 `session/resume`） | ✅ | **新增 `session/resume` 兜底；实测 resume 后上下文保留** |
| 8 | 反向请求不应答 | 🟡 本轮未观察到；权限请求可能存在 | ⚠️ 可能发 permission | **仍建议新增通用应答器** |
| 9 | MCP 配置来源 | 无 kiro 式文件；走 ACP `mcpServers`（stdio 实测接受，`http:true`） | 走 ACP `mcpServers` | **按 agent 自己的 catalog；DSH 用中立 catalog + `mcpViaAcp`** |
| 10 | 首帧 25s | ✅ 实测 1.0–2.3s（简单/工具）；纯推理仍可能静默 | ✅ | **预设 `firstFrameMs` 60s 兜底（≤ idle）** |
| 11 | Windows 启动 | `dsh.cmd` → shell | `npx.cmd` → shell | 预设 `shell: true` |
| 12 | 进程树清理 | `taskkill /T` 已有 | 同 | 直接复用 |
| 13 | `wemind brain check` 20s | ✅ 实测握手 1–2s；首次冷启动仍建议放宽 | ⚠️ npx 更慢 | 放宽到 60s |
| 14 | `auto` 探测 | ⚠️ 只有 `dsh.cmd`，`onPath("dsh")` 找不到 | npx 不参与 | 预设 `binWin: "dsh.cmd"`，或让 `onPath` 补试 `.cmd` |
| 15 | 静默期 15s 心跳 | 🟡 有 thought/usage/tool 帧，通常能刷新；极端纯推理仍可能静默 | ✅ 流式帧持续刷新 | **预设 `heartbeatMs` / `progressMode: "committed"` 兜底** |
| 16 | **模型/认证路由** | ⚠️ 默认 `deepseek-official` 需 API key；桌面登录是 `deepseek-account`，**必须显式选** | ✅ `DEEPSEEK_API_KEY` | **新增 `model` 预设字段 + `session/set_config_option`** |

**结论**：官方方案要补 **5 类**：模型路由、`session/resume`、图片（硬缺口）、反向请求、首帧/心跳。前 2 类已实测可行，图片取决于官方后续是否打开 `image`。社区方案只差反向请求/心跳，但引入第三方依赖。**若微信收图是必保功能，短期内只能选 B 或对官方禁用收图。**

---

## 5. 推荐方案

### 5.1 选型结论

1. **主方案 A（已实现）**：官方 `dsh --profile acp` 作为 `deepseek` 预设，长期维护。
2. **暂不采用 B**：社区 `deepseek-acp` 仅备查；按你的要求先只走官方 DSH，不引入第三方依赖。
3. **不做 C**（除非明确只要聊天）。

### 5.2 目标架构

```text
微信 → daemon（长轮询）
        ├─ brain：常驻 `dsh --profile acp`
        │    cwd=DSH_HOME=<数据目录>/brain-home
        │    会话：session/new | session/resume
        │    MCP：session/new 的 mcpServers（按激活集）
        └─ worker：同一预设的独立进程
             cwd=任务目录，DSH_HOME=<数据目录>/worker-home
```

### 5.3 分阶段计划

#### M0 · 冒烟（0.5 人日，不改 WeMind 代码）

**目的**：用真机回答「官方 vs 社区，谁能跑、谁需要什么适配」，避免先写代码再返工。

1. **不需要另装 CLI**：桌面端已自带 `dsh.cmd`（0.2.1-rc.2），直接用它：

   ```powershell
   $dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"  # 按实际安装位置调整
   & $dsh --version                     # 0.2.1-rc.2
   $env:DSH_HOME = "$env:TEMP\dsh-probe"   # 用临时 home，避免污染真实会话
   & $dsh --profile acp --help
   ```

   > 只有 `dsh.cmd`（无无扩展名 `dsh`），所以 WeMind 预设要写 `binWin: "dsh.cmd"`，或让 `onPath` 对 `.cmd` 补试。

2. 用现有 `scripts/acp-smoke.mjs` 的同款思路（换行 JSON-RPC、`clientCapabilities:{}`）驱动 `dsh --profile acp`，逐项记录：
   - `initialize` 返回的 `agentCapabilities`（是否广告 `loadSession`、`session/resume`、`promptCapabilities.image`、`mcpCapabilities`）；
   - `session/new` 是否成功、返回哪些 `configOptions`；
   - `session/prompt` 的首帧时间、`session/update` 的 `sessionUpdate` 类型、正文是否分多 chunk；
   - **kill 进程后 `session/resume` 能否恢复上下文**（问「刚才的暗号是什么」）；
   - 是否出现任何带 `method` + `id` 的反向请求（尤其 `session/request_permission`）；
   - 非空 `mcpServers` 是否被接受（放一个假 stdio MCP，看是否被拉起）；
   - 图片 prompt 是否被接受。

   **本轮已验（2026-10-24）**：
   - `sessionCapabilities={close,list,resume}`，无 `loadSession`；`session/load` → `-32601`；
   - `promptCapabilities.image=false`，带图 prompt → `-32602`；
   - `session/resume` 在 `session/close` 后、强杀后都成功；**真实多轮（PINEAPPLE）验证上下文保留**；
   - `session/new` 不需要 API key；默认模型 `deepseek-official/deepseek-v4-flash` **需要 API key**，桌面登录对应 `deepseek-account/deepseek-flash`，需 `session/set_config_option` 切换；
   - `mcpCapabilities.http=true`，stdio `mcpServers` 实测被 `session/new` 接受；
   - 首帧 1.0–2.3s；`session/update` 含 `agent_thought_chunk` / `tool_call` / `usage_update` / `agent_message_chunk`；
   - 本轮未观察到反向请求；stdout 会混入非 JSON 日志行（客户端会忽略）。

   > 以上均已在本轮真机验证；微信 E2E 也已通过（见 §7.3 / 附录 A）。

3. 对社区适配器重复同一脚本：

   ```powershell
   npx -y deepseek-acp@0.9.0          # 或 deepseek-acp --setup 先存 key
   ```

4. **决策门**：
   - 官方：resume 可用 + 工具事件可用 + 无非预期反向请求 → 进入 M1；
   - 若官方 resume 不可用或不稳定 → 用 B 上线，同时把官方差距记为后续项；
   - 两者都出现权限请求卡死 → 先做 M2 的应答器再接。

**产出**：一份实测记录（版本、命令、返回帧、update 类型、耗时、异常），作为本文的「已实测」附录。

#### M1 · 预设 + 沙箱（0.5–1 人日）✅ 已实现

在 `brain-agents.ts` 增加：

```ts
deepseek: {
  name: "deepseek",
  bin: "dsh",
  binWin: "dsh.cmd",             // 桌面端只有 dsh.cmd；经 shell 由 PATHEXT 解析
  args: ["--profile", "acp"],
  shell: true,
  homeEnvVar: "DSH_HOME",        // 指向 brain 沙箱 → 会话/技能隔离
  realHome: path.join(os.homedir(), ".dsh"),
  inheritDirs: ["skills"],
  inheritFiles: ["AGENTS.md"],
  // 新增字段（见 §6）：
  model: '["deepseek-account","deepseek-flash"]', // 不选就落到 official 路由，需要 API key
  restore: "resume",
  firstFrameMs: 60_000,          // 实测 1–4s；60s 只兜底真死/超长静默（≤ idle）
  heartbeatMs: 60_000,           // 有 thought/usage 帧时通常不触发；极端静默兜底
  images: false,                 // 当前 DSH ACP 不接受图片
  credentialFile: ".credentials.yaml", // 从 ~/.dsh 新者胜同步进沙箱
  mcpViaAcp: true,               // MCP 不写文件，随 session/new|resume 的 mcpServers 下发
},
```

要点：

- **凭据来源二选一**：
  1. 桌面登录态：`ensureBrainHome()` 会把真实的 `~/.dsh/.credentials.yaml` **新者胜同步**进 `BRAIN_HOME`（本轮实测可行；注意这是敏感文件，Windows 无 600 权限，沙箱目录要收紧）；
  2. API Key：`DEEPSEEK_API_KEY` 由 daemon 环境提供，并把 `model` 设成 `deepseek-official/deepseek-v4-flash`。
- **模型必须显式选**：默认 `deepseek-official` 需要 API key；桌面登录只对应 `deepseek-account`。不选就会 `no API key`，不是「桌面没登录」。
- **不要**把 `DEEPSEEK_API_KEY` 写进预设的 `env`（会把密钥固化进源码/构建产物）；daemon 继承进程环境即可。
- `configSubdir` 留空：`DSH_HOME` 本身就是 home。
- MCP 走 `mcpViaAcp: true`：**不写任何 MCP 配置文件**，激活集由 `toAcpMcpServers()` 转成 `session/new|resume` 的 `mcpServers` 下发（见 M3）。每个 agent 只读自己的 MCP 配置；DSH 的 catalog 用 `WEMIND_MCP_CATALOG` 指向中立文件。
- `AUTO_PROBE_ORDER` 末尾追加 `"deepseek"`（不要插到 kiro/opencode 前面，避免老用户装了就悄悄换大脑）；`auto` 仍优先 kiro/opencode。
- 文档标注 **Node ≥22**；`agentProblem` 对 deepseek 找不到二进制时提示 `--bin`。
- **图片**：`image:false`，`index.ts` 在 `askBrain` 前拦截微信图片，回一句「当前大脑暂不支持看图……」，不会以 `-32602` 失败重试。

#### M2 · ACP 客户端能力适配（1–2 人日，brain + worker 同步）✅ 已实现

1. **会话恢复兜底**（`acp-brain.ts` / `worker-acp.ts` 的 `ensureSession`，已实现）：

   ```ts
   const methods = AGENT.restore === "resume" ? ["resume"] : ["load", "resume"];
   if (saved) {
     for (const method of methods) {
       try {
         await request(`session/${method}`, { sessionId: saved, cwd, mcpServers: [] }, REQ_TIMEOUT);
         await applyModel(saved);
         return saved;
       } catch { /* 试下一个；都失败则 session/new */ }
     }
   }
   ```

   `session/resume` 的入参已实测：`{ sessionId, cwd, mcpServers: [] }`；DSH 走 `restore: "resume"`，其余 agent 仍先 `load`。

1b. **模型路由选择**（DSH 必须；否则落到 `deepseek-official` 报 no API key）：

   ```ts
   // ensureSession() 返回后调用；resume 会保留上次选择，但配置变更时需重设
   if (AGENT.model) {
     await request("session/set_config_option", {
       sessionId: sid,
       configId: "model",
       value: AGENT.model,   // '["deepseek-account","deepseek-flash"]'
     }, REQ_TIMEOUT);
   }
   ```

   实测 `session/set_config_option` 的参数就是 `{ sessionId, configId, value }`；成功后 `configOptions.currentValue` 立即变化。可选值从 `session/new` 的 `configOptions` 里取（当前是 `deepseek-official/deepseek-v4-flash`、`deepseek-account/deepseek-flash`、`deepseek-account/deepseek-v4-pro`）。

2. **反向请求应答器**（`handleFrame` 顶部，brain + worker）：

   ```ts
   if (typeof f.id === "number" && f.method) {
     if (f.method === "session/request_permission") {
       const options = f.params?.options ?? [];
       // 默认拒绝（安全）；可信部署可用 WEMIND_ACP_AUTO_ALLOW=1 选 allow_once
       const pick = process.env.WEMIND_ACP_AUTO_ALLOW === "1"
         ? options.find((o: any) => o.kind === "allow_once" || o.kind === "allow_always")
         : undefined;
       child.stdin.write(JSON.stringify({
         jsonrpc: "2.0", id: f.id,
         result: pick
           ? { outcome: { outcome: "selected", optionId: pick.optionId } }
           : { outcome: { outcome: "cancelled" } },
       }) + "\n");
     } else {
       child.stdin.write(JSON.stringify({
         jsonrpc: "2.0", id: f.id, error: { code: -32601, message: "Method not supported" },
       }) + "\n");
     }
     return;
   }
   ```

   注意：**必须应答**，否则 DSH 会一直等；默认拒绝比默认放行安全。

3. **首帧超时按预设覆盖**：

   ```ts
   const FIRST_FRAME_MS =
     Number(process.env.WECHAT_BRAIN_FIRST_FRAME_MS) ||
     AGENT.firstFrameMs ||
     25_000;
   ```

   worker 用 `WEMIND_WORKER_FIRST_FRAME_MS` 同样的优先级。

   > `firstFrameMs` 应 **≤ `WECHAT_BRAIN_IDLE_MS`（120s）**。实测首帧 1–4s，60s 已足够兜底；180s 没有意义：首帧一旦到达，判据就换成 idle；首帧超时只决定「一个帧都没有时等多久才重建」。真死 60s 后重建；纯推理若 60s 仍无任何帧，应该调 idle/心跳而不是继续拉长首帧。

4. **`wemind brain check` 放宽**：`checkAgent(ag)` 默认 20s → 60s（或读 `WEMIND_BRAIN_CHECK_MS`），否则 DSH/`npx` 冷启动会误报。

5. **（可选）`session/close`**：`restart()` / `newSession()` 杀进程前先发 `session/close`，让 DSH 干净落盘；失败忽略。

6. **静默期心跳适配（重要）**：`index.ts` 的 heartbeat 每 15s 在 `lastProgressAt` 超过 15s 时发一条进度，而 `lastProgressAt` 只靠 `session/update` 帧刷新。官方 DSH 没有逐 token 帧，纯推理阶段会连续发「还在思考/仍在处理」，约 8 条后触发 `CONSEC_SEND_LIMIT=10` 的「接近上限」并进入 `awaiting`，最终答案要等用户回「继续」才恢复。建议：
   - 预设加 `heartbeatMs`（如 60s）或 `progressMode: "committed"`；
   - committed 模式下只发一条「该大脑完成后一次性返回」的说明，后续不再按 15s 刷；
   - 不要用假 `activity` 掩盖真实卡死；`WECHAT_BRAIN_CAP_MS` 仍兜底。

#### M3 · MCP 注入 ✅ 已实现并真机验证（2026-10-24）

DSH 不读 kiro/opencode 的 MCP 配置文件；它自己的 MCP 通过 ACP `session/new` 的 `mcpServers` 挂载（stdio 实测接受，`http:true` 已广告）。**已落地**：

1. `agent-mcp.ts` 的纯函数 `toAcpMcpServers()`：
   - kiro `{ command, args, env }` → `{ name, command, args, env }`（env 转 `{name,value}[]`）；
   - opencode `{ type:"local", command:[...], environment }` → 拆 `command[0]` / `args` / `env`；
   - `{ url }` → `{ name, type:"http", url, headers }`；
   - 始终排除 `wechat`；**坏条目进 `skipped` 并记日志**（`isConvertibleToAcp` 供 `addMcp` 预校验）。
2. 预设 `mcpViaAcp: true`：`applySandbox`/`syncSettings` 跳过文件写入；`ensureSession` 把激活集（`activeMcpServers()`）/ worker 全量（`workerMcpServers()`）转成 `mcpServers` 传给 `session/new` / `session/resume`。
3. **catalog 按 agent 各自的约定读取，不跨 agent 借文件**：DSH 用 `WEMIND_MCP_CATALOG` 指向中立 kiro 格式文件（默认 `~/.dsh/settings/mcp.json` 不存在 → 未设 catalog 时为空）。
4. **坏条目防护**：官方 `session/new` 遇到起不来的 MCP 会回滚整个会话（实测 `mcp-client: initial connection or tool synchronization failed`）——`addMcp` 预校验拒绝无法转换的定义。

**真机验证（假 stdio MCP，echo 工具写 marker）**：`session/new` 挂载 → 模型调用工具（marker `called`）回答 `ok`；`session/resume` 带同一声明 → 再次调用（marker 第 2 次）回答 `okPINEAPPLE`。HTTP MCP 未真机实测（能力已广告）。

#### M4 · 记忆 / 技能继承 ✅ 已验收（2026-10-24，现场已还原）

DSH 的布局（官方文档）：

- 用户全局指令：`$DSH_HOME/AGENTS.md`（另有共享根 `$DSH_AGENTS_HOME/AGENTS.md`，默认 `~/.agents`）；
- 用户技能：`$DSH_HOME/skills`（另有 `~/.agents/skills`）；
- 项目技能：`<projectRoot>/.dsh/skills`、`<projectRoot>/.agents/skills`。

预设用 `realHome: ~/.dsh`、`inheritDirs: ["skills"]`、`inheritFiles: ["AGENTS.md"]` 复用 `mirrorRealKiro()`。**验收**：真实 `~/.dsh` 放测试 skill（secret `KIWANO`）+ `AGENTS.md` 规则（`MANGO-42`）→ brain/worker 两沙箱均可读，回答均 `CODEWORD=MANGO-42 SECRET=KIWANO`；验证后已还原。共享根 `~/.agents` 默认不被沙箱影响（`DSH_AGENTS_HOME` 不指向沙箱）。

#### M5 · 验证与文档 ✅（除图片/双真机账号外完成）

- `brain-agents.test.ts`：deepseek 预设断言（含 `mcpViaAcp`）；`agent-mcp.test.ts`：`toAcpMcpServers` 转换/跳过/预校验。
- 全量 136 tests 通过；`set_config_option` 失败路径真机验证（非法 model → `-32602 unknown model option` → 默认路由明确报 no API key）。
- `scripts/doctor.ps1` 升级守卫：dsh 版本 ≠ 0.2.1-rc.2 时提示先跑 `scripts/acp-probe.mjs` 回归。
- 多账号机制验证：双数据目录各自沙箱/凭据/session 独立；双真机微信账号待需要时再验。
- 文档同步：待办 / 本文附录 / `add-mcp` 配方 / README / CHANGELOG。

### 5.4 工作量汇总

| 阶段 | 内容 | 人日 |
|---|---|---|
| M0 | 官方/社区冒烟、决策门 | 0.5 |
| M1 | 预设 + 沙箱 | 0.5–1 |
| M2 | **model 选择** / resume / 反向请求 / 首帧 / 心跳 / 图片拦截 / check 超时 | 1–2 |
| M3 | MCP via ACP（✅ 已实现并验证） | 1–2 |
| M4 | skills / AGENTS.md 继承 | 0.5 |
| M5 | 测试 + 文档 | 0.5 |
| **合计** | MVP（M0–M2、M4–M5） | **2–3** |
|  | 完整对齐（含 M3、worker） | **5–7** |

---

## 6. 代码改动清单（文件级）

| 文件 | 改动 | 阶段 |
|---|---|---|
| `packages/wechat-daemon/src/brain-agents.ts` | 新增 `deepseek` 预设（`binWin: "dsh.cmd"`）；`AcpAgentPreset` 增 `model?` / `restore?` / `firstFrameMs?` / `heartbeatMs?` / `images?` / `credentialFile?`；`ResolvedAgent` 透传；`AUTO_PROBE_ORDER` 末尾加 `deepseek` | M1 |
| `packages/wechat-daemon/src/acp-brain.ts` | `session/set_config_option` 选 model；`session/resume` 兜底；反向请求应答器；首帧按预设覆盖；图片能力拦截；导出 `supportsImages`/`heartbeatMs` | M2 |
| `packages/wechat-daemon/src/worker-acp.ts` | 同步上述协议项（独立副本） | M2 |
| `packages/wechat-daemon/src/index.ts` | 静默心跳按预设放宽（`heartbeatMs` / `progressMode`）；收到图片但 agent `image:false` 时友好提示 | M2 |
| `packages/wechat-daemon/src/brain-check.ts` | 默认超时 20s → 60s（可 env 覆盖） | M2 |
| `packages/wechat-daemon/src/agent-mcp.ts` | `toAcpMcpServers()` 三种格式转换 | M3 |
| `packages/wechat-daemon/src/mcp-sandbox.ts` | `mcpViaAcp` 时跳过文件写入/`syncKiroSettings`；暴露 `activeMcpServers()` | M3 |
| `packages/wechat-daemon/src/brain-agents.test.ts` | 预设断言 | M5 |
| `packages/wechat-daemon/src/agent-mcp.test.ts` | 转换单测 | M5 |
| `docs/接入-DeepSeek.md` | 本文（已补真机实测附录） | M0/M5 |
| `docs/接入其它-ACP-Agent.md` / `README.md` | 预设表 + 使用说明 | M5 |

---

## 7. 配置与操作

### 7.1 安装与凭据

> 下面所有路径都是**占位/示例**：按你自己的 DeepSeek Harness 安装位置替换，不要照抄别人的本机路径。桌面端常见位置是 `$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`，也可能在其它盘。

**不需要另装 CLI**：桌面端已自带 0.2.1-rc.2。

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"  # 按实际安装位置调整
& $dsh --version     # 0.2.1-rc.2
```

**凭据二选一**：

```powershell
# 方式一：API Key（沙箱友好；对应 deepseek-official 路由）
$env:DEEPSEEK_API_KEY = "sk-..."

# 方式二：复用桌面登录态（实测可行；对应 deepseek-account 路由）
# 把 ~/.dsh/.credentials.yaml 复制/链入 BRAIN_HOME（沙箱），或让 DSH_HOME 直接指向真实 ~/.dsh
```

> - **必须选对路由**：桌面登录态只对 `deepseek-account` 有效；不显式选 model 时会落到 `deepseek-official`，报 `no API key`。预设里写 `model: '["deepseek-account","deepseek-flash"]'`。
> - `DEEPSEEK_API_KEY` 必须对 **daemon 进程**可见。用 `scripts/run-daemon.ps1` / pm2 启动时，请写进脚本/`ecosystem.config.cjs` 的 `env`，不要依赖交互式 shell。
> - `.credentials.yaml` 是敏感文件；复制进 `BRAIN_HOME` 后要收紧该目录权限（Windows 没有 POSIX 600，建议专用 OS 账号 + 目录 ACL）。
> - 桌面端 CLI 只有 `dsh.cmd`（无无扩展名 `dsh`）：预设用 `binWin: "dsh.cmd"`；若想用绝对路径，`WEMIND_BRAIN_BIN` 指向上面的 `dsh.cmd`。

### 7.2 切换与自检

```powershell
npm run build
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"  # 按实际安装位置调整
wemind brain set deepseek --bin $dsh --restart
wemind brain                 # 应显示 name=deepseek、bin=...dsh.cmd、home_env=DSH_HOME
wemind brain check           # 真起进程跑 initialize + session/new（60s 内）
```

> 桌面端 `dsh.cmd` 不一定在 daemon 进程的 PATH 上（尤其旧 wrapper），所以 **`--bin` 传绝对路径最稳**。`brain check` **不验证 prompt/模型**；模型路由与上下文要用 `scripts/acp-probe.mjs`（`ACP_MODEL` + 两次 prompt）。

### 7.3 验收（微信端到端）

1. 发一条消息 → `daemon.log` 出现：
   `spawn deepseek ... → initialized → session/new|resume → prompt ok`，微信收到非空回复。
2. 杀 daemon 再启动，追问「上一轮我说了什么」→ 走 `session/resume`，上下文仍在。
3. 发一个 >30s 的任务 → 不因首帧超时被杀；微信能看到「步骤」进度，且静默期**不会**每 15s 刷一条「还在思考」。
4. 发「新会话」→ 走 `session/new`，旧上下文清空。
5. 触发一次越界写（如让它在 `BRAIN_HOME` 外写文件）→ 观察 permission 请求被应答（拒绝或按 env 放行），**不能卡死**。
6. ✅ 发一张图片 → 友好拒绝（「当前大脑暂不支持看图…」；日志 `image unsupported by current brain; rejected gracefully`，无 `-32602` 重试；已实测 2026-10-24）。
7. 两个账号同时跑 → 各自 `brain-home` / `worker-home` 隔离，互不抢会话。
8. ✅ `加载 <MCP>` → 下一条消息生效（`session/new|resume` 带 `mcpServers`）；`wechat` 仍被禁止；DSH 不读 kiro 的 MCP 文件（M3 已实现，真机验证见附录）。
9. worker：`task "create hello.txt..." --cwd <临时目录>` → 文件 `hello.txt` 内容 `hello` + 输出 `DONE`；`task-reply "read hello.txt..."` → 输出 `hello`；`task-stop` → idle。日志见 `[wemind/wechat-daemon/worker] spawn deepseek ... → model set → prompt ok`。

### 7.4 回滚

```powershell
wemind brain set kiro --restart   # 或 opencode / unset
```

DSH 的会话都在 `brain-home/sessions`，删除该目录 + `brain-sessions.json` 即清空 DeepSeek 侧记忆；不影响 kiro/opencode 的沙箱。

---

## 8. 风险与未决项

| # | 风险 / 未决 | 影响 | 处置 |
|---|---|---|---|
| R1 | **凭据来源**：`DSH_HOME` 指向沙箱后，真实 `.credentials.yaml` 不可见 | 桌面登录态用不了，必须 API Key | 实测：把 `.credentials.yaml` 复制进沙箱即可；或用 `DEEPSEEK_API_KEY`。敏感文件，收紧目录权限 |
| R2 | 当前代码只调 `session/load`，DSH 返回 `-32601` | 自愈后**静默新建会话**，多轮记忆丢失 | 实现 `session/resume` 兜底；**已实测 resume 保留 PINEAPPLE 上下文（含 `taskkill /T /F` 强杀）** |
| R3 | 官方只发「已提交」正文；纯推理阶段可能无帧 | 首帧误杀 + 心跳刷屏 | 实测首帧 1–2.3s，有 thought/tool/usage 帧；预设 `firstFrameMs` 60s、`heartbeatMs` 60s 兜底 |
| R4 | 反向请求 `session/request_permission` 无人应答 | 整轮卡死到超时 | M2 通用应答器；默认拒绝，`WEMIND_ACP_AUTO_ALLOW=1` 才放行 |
| R5 | DSH 不读 kiro 式 MCP 文件；catalog 来源不同 | 动态 MCP 不可用/配错 | M3 按 agent 各自的 catalog；DSH 用 `WEMIND_MCP_CATALOG` 或 `mcpViaAcp`；stdio 已实测接受 |
| R6 | 第三方 `deepseek-acp` 供应链 / 维护 | 长期不可控 | 只作冒烟/回退；锁版本；不默认启用 |
| R7 | 版本是 RC，ACP 面可能漂移 | 升级即坏 | 锁 `0.2.1-rc.2`；升级先跑 M0 脚本；文档记录版本 |
| R8 | Node ≥22（社区包明确；官方以安装包为准），而仓库声明 ≥20 | 旧环境起不来 | 文档标注；`agentProblem` 加 `minNode` 检查；M0 记录 |
| R9 | DSH 的 Windows ACL 沙箱只限制普通 NTFS 写，不限制读/网络/进程可见性 | 微信侧提示注入可外带本机文件 | `allowFrom` 白名单；专用 OS 账号；`workspace-write`；不要把敏感目录设为 worker cwd |
| R10 | 模型/路由选择 | 不选就落到 official 路由，需 API key | 预设 `model` + `session/set_config_option`；桌面登录用 `deepseek-account` |
| R11 | 桌面端 CLI 只有 `dsh.cmd`，无无扩展名 `dsh` | `onPath("dsh")` 找不到，`auto`/预设判不可用 | 预设 `binWin: "dsh.cmd"`；或让 `onPath` 对 `.cmd` 补试；`WEMIND_BRAIN_BIN` 绝对路径兜底 |
| R12 | 多账号 / pm2 环境变量传递 | key 不生效 | 文档给 pm2 / `Start-Process -Environment` 示例 |
| R13 | 成本与长上下文 | 账单/延迟 | 限制 `allowFrom`；观察 usage；`WECHAT_BRAIN_CAP_MS` 兜底 |
| R14 | Windows `dsh.cmd` 经 shell 的引号/元字符 | 启动失败 | 复用现有 `spawnAgent` 的逐参数引号；`WEMIND_BRAIN_BIN` 可指向绝对路径 |
| R15 | **官方 `image:false`**，带图 prompt `-32602` | 微信收图/看图功能不可用 | M1 拦截并友好提示；若要保留收图，短期选 B `deepseek-acp` 或等官方 |
| R16 | 静默期心跳每 15s 一条 | 约 8 条后触发 10 条连发上限，最终答案要等用户回「继续」 | 预设 `heartbeatMs` / committed 模式；实测有 thought/usage 帧，触发概率降低 |
| R17 | `session/resume` 不重放历史更新 | WeMind 不需要回放；只要上下文在即可 | **已实测上下文保留**（PINEAPPLE）；只拼新回合 chunk |
| R18 | **默认模型路由与桌面登录不匹配** | 桌面已登录仍报 `no API key for deepseek-official` | 必须 `session/set_config_option` 到 `deepseek-account/*`；或改用 API key |
| R19 | DSH stdout 混入非 JSON 日志行 | 严格解析器可能报错/卡住 | 当前客户端忽略非 JSON；新增解析器要保持容错 |
| R20 | 社区 `deepseek-acp` 未实测 | 无法确认 image/load/权限行为 | 如选 B，先跑 `scripts/acp-probe.mjs`，不要直接上线 |

---

## 9. 决策建议

- **M1/M2 已实现**：`deepseek` 预设（`dsh.cmd` + `DSH_HOME` + `.credentials.yaml` 同步 + `model` 选择）、`resume` 兜底、反向请求应答、`firstFrameMs`/`heartbeatMs`、图片拦截。
- **M0 已真机验证**：`initialize` / `session/new` / prompt / 工具调用 / `close` / `resume`（上下文保留）/ `load`（-32601）/ 图片（-32602）/ stdio MCP 均已验；代码级集成测试 `A1=STORED`、`A2=PINEAPPLE` 通过；**微信 E2E 已通过**（`spawn deepseek` → `model set` → `prompt ok` → 收到回复）。
- **B 暂不采用**：按你的要求先只走官方 DSH；社区 `deepseek-acp` 仅保留在文档里备查。
- **若「微信收图」是必保功能**：官方当前 `image:false`，当前实现会友好拒绝；把「官方打开 image」作为跟进项，再讨论是否值得引入 B。
- **M3（MCP）已完成**：`mcpViaAcp` 已实现并真机验证（见 §5.3 M3）；HTTP MCP 实测与 resource/prompt 范围留待后续。

---

## 10. 参考

- DeepSeek Harness 仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 官方 ACP 服务器（automation-only，含方法矩阵与限制）：<https://github.com/deepseek-ai/deepseek-harness/blob/HEAD/packages/acp/acp/README.zh.md>
- 官方 ACP profile（`dsh --profile acp`，默认 `deepseek-v4-flash`）：<https://github.com/deepseek-ai/deepseek-harness/blob/HEAD/packages/bundle/acp-app/README.zh.md>
- npm `@deepseek-ai/dsh`（0.2.1-rc.2）：<https://www.npmjs.com/package/@deepseek-ai/dsh>
- 社区 `deepseek-acp`（0.9.0，Node ≥22，能力对比）：<https://github.com/xintaofei/deepseek-acp>
- `dsh-openclaw-acp`（DSH ACP 接微信/OpenClaw 的先例，记录了 0.1.0-rc.6 的限制）：<https://github.com/BeAChanger/dsh-openclaw-acp>
- DSH 用户指令（`$DSH_HOME/AGENTS.md`）：<https://github.com/deepseek-ai/deepseek-harness/blob/HEAD/packages/context/agent-instructions/README.zh.md>
- DSH 技能根目录（`$DSH_HOME/skills`、`~/.agents/skills`）：<https://github.com/deepseek-ai/deepseek-harness/blob/HEAD/packages/skill/skill-filesystem/README.zh.md>
- ACP `session/request_permission` 响应形状：<https://agentclientprotocol.github.io/typescript-sdk/types/RequestPermissionResponse.html>

---

## 附录 A · M0 实测记录（官方已完成，社区待跑）

> 实测环境：Windows 11 / 桌面端 `dsh 0.2.1-rc.2` / 隔离 `DSH_HOME`（复制 `.credentials.yaml`）/ 模型 `deepseek-account/deepseek-flash`。
> 工具：`scripts/acp-probe.mjs`（已提交到仓库，可复现）。

| 检查项 | 官方 `dsh --profile acp` | 社区 `deepseek-acp` | 结论 |
|---|---|---|---|
| 版本 / Node | 0.2.1-rc.2（桌面端 `dsh.cmd`）/ Node 24 | 未测 | 官方版本已锁定 |
| `initialize` 能力 | `close/list/resume`；无 `loadSession`；`mcp.http:true`；`image:false` | 未测 | 官方缺 load + image |
| `session/new` 返回 `configOptions` | 两个 provider 组：`deepseek-official/deepseek-v4-flash`、`deepseek-account/{deepseek-flash,v4-pro}`；`reasoning_effort=high`；无需 key | 未测 | **默认 official 路由需 key** |
| 模型切换 | `session/set_config_option {sessionId, configId:"model", value}` 成功；`currentValue` 立即变 | 未测 | 必须显式选 account |
| `session/prompt` 首帧 | 简单 2.26s；工具 1.23s；正文 3.86s | 未测 | 25s 默认够用；60s 兜底 |
| `session/update` 类型 | `agent_thought_chunk`、`tool_call`、`tool_call_update`、`usage_update`、`agent_message_chunk` | 未测 | 心跳有帧可刷新 |
| 正文 chunk 数 | 1（回合末整段） | 未测 | 拼正文不受影响 |
| kill → `resume` / `load` | resume ✅（close+强杀后，上下文保留 PINEAPPLE）；load ❌ `-32601` | 未测 | **resume 可替代 load** |
| 反向请求 | 3 次 prompt 均无 | 未测 | 仍需应答器兜底 |
| 非空 `mcpServers` | stdio 假 MCP 被 `session/new` 接受；`http:true` | 未测 | 可走 ACP MCP |
| 图片 prompt | ❌ `-32602` | 未测 | 官方收图不可用 |
| stdout 纯净性 | 混入 `[llm-deepseek-account] ...` 非 JSON 行 | 未测 | 解析器需容错 |
| 代码级 `askBrain` 集成 | `A1=STORED` → `restart()` → `A2=PINEAPPLE`；`model set` / `resume` 均成功 | — | **M1/M2 代码路径验证通过** |
| **微信端到端** | 收到「你好」→ `spawn deepseek` → 旧 opencode session `resume` 失败 → `session/new` → `model set` → `prompt ok` 693ms → 回复「你好！很高兴见到你 😊」 | — | **E2E 通过** |
| **worker E2E** | `task` 派发 → `spawn deepseek worker` → `model set` → `session/new` → `prompt ok` 2305ms（tool_call）→ `hello.txt`；`task-reply` 第二轮 1575ms → `hello`；`task-stop` idle | — | **worker E2E 通过** |
| **M3：MCP via ACP** | 假 stdio MCP 经 `toAcpMcpServers()` 转换：`session/new` 挂载 → 模型调用（marker `called`）答 `ok`；`session/resume` 再挂 → 再调用答 `okPINEAPPLE`；坏 MCP → `session/new` 回滚（`initial connection or tool synchronization failed`） | — | **M3 通过**（HTTP 未实测） |
| **M3：微信侧全链路** | 用户实测：`MCP` 列出 test-echo → `加载` → 下一条消息 `session/resume ok ... mcp=[test-echo]`，模型调用工具答 `MCP-OK`（调用记录落盘）→ `卸载` 激活集回空 | — | **微信侧通过**（含微信侧 `resume` 首次实证） |
| **M4：记忆/技能** | 真实 `~/.dsh` 放测试 skill（KIWANO）+ `AGENTS.md` 规则（MANGO-42）→ brain/worker 沙箱均可读，回答均 `CODEWORD=MANGO-42 SECRET=KIWANO`；现场已还原 | — | **M4 通过** |
| **M5：多账号机制** | 双数据目录各跑一轮：brain-home/worker-home 凭据各自独立，session id 不同，均答 `OK` | — | **机制通过**（双真机微信待需要时验） |
| **M5：model 失败路径** | 非法 model → `-32602 unknown model option`，随后默认路由明确报 no API key | — | 失败不静默 |
| **M5：图片友好拒绝（微信侧）** | 用户发图 → 收到「当前大脑暂不支持看图…」；日志 `image unsupported by current brain; rejected gracefully` | — | **通过**（无 `-32602` 重试） |
| **M5：微信派发 worker + 权限请求** | `任务：…` → worker spawn（`mcp=[test-echo]` 全量继承）→ 越界写被沙箱拒 → 2 次 `session/request_permission` 均被应答器拒绝（**不卡死**）→ agent 汇报阻塞 waiting | — | **机制通过**（越界拒绝属沙箱按设计；顺带修复重启后幽灵任务状态） |

> 结论：官方路线可行且 M1–M5 已落地（图片除外，上游 `image:false`）；关键增量是 **model 选择**、`resume` 兜底、图片拦截/心跳兜底、**MCP via ACP**。社区适配器按当前选择暂不采用，仅保留备查。

---

> **下一步**：M3–M5 已完成（见附录与待办文档）。剩余开放项：官方打开 `image` 后回归收图；HTTP MCP 实测；双真机微信账号；DSH 升级时先跑 `scripts/acp-probe.mjs` 回归（`doctor.ps1` 会提醒）。
>
> **后续待办**：M3–M5 已完成并回填（M3 动态 MCP ✅、M4 记忆/技能 ✅、M5 除图片[上游]与双真机账号外 ✅），明细与遗留见 [`待办-DeepSeek-M3-M5.md`](待办-DeepSeek-M3-M5.md)。
