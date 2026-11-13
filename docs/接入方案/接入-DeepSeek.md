# 接入 DeepSeek（评估、实施与实测）

> **2026-11-13 口径**：默认 `homeMode=direct`，WeMind 不写任何 Agent 配置，Agent 直接读真实 home，并与终端共享配置、技能、记忆与会话库；本文涉及 `brain-home` / `worker-home` 的描述仅适用于显式 `homeMode=sandbox`。

> **状态**：官方 DSH **已接入，微信 brain + worker E2E 均通过**（2026-10-24，M1/M2 已实现）；初测 `dsh 0.2.1-rc.2`、2026-11-03 在 **0.2.1-rc.3** 上复测并修复两处真机故障：**会话库与别的 agent 共用沙箱根**（改用 `--patch` 把会话 root 隔离到账号数据目录）、**用户 `- id: acp` 的模型被桌面端目录淘汰**（`wemind brain` 给替换提示）。`initialize` / `session/new` / `prompt` / 工具调用 / `close` / `resume`（上下文保留）/ `load`（-32601）/ 带图（-32602）/ stdio MCP 均已验。
> **实测环境**：Windows 11；桌面端 `dsh 0.2.1-rc.3`；隔离 `DSH_HOME`（复制 `.credentials.yaml`）；2026-11-12 真实配置复测（模型由真实 profile 的 `- id: acp` 决定，见 §7.6）。
> **实测范围**：DSH 0.2.1-rc.2 / rc.3 / rc.3 + 真实配置（M0 探针 + 微信 brain/worker E2E，见附录 A）｜ **最后核对**：2026-11-13。
> **范围**：daemon 的常驻「大脑」（形态②，ACP）。MCP 客户端形态另见 §2.4。
> **相关文档**：[接入-OpenCode.md](接入-OpenCode.md)（同类接入的实测样板）· [接入其它-ACP-Agent.md](接入其它-ACP-Agent.md)（ACP 换大脑通用指南）· [repowiki/06-ACP-大脑与沙箱](../repowiki/06-ACP-大脑与沙箱.md)。
>
> **怎么读**：本文把「**现行事实**」与「**当时的实施记录**」放在同一篇里，别混着读——
> §0 TL;DR、§3（DSH 的 ACP 面与实测 capabilities）、§7（配置与操作）、§8（风险与未决项）、附录 A 是**现行事实**，改行为时以这些为准；
> §5.3（M0–M5 分阶段计划、人日）与 §6（当时的文件级改动清单）是 **2026-10 的实施记录**，只作背景，其中「待做」的条目大多已完成——以 §0/§7 为准，不要照着计划表判断现在有什么。

---

## 0. TL;DR

- **DeepSeek 本身不是现成的 ACP CLI**。要像 kiro / opencode 一样当 daemon 大脑，实际接入的是 **DeepSeek Harness（`dsh`）的 ACP profile**；另有一个社区适配器 `deepseek-acp` 和「裸 API」两条备选。
- **推荐方案 A（长期）**：官方 `@deepseek-ai/dsh --profile acp`。官方维护、与 DeepSeek 模型/工具/沙箱同源；代价是 WeMind 侧要补 4 类通用能力（**模型路由选择**、`session/resume` 兜底、反向请求应答、首帧/心跳）。
- **方案 B（暂不采用）**：社区 `deepseek-acp`。按你的要求先只用官方 DSH；B 仅保留为备查（若官方 `image` 永远不打开且收图是硬需求，再讨论）。
- **方案 C（不推荐作平替）**：直接调 DeepSeek OpenAI 兼容 API。需要新写一层「Brain」和工具循环，等于自造迷你 agent，能力与 kiro/opencode 不对等；仅在「只要聊天、不要工具」时考虑。
- **已实测（2026-10-24，桌面端 `dsh 0.2.1-rc.2`）**：
  - ACP 只声明 `sessionCapabilities {close,list,resume}`（**无 load**）、`mcpCapabilities {http:true}`、`promptCapabilities {image:false}`；
  - `session/load` → **-32601**；`session/resume` 在 `close` + 强杀后可用，且**多轮上下文保留**（PINEAPPLE 实测通过）；
  - 带图 `session/prompt` → **-32602**（inline image not advertised）；
  - `session/new` 默认模型是 `deepseek-official/deepseek-v4-flash`，**该路由需要 `DEEPSEEK_API_KEY`**；即使 profile 里写着桌面端的默认，**ACP 桥也不用它**（2026-10-29 拆开 `app.asar` 找到真正原因：桥插件 `@deepseek-ai/dsh-acp` 的 bundle patch 里写死了 `- id: acp` 的 `provider/model`，这项由用户在自己的 profile 里覆盖）；2026-11-12 在 rc.3 实测，`deepseek-account/*` 已随 rc.3 移除，**当前有哪些可用路由只取决于本机 `settings.yaml` 配了哪些 provider**（官方 provider 或用户自己的网关），WeMind 不判断、也不枚举；用户在**真实 profile** 里写全 `- id: acp` / `- id: agent-default-model` / `- id: web-search-deepseek` 后，`session/new` 直接以用户日常的默认开局，WeMind 只镜像这份配置并在缺 `- id: acp` 时给出可粘贴的提示（`set_config_option` 保留给显式覆盖；§7.6）；
  - 首帧实测约 **1.0–2.3s**（简单/工具提示），正文在回合结束前一次性提交；会发 `agent_thought_chunk` / `tool_call` / `usage_update` 保持活动；
  - 未观察到反向请求；stdio `mcpServers` 被 `session/new` 接受；stdout 会混入一行非 JSON 日志（当前客户端会忽略）。
- **微信 E2E 已通（2026-10-24）**：`spawn deepseek` → 旧 opencode session 不可 resume（`-32602 session is not resumable`）→ 回退 `session/new` → `model set` → `prompt ok` → 用户收到「你好！很高兴见到你 😊」。**后续微信侧 `session/resume ok ... mcp=[test-echo]` 亦已实证**（M3 微信链路测试中）。
- **Worker E2E 已通（2026-10-24）**：`task` 派发 → `spawn deepseek worker` → `model set` → `session/new` → `prompt ok`（2.3s，含 tool_call）→ `hello.txt`；`task-reply` 第二轮读文件输出 `hello`；`task-stop` 后 idle。
- **`sandbox` 下会话目录已隔离（2026-11-03，rc.3）**：此前 DSH 的会话库落在共用沙箱根的 `sessions/`，kiro / pi 也会往同一个目录写；DSH 把别人留下的平铺文件当成自己的会话库，启动/恢复直接报 `unsupported flat-file layout`（`wemind brain check` 与微信侧都能复现）。现在预设 `isolateSessions: true`，`sandbox` 下启动前由 `prepareAgent()` 落盘 `<数据目录>/agent-sessions/deepseek/session-root-<brain|worker>.patch.yml`，用 DSH 自己的 `--patch` 把 `session-persistence-jsonl.root` 指到 `agent-sessions/deepseek/<role>`；用户 `--args` 里显式给了 `--patch` 就尊重用户、不追加。`direct` 不追加 `--patch`，使用真实 `~/.dsh` 会话库。
- **过期模型提示（2026-11-03，rc.3）**：桌面端升级会重写 `llm-pi-ai` 的 provider 模型目录，而用户自己补的 `- id: acp` 是独立一条、不会被自动迁移；模型不在目录里时 ACP 报 `no configured model`（看起来像 agent 坏了）。`wemind brain` 现在会检查这一条并给出可粘贴的替换片段（优先建议 `agent-default-model` 的值），**只提示、不替用户改真实 profile**（§4.14）。实测把 `- id: acp` 的 model 改成目录里现有的某个 id 后，`session/new` 的 `currentValue` 随之变化，`brain check` 通过。
- **微信侧动态 MCP + 图片拒绝已实测（2026-10-24）**：`MCP`/`加载 test-echo`/调用（答 `MCP-OK`，调用记录写入磁盘）/`卸载` 全链路通过；发图收到友好拒绝（`image unusable and no text; rejected gracefully`；带文字时按文字回答并注明图片被忽略）。
- 工作量：**M0 冒烟 0.5 人日；MVP 2–3 人日；含 MCP/worker/记忆继承的完整对齐 5–7 人日**。
- 最大未决项从「凭据隔离」变成「**模型路由 + 凭据来源**」：走哪个 provider、需要什么凭据由 DSH 自己的配置决定（官方 `deepseek-official` + `DEEPSEEK_API_KEY`，或用户自建的其它路由）；`deepseek-account` 已随 rc.3 移除（§7.6 / §8 R1/R18）。

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
| `session/new` | 每用户一个会话；`cwd` 默认是 `<账号>/workspace/brain`；`direct` 下发真实 catalog 全量，`sandbox` 下发激活集 | 是 |
| `session/load` | 进程重建后按 `sessionId` 恢复多轮上下文 | 否（**已不是唯一路径**：`restore: "resume"` 的 agent 直接走 `session/resume`；其余 agent 先 load、失败再 resume，都失败才 `session/new`） |
| `session/prompt` | 发一轮消息（文本 + 可选图片） | 是 |
| `session/update` | 拼 `agent_message_chunk`；`tool_call`/`tool_call_update` 进步；`agent_thought_chunk` 标记思考 | 是（弱依赖） |

`worker-acp.ts` 是同一套逻辑的「任务执行」副本（独立进程、独立 session、更长超时），所以**大脑侧的任何协议适配都要同步到 worker**。

### 2.2 agent 与沙箱

- agent 表：`packages/wechat-daemon/src/agents/brain-presets.ts` 的 `ACP_AGENT_PRESETS`。
- 选择优先级：`WEMIND_BRAIN`（env）> `<数据目录>/brain.json` > `auto`（`opencode → cline → qoder → gemini → deepseek → kiro`）。
- 配置目录：默认 `direct` 不注入 `DSH_HOME`，直接用真实 `~/.dsh`；`sandbox` 才用 `<账号>/brain-home` 或 `<账号>/worker-home`。`configSubdir` 决定配置目录在沙箱内的相对位置。
- MCP：`direct` 由真实配置决定（DSH 走 ACP，WeMind 把真实 catalog 全量下发）；`sandbox` 下 brain 默认空，微信指令「加载/卸载」改激活集，**只有激活集真变了才重启 ACP 生效**（`daemon-control.ts` 只在 `changed` 时调 `restartForMcpChange()`）；`wechat` 永久禁止（防它把消息发回自己）。**传输方式按 agent 分派**：kiro/opencode 写各自的配置文件；DSH 走 ACP `session/new` 的 `mcpServers`；catalog 也按 agent 各自的约定读取（详见 §5.3 M3）。
- 记忆继承：`direct` 下直接使用真实 home；`sandbox` 下 `linkRealKnowledge()` 才把 `realHome` 下的 `inheritDirs` 目录 junction 进沙箱，`inheritFiles` 单文件拷入。

### 2.3 现有客户端对「新 agent」的隐含假设

> 本节是**接入 DSH 之前**的评估记录（2026-10 初稿），逐条列出 kiro / opencode 实测下来「没出问题」的假设，以及换成 DSH 时必须复核的点。**现状已在各条内标注**——阅读时先看标注，再当历史背景。

1. **agent 不发反向请求**（`session/request_permission`、`fs/*`、`terminal/*`）。**这是接入 DSH 时的历史假设，现已不成立**：三处入口（brain / worker / `brain check`）共用 `acp-reverse.ts` 的应答器——权限请求默认 yolo 放行（`WEMIND_ACP_AUTO_ALLOW=0` 恢复拒绝）、未知 method 回 `-32601`，对端不会挂起。但应答器只覆盖 ACP 权限请求；要让 DSH 自己不产生提权请求，仍依赖它的自有开关（`DSH_PERMISSION_MODE`）。
2. **`session/load` 可用**。DSH 官方 ACP 明确没有 `session/load`（只有 `session/resume`）。
3. **首帧来得快**。`FIRST_FRAME_MS` 默认 25s；DSH 官方 ACP 以「已提交消息」为单位发正文，纯推理阶段可能长时间没有 `agent_message_chunk`。
4. **MCP 走 agent 配置文件**。DSH 的 MCP 通过 ACP `session/new` 的 `mcpServers` 挂载，不读 kiro 的 `settings/mcp.json`——每个 agent 只读自己的配置。
5. **静默期靠 activity 帧刷新心跳**。`index.ts` 每 15s 检查 `lastProgressAt`，只有 `session/update` 帧会刷新它；committed-only 的 DSH 会被当成「一直静默」，从而每 15s 发一条进度，烧掉微信的 10 条连发额度。

> 结论（2026-10 初稿）：**协议层不是「完全不用改」**。这 5 条后来都做成了通用能力（应答器 `acp-reverse.ts`、`restore: resume`、`heartbeatMs` 覆盖、`mcpViaAcp`、`committed-only` 心跳处理），不只服务 DeepSeek。

### 2.4 不在本文范围：DSH 作为 MCP 客户端

另一种方向是把 WeMind 的 `@wemind/wechat-mcp` 配进 DSH，让 DSH 主动调微信工具（DSH 是 MCP 客户端，微信是工具集）。这属于「形态①」，与本文的「DSH 当大脑」是反方向；两者**不能对同一个 bot token 同时跑**（会抢消息/回环）。本文只做形态②。

---

## 3. DeepSeek 侧可用的三个入口

### 3.1 官方：`@deepseek-ai/dsh` + `--profile acp`

**事实（截至 2026-10-24；2026-11-03 已在 `0.2.1-rc.3` 上复测，结论见 §3.1 末尾与 §7.1）**：

- **WeMind 的实测基线是 `0.2.1-rc.2` / `0.2.1-rc.3`**（2026-11-05 查 registry 时 `latest` 已是 **`0.2.1-rc.5`**——版本仍在快速迭代，rc.4/rc.5 未实测，用它们前先跑 `node scripts/acp-probe.mjs` 回归）；bin `dsh`；依赖 `@deepseek-ai/dsh-acp-app` / `@deepseek-ai/dsh-acp` 同版本。
- **桌面端已自带 CLI**：安装在 `<DeepSeek Harness 安装目录>` 下的 `resources\runtime\cli\bin\dsh.cmd`（常见为 `$env:LOCALAPPDATA\Programs\DeepSeek Harness\...`；安装器也可能把它放在其它盘/目录，用 `Get-Command dsh` 或实际安装位置确认）。初测时 `dsh --version` 输出 **0.2.1-rc.2**（2026-11-03 复测为 **0.2.1-rc.3**）；**该目录只有 `dsh.cmd`（没有无扩展名的 `dsh`）**，所以 agent 的 `binWin` 要写 `dsh.cmd`（或 `WEMIND_BRAIN_BIN` 指向实际绝对路径），否则 `onPath("dsh")` 找不到。
- 启动：`dsh --profile acp`，stdio 上的纯 ACP JSON-RPC；`dsh --profile acp --help` 打印帮助后退出，不占 stdin/stdout。
- 随附 profile 默认用 `deepseek-official` + `deepseek-v4-flash` 建会话；2026-10-24 在 rc.2 实测 `session/new` 返回的 `configOptions` 含 `model`（`deepseek-official/deepseek-v4-flash`、`deepseek-account/deepseek-flash`、`deepseek-account/deepseek-v4-pro`）和 `reasoning_effort`（默认 `high`）。**2026-11-12 在 rc.3 复测，`deepseek-account/*` 已从模型目录移除**；剩下哪些路由取决于本机 `settings.yaml` 的 provider 配置（§7.6.2）。
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
    - `deepseek-account/deepseek-flash` / `deepseek-v4-pro`：rc.2 及更早可用（桌面端登录态）；**rc.3 已从模型目录移除**，不要再把它当默认路由。
    - 用户自建的其它 provider 路由：是否存在、需要什么凭据，由本机 `settings.yaml` 与你的 profile 决定（§7.6）。
  - **切换模型**：`session/set_config_option` 的参数是 `{ sessionId, configId: "model", value: "[\"<provider>\",\"<model>\"]" }`；成功后 configOptions 的 `currentValue` 立即变化，`resume` 会保留这个选择。
    2026-10-29 在 `0.2.1-rc.3` 上复测出三条关键事实：① `session/new` 报的 `deepseek-official/deepseek-v4-flash` 来自 **ACP 桥插件自己的 bundle patch**——`resources/app.asar` 里 `@deepseek-ai/dsh-acp-app` 的 `cordis.patch.yml` 有 `- id: acp`、`config: {provider: deepseek-official, model: deepseek-v4-flash}`，而用户 profile 只覆盖 `llm-pi-ai` / `agent-default-model` / `web-search-deepseek`，**不覆盖 `- id: acp`**（`agent-default-model` 是另一个服务的键，桥不读它）；该插件的 README 也写明「The shipped row creates sessions with `deepseek-official` and `deepseek-v4-flash`; **a later patch can replace that row's complete config**」——即后面的 patch 层就是设计好的覆盖点、由用户自己写；② 在 profile 里补一条 `- id: acp`（provider/model 填用户自己在用的值）后，**不发 `set_config_option` 也**让 `session/new` 的 `currentValue` 直接变成该值、prompt 正常答出、`resume` 后保持；③ 只要该 provider 的凭据/依赖就绪（如桌面端在运行、自建网关已启动），prompt 即可成功；WeMind 不判断某条路由需要什么。
    WeMind 因此**跟随用户日常 dsh，但不替用户改配置**：预设 `realProfile: "acp"`。`direct` 完全使用真实 `~/.dsh`；只有显式 `homeMode=sandbox` 才把它**原样复制**进沙箱（不追加条目；**唯独剔除你自己挂的微信 MCP 条目**——跑 `wemind-mcp` 的、或 `serverName: wechat` 的 mcp-client，防沙箱里的 agent 抢同一个 bot token，真实文件不动、只记日志）。文件里缺 `- id: acp` 时，`wemind brain` 会给出一段可粘贴的 YAML（值取自 `agent-default-model`），让你补到**真实 profile**——补完终端 dsh 与微信大脑才是同一个模型。默认模型由 `profile-model.ts` 读（**优先 `- id: acp`，否则 `agent-default-model`**），会话建立后按它发一次 `set_config_option`（agent 自己的 ACP 接口；幂等）。读不到才回退预设兜底 `deepseek-account/deepseek-flash`——**rc.3 已失效，只会记 WARN**。显式换模型：`wemind brain set deepseek --model '…'`（或 `brain.json` 的 `presets.deepseek.model`）；`--model auto` = 跟随真实 profile 的默认（读不到就不下发）。
  - **实测首帧**：简单 prompt 约 2.26s；工具 prompt 首帧 1.23s、正文 3.86s；`session/update` 出现 `agent_thought_chunk` / `tool_call` / `tool_call_update` / `usage_update` / `agent_message_chunk`。
  - 未观察到 `session/request_permission` 等反向请求（本轮 3 次 prompt）。
  - stdio `mcpServers` 被 `session/new` 接受（用一个假 stdio MCP 验证）；HTTP 能力已声明。
  - **stdout 不纯**：DSH 会输出 `[llm-deepseek-account] model listing ...` 这类非 JSON 行；当前 `acp-brain.ts` 的解析器会忽略，不影响 JSON-RPC，但排查时不要把它当协议帧。

- **免审批 / 最高权限（2026-10-30）**：DSH **没有启动 flag**（`dsh --profile acp --help` 只有 `-h`），ACP 也**不声明权限配置项**（`set_config_option` 只认 `model` 与 `reasoning_effort`）。WeMind 预设以 `envDefaults` 注入 `DSH_PERMISSION_MODE=danger-full-access`——这是官方 bundle（`packages/bundle/base` 的 sandbox-policy/approval）读取的默认值来源（**官方文档正文未收录**，升级后可能失效），效果 = 绕过文件沙箱、不产生提权请求。**它是「默认值」不是强制值**：daemon 进程环境里已设同名变量时以你的为准（例如设 `DSH_PERMISSION_MODE=workspace-write` 收紧），日志记 `env defaults kept from parent: DSH_PERMISSION_MODE`。**别把 `approval.policy: never` 当放行**：它的语义是「不问、直接在服务内部拒绝」，必须配合 `danger-full-access`。若该 env 失效，退化为 workspace-write（越界写被拒 + 发 `session/request_permission`，宿主默认 yolo 放行；`WEMIND_ACP_AUTO_ALLOW=0` 时拒绝）。等效的手动配置：真实 `~/.dsh/profiles/acp/cordis.patch.yml` 写 `- id: sandbox-policy / config.mode: danger-full-access`（会被原样复制进沙箱，但同时改变终端 dsh 的权限）。

- **版本敏感**：更早的 `0.1.0-rc.6` 被社区实测为「仅支持新会话、不声明 load/resume/list、只返回已提交文本、拒绝非空 `mcpServers`」（见 `dsh-openclaw-acp` 的 README）。所以**必须锁版本、以实际安装版本实测为准**。

**优点**：官方维护、与模型/工具/沙箱同源、无第三方供应链；resume / list / close、工具生命周期、stdio+HTTP MCP 已具备，桌面登录态可用。
**缺点**：无 `session/load`；正文非逐 token；**当前 `image:false`（微信收图不可用）**；桥插件默认走要 API key 的 `deepseek-official`，**得让 ACP 桥选对你自己的路由**（用户在真实 profile 里写全 `- id: acp` / `agent-default-model` / `web-search-deepseek`，WeMind 只镜像、不代改；或显式用 `set_config_option` 覆盖）；ACP 面偏「自动化」；仍是 RC；Node 要求高（见 §8）。

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

- 只需要「聊天」时，写一个 `api-brain.ts`：`stream: true` 的 `chat/completions`、每用户历史写入磁盘、图片走 `image_url`。
- 但 WeMind 的 `askBrain` 契约背后是「会自己用工具的 agent」；裸 API 要补齐工具循环（读文件、跑命令、搜网页、MCP），否则和 kiro/opencode 不是同一档能力。
- 现状：仓库里**没有** `Brain` 接口抽象（`acp-brain.ts` 直接暴露 `askBrain`/`newSession`/`restart`，`index.ts` 直接调用），所以方案 C 还需要一次接口抽取 + 调用方改造，**不是「加个文件」**。

### 3.4 对比总表

| 维度 | 官方 `dsh --profile acp` | 社区 `deepseek-acp` | 裸 API |
|---|---|---|---|
| 身份 | DeepSeek 官方 | 第三方（MIT） | 自研 |
| 版本 | 实测 rc.2 / rc.3（桌面端自带 `dsh.cmd`；2026-11-05 时 registry `latest` 已是 rc.5，未实测） | 0.9.0（内核 0.1.5-rc.1） | — |
| 安装 | 无需另装（桌面端 CLI）；或 `npm i -g @deepseek-ai/dsh@0.2.1-rc.2` | `npx -y deepseek-acp@0.9.0` / 全局 | 无 |
| Node | 22+（本机 24 满足） | ≥22 | 仓库现有 ≥20 |
| `session/load` | ❌（有 `session/resume`） | ✅ | 自维护 |
| 会话恢复 | `resume` 保留上下文（实测）；`close`/强杀后可用 | `load` | 自维护 |
| 逐 token 正文 | ❌（已提交消息） | ✅ | ✅（流式） |
| 首帧 | 实测 1.0–2.3s（简单/工具） | 未测 | 取决于网络 |
| 工具进度 | ✅（`tool_call`/`usage`/`thought`） | ✅（卡片） | 需自建 |
| MCP | ✅ stdio/HTTP（session/new，实测 stdio 接受） | ✅ stdio/HTTP | 需自建 |
| 图片 | ❌ 实测 `image:false`，带图 `-32602` | ✅（README 称） | ✅ |
| 认证 | rc.3 已移除 `deepseek-account`；`deepseek-official` 需 `DEEPSEEK_API_KEY`；其它路由由本机 provider 配置决定 | `DEEPSEEK_API_KEY` | API key |
| 模型 | 由本机 `settings.yaml` 的 provider 目录决定；`set_config_option` 可切换 | 会话内选择 | 自选 |
| 反向请求 | 本轮未观察到；权限请求可能存在 | 可能有 | 无 |
| 沙箱 | DSH 默认 `workspace-write`；WeMind 预设用 `DSH_PERMISSION_MODE=danger-full-access` 放开（父进程同名变量优先） | 同源 | 无 |
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
| 10 | 首帧 25s | ✅ 实测 1.0–2.3s（简单/工具）；纯推理仍可能静默 | ✅ | **配置里的 `firstFrameMs` 60s 兜底（≤ idle）** |
| 11 | Windows 启动 | `dsh.cmd` → shell | `npx.cmd` → shell | 配置里的 `shell: true` |
| 12 | 进程树清理 | `taskkill /T` 已有 | 同 | 直接复用 |
| 13 | `wemind brain check` 20s | ✅ 实测握手 1–2s；首次冷启动仍建议放宽 | ⚠️ npx 更慢 | 放宽到 60s |
| 14 | `auto` 探测 | ⚠️ 只有 `dsh.cmd`，`onPath("dsh")` 找不到 | npx 不参与 | 配置里的 `binWin: "dsh.cmd"`，或让 `onPath` 补试 `.cmd` |
| 15 | 静默期 15s 心跳 | 🟡 有 thought/usage/tool 帧，通常能刷新；极端纯推理仍可能静默 | ✅ 流式帧持续刷新 | **配置里的 `heartbeatMs`（预设 `heartbeatMs: 60_000`）**；`progressMode` 只在本文设计稿里提过，**代码里没有这个字段**（2026-11-05 核对） |
| 16 | **模型/认证路由** | ⚠️ 桥插件默认 `deepseek-official` 需 API key；rc.3 已移除 `deepseek-account`，其它路由由本机 provider 配置决定 | ✅ `DEEPSEEK_API_KEY` | **`model` 字段 + 真实 profile 里的 `- id: acp` / `agent-default-model`（direct 直接用、sandbox 复制，跟随用户默认）+ `session/set_config_option`（显式覆盖）** |

**结论**：官方方案要补 **5 类**：模型路由、`session/resume`、图片（硬缺口）、反向请求、首帧/心跳。前 2 类已实测可行，图片取决于官方后续是否打开 `image`。社区方案只差反向请求/心跳，但引入第三方依赖。**若微信收图是必保功能，短期内只能选 B 或对官方禁用收图。**

---

## 5. 推荐方案

### 5.1 选型结论

1. **主方案 A（已实现）**：官方 `dsh --profile acp` 作为 `deepseek` agent，长期维护。
2. **暂不采用 B**：社区 `deepseek-acp` 仅备查；按你的要求先只走官方 DSH，不引入第三方依赖。
3. **不做 C**（除非明确只要聊天）。

### 5.2 目标架构

```text
微信 → daemon（长轮询）
        ├─ brain：常驻 `dsh --profile acp`
        │    cwd=<账号>/workspace/brain
        │    会话：session/new | session/resume
        │    MCP：session/new 的 mcpServers（按激活集）
        └─ worker：同一个 agent 的独立进程
             cwd=任务目录；direct 下不注入 DSH_HOME，用真实 ~/.dsh
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

   > 只有 `dsh.cmd`（无无扩展名 `dsh`），所以 WeMind agent 要写 `binWin: "dsh.cmd"`，或让 `onPath` 对 `.cmd` 补试。

2. 用 `scripts/acp-probe.mjs`（换行 JSON-RPC、`clientCapabilities:{}`；`ACP_BIN`/`ACP_ARGS` 指到 dsh）驱动 `dsh --profile acp`，逐项记录：
   - `initialize` 返回的 `agentCapabilities`（是否声明 `loadSession`、`session/resume`、`promptCapabilities.image`、`mcpCapabilities`）；
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
   - `session/new` 不需要 API key；默认模型 `deepseek-official/deepseek-v4-flash` **需要 API key**；rc.3 已从模型目录移除 `deepseek-account/*`，其余路由由本机 provider 配置决定；切换走 `session/set_config_option`（§7.6）；
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

#### M1 · agent + 沙箱（0.5–1 人日）✅ 已实现

在 `brain-agents.ts` 增加：

```ts
deepseek: {
  name: "deepseek",
  bin: "dsh",
  binWin: "dsh.cmd",             // 桌面端只有 dsh.cmd；经 shell 由 PATHEXT 解析
  args: ["--profile", "acp"],
  shell: true,
  homeEnvVar: "DSH_HOME",        // direct 不注入；sandbox 指向账号沙箱
  realHome: path.join(os.homedir(), ".dsh"),
  inheritDirs: ["skills"],
  inheritFiles: ["AGENTS.md"],
  // 新增字段（见 §6）：
  realProfile: "acp",            // 原样同步真实 profiles/acp/cordis.patch.yml（桌面端维护的 provider 目录/默认模型）；缺 `- id: acp` 时只提示用户自己补，不代改
  isolateSessions: true,         // 仅 sandbox：prepareAgent() 落盘 --patch，把会话 root 指到 <数据目录>/agent-sessions/deepseek/<role>
  model: '["deepseek-account","deepseek-flash"]', // 兜底：真实 profile 里读不到默认模型时才用（读的顺序：优先用户写的 `- id: acp`，否则 agent-default-model）
  restore: "resume",
  firstFrameMs: 60_000,          // 实测 1–4s；60s 只兜底真死/超长静默（≤ idle）
  heartbeatMs: 60_000,           // 有 thought/usage 帧时通常不触发；极端静默兜底
  images: false,                 // 当前 DSH ACP 不接受图片
  credentialFiles: [".credentials.yaml"], // 从 ~/.dsh 新者胜同步进沙箱
  mcpViaAcp: true,               // MCP 不写文件，随 session/new|resume 的 mcpServers 下发
},
```

要点：

- **凭据来源二选一**：
  1. 桌面登录态：`direct` 下直接使用真实 `~/.dsh/.credentials.yaml`；`sandbox` 下 `ensureBrainHome()` 才把它**新者胜同步**进配置目录（注意这是敏感文件，Windows 无 600 权限，沙箱目录要收紧）；
  2. API Key：`DEEPSEEK_API_KEY` 由 daemon 环境提供，并把 `model` 设成 `deepseek-official/deepseek-v4-flash`。
- **模型跟着你的 dsh 走（但由你自己配置）**：桥插件的默认模型写死在它自己的 bundle patch 里（`- id: acp` → `deepseek-official/deepseek-v4-flash`），这项该由**用户**在真实 `profiles/acp/cordis.patch.yml` 里覆盖；WeMind 在 `direct` 下直接使用真实配置、`sandbox` 模式才原样复制这份配置，缺 `- id: acp` 时 `wemind brain` 会给一段可粘贴的 YAML 让你补（补完终端 dsh 与微信大脑才同一个模型）。WeMind 读默认模型的顺序：**优先 `- id: acp`，否则 `agent-default-model`**，会话建立后按这个值发一次 `session/set_config_option`（agent 自己的 ACP 接口；幂等；显式覆盖也走它）；读不到才回退旧兜底 `deepseek-account/deepseek-flash`（rc.3 已失效，只记 WARN）。显式覆盖：`wemind brain set deepseek --model '["<provider>","<model>"]'`（或 `presets.deepseek.model`）；`--model auto` = 跟随真实 profile 的默认（读不到就不下发）。
- **不要**把 `DEEPSEEK_API_KEY` 写进 agent 的 `env`（会把密钥固化进源码/构建产物）；daemon 继承进程环境即可。
- `configSubdir` 留空：`DSH_HOME` 本身就是 home。
- MCP 走 `mcpViaAcp: true`：**不写任何 MCP 配置文件**，激活集由 `toAcpMcpServers()` 转成 `session/new|resume` 的 `mcpServers` 下发（见 M3）。每个 agent 只读自己的 MCP 配置；DSH 的 catalog 用 `WEMIND_MCP_CATALOG` 指向中立文件。
- `AUTO_PROBE_ORDER` 末尾追加 `"deepseek"`（不要插到 kiro/opencode 前面，避免老用户装了就悄悄换大脑）；`auto` 仍优先 kiro/opencode。（**当时的计划**；当前顺序为 `opencode → cline → qoder → gemini → deepseek → kiro`，deepseek 第 5 位、kiro 末位——按实测启动耗时排。）
- 文档标注 **Node ≥22**；`agentProblem` 对 deepseek 找不到二进制时提示 `--bin`。
- **图片**：`image:false`，`index.ts` 在 `askBrain` 前拦截微信图片，不会以 `-32602` 失败重试。纯图片消息回一句「当前大脑暂不支持看图……」；**带文字的消息只按文字回答**，答复前注明图片被忽略（不会连文字一起丢）。

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

1b. **模型路由选择**（默认已由真实 profile 里的 `- id: acp` 决定开局模型，沙箱原样复制、`session/new` 就对；这里再按同一值发一次作兜底/显式覆盖——真实 profile 读不到、或 `--model auto` 没读到默认时，它才是唯一手段，否则落到 `deepseek-official` 报 no API key）：

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
       // 默认 yolo：自动选 allow_once / allow_always；WEMIND_ACP_AUTO_ALLOW=0 恢复拒绝
       const autoAllow = !["0", "false", "off", "no"].includes(
         (process.env.WEMIND_ACP_AUTO_ALLOW ?? "").trim().toLowerCase(),
       );
       const pick = autoAllow
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

   注意：**必须应答**，否则 DSH 会一直等；WeMind 默认放行（微信侧无人值守），需要逐次拒绝时设 `WEMIND_ACP_AUTO_ALLOW=0`。

3. **首帧超时按配置覆盖**：

   ```ts
   const FIRST_FRAME_MS =
     Number(process.env.WECHAT_BRAIN_FIRST_FRAME_MS) ||
     AGENT.firstFrameMs ||
     25_000;
   ```

   worker 用 `WEMIND_WORKER_FIRST_FRAME_MS` 同样的优先级。

   > `firstFrameMs` 应 **≤ `WECHAT_BRAIN_IDLE_MS`（120s）**。实测首帧 1–4s，60s 已足够兜底；180s 没有意义：首帧一旦到达，判据就换成 idle；首帧超时只决定「一个帧都没有时等多久才重建」。真死 60s 后重建；纯推理若 60s 仍无任何帧，应该调 idle/心跳而不是继续拉长首帧。

4. **`wemind brain check` 放宽**：`checkAgent(ag)` 默认 20s → 60s，否则 DSH/`npx` 冷启动会误报。**已落地**（`brain-check.ts:18` 默认 `60_000`）；`WEMIND_BRAIN_CHECK_MS` 是当初设想的 env 覆盖，**当前没有实现**——要改超时只能改代码或直接调用 `checkAgent(ag, ms)`。

5. **（可选）`session/close`**：`restart()` / `newSession()` 杀进程前先发 `session/close`，让 DSH 干净写入磁盘；失败忽略。

6. **静默期心跳适配（重要）**：`index.ts` 的 heartbeat 每 15s 在 `lastProgressAt` 超过 15s 时发一条进度，而 `lastProgressAt` 只靠 `session/update` 帧刷新。官方 DSH 没有逐 token 帧，纯推理阶段会连续发「还在思考/仍在处理」，约 8 条后触发 `CONSEC_SEND_LIMIT=10` 的「接近上限」并进入 `awaiting`，最终答案要等用户回「继续」才恢复（**2026-10-24 未适配时的风险分析**；现行 `awaiting` 只挡进度、最终答案仍会发送）。建议：
   - agent 加 `heartbeatMs`（预设已设为 60s）——**这是唯一落地的做法**；`progressMode: "committed"` 是本文设计阶段的设想，代码里**没有**这个字段（2026-11-05 核对，不要按它实现）；
   - committed 模式下只发一条「该大脑完成后一次性返回」的说明，后续不再按 15s 刷；
   - 不要用假 `activity` 掩盖真实卡死；`WECHAT_BRAIN_CAP_MS` 仍兜底。

#### M3 · MCP 挂载 ✅ 已实现并真机验证（2026-10-24）

DSH 不读 kiro/opencode 的 MCP 配置文件；它自己的 MCP 通过 ACP `session/new` 的 `mcpServers` 挂载（stdio 实测接受，`http:true` 已声明）。**已落地**：

1. `agent-mcp.ts` 的纯函数 `toAcpMcpServers()`：
   - kiro `{ command, args, env }` → `{ name, command, args, env }`（env 转 `{name,value}[]`）；
   - opencode `{ type:"local", command:[...], environment }` → 拆 `command[0]` / `args` / `env`；
   - `{ url }` → `{ name, type:"http", url, headers }`；
   - 始终排除 `wechat`；**坏条目进 `skipped` 并记日志**（`isConvertibleToAcp` 供 `addMcp` 预校验）。
2. 配置里的 `mcpViaAcp: true`：`applySandbox`/`syncSettings` 跳过文件写入；`ensureSession` 把激活集（`activeMcpServers()`）/ worker 全量（`workerMcpServers()`）转成 `mcpServers` 传给 `session/new` / `session/resume`。
3. **catalog 按 agent 各自的约定读取，不跨 agent 借文件**：DSH 用 `WEMIND_MCP_CATALOG` 指向中立 kiro 格式文件（默认 `~/.dsh/settings/mcp.json` 不存在 → 未设 catalog 时为空）。
4. **坏条目防护**：官方 `session/new` 遇到起不来的 MCP 会回滚整个会话（实测 `mcp-client: initial connection or tool synchronization failed`）——`addMcp` 预校验拒绝无法转换的定义。

**真机验证（假 stdio MCP，echo 工具写标记文件）**：`session/new` 挂载 → 模型调用工具（标记文件记到 `called`）回答 `ok`；`session/resume` 带同一声明 → 再次调用（标记文件第 2 次）回答 `okPINEAPPLE`。HTTP MCP 未真机实测（能力已声明）。

#### M4 · 记忆 / 技能继承 ✅ 已验收（2026-10-24，现场已还原）

DSH 的布局（官方文档）：

- 用户全局指令：`$DSH_HOME/AGENTS.md`（另有共享根 `$DSH_AGENTS_HOME/AGENTS.md`，默认 `~/.agents`）；
- 用户技能：`$DSH_HOME/skills`（另有 `~/.agents/skills`）；
- 项目技能：`<projectRoot>/.dsh/skills`、`<projectRoot>/.agents/skills`。

agent 用 `realHome: ~/.dsh`、`inheritDirs: ["skills"]`、`inheritFiles: ["AGENTS.md"]` 复用 `linkRealKnowledge()`。**验收**：真实 `~/.dsh` 放测试 skill（secret `KIWANO`）+ `AGENTS.md` 规则（`MANGO-42`）→ brain/worker 两沙箱均可读，回答均 `CODEWORD=MANGO-42 SECRET=KIWANO`；验证后已还原。共享根 `~/.agents` 默认不被沙箱影响（`DSH_AGENTS_HOME` 不指向沙箱）。

#### M5 · 验证与文档 ✅（除图片/双真机账号外完成）

- `brain-agents.test.ts`：deepseek agent 断言（含 `mcpViaAcp`）；`agent-mcp.test.ts`：`toAcpMcpServers` 转换/跳过/预校验。
- 全量 136 tests 通过；`set_config_option` 失败路径真机验证（非法 model → `-32602 unknown model option` → 默认路由明确报 no API key）。
- `scripts/doctor.ps1` 升级守卫：dsh 版本 ≠ `0.2.1-rc.2` 时提示先跑 `scripts/acp-probe.mjs` 回归（**注意：守卫里锁的是 rc.2，而 2026-11-03 的复测是在 rc.3 上做的——用 rc.3 时这条警告属预期**）。
- 多账号机制验证：双数据目录各自沙箱/凭据/session 独立；双真机微信账号待需要时再验。
- 文档同步：待办 / 本文附录 / `add-mcp` 配方 / README / CHANGELOG。

### 5.4 工作量汇总

| 阶段 | 内容 | 人日 |
|---|---|---|
| M0 | 官方/社区冒烟、决策门 | 0.5 |
| M1 | agent + 沙箱 | 0.5–1 |
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
| `packages/wechat-daemon/src/agents/brain-presets.ts` | 新增 `deepseek` agent（`binWin: "dsh.cmd"`）；`AcpAgentPreset` 增 `model?` / `restore?` / `firstFrameMs?` / `heartbeatMs?` / `images?` / `credentialFiles?` / `identityFiles?` / `mcpViaAcp?` / `isolateSessions?`；解析侧 `ResolvedAgent` 透传与 `prepareAgent()` 落盘在 `agents/brain-agents.ts`；`AUTO_PROBE_ORDER` 末尾加 `deepseek` | M1 / 2026-11-03 |
| `packages/wechat-daemon/src/agents/profile-model.ts` | `acpModelHint()`：`- id: acp` 的 model 不在 provider 目录时给替换提示（`wemind brain` 输出） | 2026-11-03 |
| `packages/wechat-daemon/src/acp/acp-brain.ts` / `tasks/worker-acp.ts` / `acp/brain-check.ts` | 起进程前调 `prepareAgent(ag)`（DSH 的 `--patch` 文件必须先存在） | 2026-11-03 |
| `packages/wechat-daemon/src/acp/acp-brain.ts` | `session/set_config_option` 选 model；`session/resume` 兜底；反向请求应答器；首帧按配置覆盖；图片能力拦截；导出 `supportsImages`/`heartbeatMs` | M2 |
| `packages/wechat-daemon/src/tasks/worker-acp.ts` | 同步上述协议项（独立副本） | M2 |
| `packages/wechat-daemon/src/index.ts` | 静默心跳按 agent 配置放宽（`heartbeatMs`；`progressMode` 未实现）；收到图片但 agent `images: false` 时友好提示 | M2 |
| `packages/wechat-daemon/src/acp/brain-check.ts` | 默认超时 20s → 60s（**无可用的 env 覆盖**，只能改代码） | M2 |
| `packages/wechat-daemon/src/agents/sandbox/agent-mcp.ts` | `toAcpMcpServers()` 三种格式转换 | M3 |
| `packages/wechat-daemon/src/agents/sandbox/mcp-sandbox.ts` | `mcpViaAcp` 时跳过文件写入/`syncKiroSettings`；暴露 `activeMcpServers()` | M3 |
| `packages/wechat-daemon/src/agents/brain-agents.test.ts` | agent 断言 | M5 |
| `packages/wechat-daemon/src/agents/sandbox/agent-mcp.test.ts` | 转换单测 | M5 |
| `docs/接入方案/接入-DeepSeek.md` | 本文（已补真机实测附录） | M0/M5 |
| `docs/接入方案/接入其它-ACP-Agent.md` / `README.md` | agent 表 + 使用说明 | M5 |

---

## 7. 配置与操作

### 7.1 安装与凭据

> 下面所有路径都是**占位/示例**：按你自己的 DeepSeek Harness 安装位置替换，不要照抄别人的本机路径。桌面端常见位置是 `$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`，也可能在其它盘。

**不需要另装 CLI**：桌面端已自带 0.2.1-rc.3（2026-11-03；初测版本是 rc.2）。

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"  # 按实际安装位置调整
& $dsh --version     # 0.2.1-rc.3
```

**凭据与路由由 DSH 自己的配置决定**：按你日常 `dsh` 已经在用的方式准备 provider 与凭据即可，WeMind 不在项目侧重复配置，也不判断某个 provider 是否可用。若走官方 `deepseek-official` 路由，需要 `DEEPSEEK_API_KEY` 对 **daemon 进程**可见；若走你自己配的其它路由，按该 provider 的要求准备（例如本机网关需要保持运行）。

```powershell
# 示例：官方 deepseek-official 路由需要 API Key（对 daemon 进程可见）
$env:DEEPSEEK_API_KEY = "sk-..."
```

> - **要选对路由**：rc.3 的 `deepseek-account/*` 已从模型目录移除；桥插件不加干预时会落到 `deepseek-official`（报 `no API key`）。**`- id: acp` 是 ACP 桥真正读的键**，而不少配置工具只写 `agent-default-model` / `web-search-deepseek`——需要你在真实 profile 里把 `- id: acp` 补齐（§7.6.1；`wemind brain` 会给可粘贴片段）。WeMind 在 `direct` 下直接使用真实 profile、`sandbox` 模式原样复制，并读默认模型（优先 `- id: acp`，否则 `agent-default-model`）。读不到才回退 `model: '["deepseek-account","deepseek-flash"]'`——那是 rc.2 的旧兜底，rc.3 只会记 WARN。
> - `DEEPSEEK_API_KEY` 必须对 **daemon 进程**可见。用 `scripts/run-daemon.ps1` / pm2 启动时，请写进脚本/`ecosystem.config.cjs` 的 `env`，不要依赖交互式 shell。
> - `.credentials.yaml` 是敏感文件；`direct` 与真实 home 共享，`sandbox` 复制进 `BRAIN_HOME` 后要收紧该目录权限（Windows 没有 POSIX 600，建议专用 OS 账号 + 目录 ACL）。
> - 桌面端 CLI 只有 `dsh.cmd`（无无扩展名 `dsh`）：agent 用 `binWin: "dsh.cmd"`；若想用绝对路径，`WEMIND_BRAIN_BIN` 指向上面的 `dsh.cmd`。

### 7.2 切换与自检

```powershell
npm run build
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"  # 按实际安装位置调整
wemind brain set deepseek --bin $dsh --restart
wemind brain                 # 应显示 name=deepseek、bin=...dsh.cmd、home_env=DSH_HOME
wemind brain check           # 真起进程跑 initialize + session/new（60s 内）
```

> 桌面端 `dsh.cmd` 不一定在 daemon 进程的 PATH 上（尤其是用旧版守护脚本启动的 daemon），所以 **`--bin` 传绝对路径最稳**。`brain check` **不验证 prompt/模型**；模型路由与上下文要用 `scripts/acp-probe.mjs`（`ACP_MODEL` + 两次 prompt）。

### 7.3 验收（微信端到端）

1. 发一条消息 → `daemon.log` 出现：
   `spawn deepseek ... → initialized → session/new|resume → prompt ok`，微信收到非空回复。
2. 杀 daemon 再启动，追问「上一轮我说了什么」→ 走 `session/resume`，上下文仍在。
3. 发一个 >30s 的任务 → 不因首帧超时被杀；微信能看到「步骤」进度，且静默期**不会**每 15s 刷一条「还在思考」。
4. 发「新会话」→ 走 `session/new`，旧上下文清空。
5. 越界写与权限请求：预设默认 `DSH_PERMISSION_MODE=danger-full-access`，越界写**不再被拒、也不会发 permission 请求**（2026-10-30 起）。想验证应答器，先在 daemon 环境设 `DSH_PERMISSION_MODE=workspace-write`，再让它在工作区/配置目录外写文件 → 观察 permission 请求被应答（默认放行；设 `WEMIND_ACP_AUTO_ALLOW=0` 则拒绝），**不能卡死**。
6. ✅ 发一张图片 → 友好拒绝（「当前大脑暂不支持看图…」；日志 `image unusable and no text; rejected gracefully`，无 `-32602` 重试；已实测 2026-10-24）。带文字时按文字回答并注明图片被忽略。
7. 两个账号同时跑 → WeMind 账号数据与会话指针彼此隔离；`sandbox` 下配置/凭据也各自独立，`direct` 下共享真实 Agent 配置但会话指针互不覆盖。
8. ✅ `加载 <MCP>` → 下一条消息生效（`session/new|resume` 带 `mcpServers`）；`wechat` 仍被禁止；DSH 不读 kiro 的 MCP 文件（M3 已实现，真机验证见附录）。
9. worker：`task "create hello.txt..." --cwd <临时目录>` → 文件 `hello.txt` 内容 `hello` + 输出 `DONE`；`task-reply "read hello.txt..."` → 输出 `hello`；`task-stop` → idle。日志见 `[wemind/wechat-daemon/worker] spawn deepseek ... → model set → prompt ok`。

### 7.4 回滚

```powershell
wemind brain set kiro --restart   # 或 opencode / unset
```

`sandbox` 下 DSH 的会话在 `<账号目录>/agent-sessions/deepseek/{brain,worker}`（2026-11-03 起；不再写 `brain-home/sessions`）；`direct` 下 DSH 使用真实 `~/.dsh` 会话库，微信会话与终端共用。删除 `agent-sessions/deepseek/`（仅 sandbox）与 `brain-sessions.json` 才会清空对应侧记忆；旧版本留下的 `brain-home/sessions` 可以直接删（DSH 已经不会读它）。

### 7.5 会话目录隔离与模型过期（2026-11-03）

```text
<账号目录>/
├── agent-sessions/deepseek/
│   ├── session-root-brain.patch.yml    # - id: session-persistence-jsonl / config.root: .../brain
│   ├── brain/                          # 对话大脑的会话库（prepareAgent 建目录）
│   ├── session-root-worker.patch.yml
│   └── worker/                         # 任务 worker 的会话库
```

- **为什么**：`sandbox` 下 DSH 与 kiro / pi 共用同一个沙箱根（`brain-home` / `worker-home`），而 DSH 的会话持久化插件默认读自己 home 下的 `sessions/`；别的 agent 写进去的平铺文件会让它报 `unsupported flat-file layout`。WeMind 不搬沙箱、也不改 DSH 源码，只用它自己的 `--patch`（profile 用户层同一种机制）把 root 指出去。
- **怎么验**：`wemind brain check` 通过；`ls agent-sessions/deepseek` 能看到两份 patch 与两个目录；在微信里聊过的内容在 `agent-sessions/deepseek/brain/` 下；重启 daemon 追问「上一轮说了什么」仍能 `resume`。
- **用户自己给了 `--patch`**：`wemind brain set deepseek --args "… --patch <你的文件>"` 时 WeMind 不再追加第二个（`resolveAgent()` 只看 args 里有没有 `--patch`）。
- **模型过期**：`wemind brain` 会读真实 `profiles/acp/cordis.patch.yml` 的 `- id: acp`，并检查它的 model 是否在该 provider 的 `models` 目录里；不在时输出一段可粘贴的替换（优先建议 `agent-default-model` 的值）。按提示改**真实 profile**（不是沙箱里的副本），然后 `wemind brain switch deepseek`（或重启 daemon）让新模型生效。改前建议备份该文件。

### 7.6 direct 模式与模型配置（2026-11-12 复测）

默认 `homeMode=direct` 下，DSH 不注入 `DSH_HOME`，直接使用真实 `~/.dsh`：`.credentials.yaml`、`settings.yaml`、`profiles/acp/cordis.patch.yml` 全部与终端同一份；只有显式 `homeMode=sandbox` 才会复制 profile、并在复制时剔除微信 MCP 条目。技能/记忆按 `inheritDirs` 链接；真实 `~/.dsh` 不被 WeMind 写入。`wemind brain check` 与 `askBrain()` 走同一条路径。

#### 7.6.1 DSH 的模型配置分三层，ACP 只读其中一层

DSH 不像 kiro / opencode 那样「改一个 settings.json 就完事」。它的模型由 provider 目录与 profile 用户层共同决定：

| 层 | 文件 / 位置 | 作用 | 谁维护 |
|---|---|---|---|
| provider 目录 | `~/.dsh/settings.yaml` → `llm-pi-ai.providers` | 声明本机有哪些 provider、每个 provider 下有哪些 model id | DSH 桌面端或用户自己的配置 |
| ACP 桥默认模型 | `~/.dsh/profiles/acp/cordis.patch.yml` → `- id: acp` | `session/new` 一开局用的 provider/model（**ACP 桥真正读的键**） | 用户自己 |
| 桌面默认模型 | 同一文件 → `- id: agent-default-model` | 桌面端/日常 dsh 的默认模型；`wemind brain` 在缺 `- id: acp` 时拿它兜底 | 桌面端或用户自己的配置 |
| Web 搜索 | 同一文件 → `- id: web-search-deepseek` | dsh 的 web search 配置 | 用户自己的配置 |

**关键点：不少配置工具只写 `agent-default-model`（以及 `web-search-deepseek`），不写 `- id: acp`。** 两种半配置都要避免：

- **只写了 `- id: acp`**：`session/new` 能开局，但终端 dsh 的默认模型 / web search 与微信侧可能不一致。
- **只写了 `agent-default-model`**：`session/new` 仍落到桥插件自带的 `deepseek-official`（要 API key），微信侧 prompt 报 `no API key`。

WeMind 不判断哪个 provider 可用，也不替用户合成配置。它只做两件事：① `direct` 直接使用真实 `profiles/`、`sandbox` 原样复制；② 缺 `- id: acp` 时给出可粘贴片段（值取自 `agent-default-model`）。补 `- id: acp` 时把 `<provider>` / `<model>` 换成你真实 profile 里的值（与 `agent-default-model` 一致即可）：

```yaml
- id: acp
  config:
    provider: "<provider>"
    model: "<model>"
```

若文件只有 `[]`，替换那一行（后面再接块序列项是非法 YAML）。改完用 §7.6.3 的方法确认 ACP 会话拿到的就是这份配置。

#### 7.6.2 模型目录会随 agent 升级 / 本机配置变化

- `deepseek-account/*` 在 rc.2 及更早存在（桌面登录态），**rc.3 已移除**；预设里的 `model: '["deepseek-account","deepseek-flash"]'` 是旧兜底：真被用到时 `session/set_config_option` 返回 `-32602 unknown model option`，WeMind 只记一条 `WARN model set failed …` 并继续用 `session/new` 的当前模型。看到这条 WARN 说明「预设兜底过期」，不是 agent 坏了。
- 当前有哪些路由，取决于本机 `settings.yaml` 的 `llm-pi-ai.providers`：可能是官方 `deepseek-official`，也可能是你自己配的网关。WeMind 不枚举、不推荐具体 provider；以 `session/new` 返回的 `model.options` 为准。
- **优先级**（WeMind 读默认模型）：`wemind brain set deepseek --model '…'`（显式覆盖）> 真实 profile 的 `- id: acp` > `agent-default-model` > 预设兜底。`--model auto` = 不下发，跟随 ACP 默认。

#### 7.6.3 怎么验证

```powershell
wemind brain check                  # 握手 + session/new
node scripts/acp-probe.mjs          # 看 session/new.configOptions.currentValue
```

`currentValue` 应与真实 profile 的 `- id: acp`（没有则 `agent-default-model`）一致；发一次 prompt 能答出、`session/resume` 后模型不变，即说明微信侧与终端用的是同一份配置。若 prompt 报凭据/连接错误，那是该 provider 自己的配置或依赖没就绪——按 DSH / 该 provider 的文档排查，WeMind 不介入。

其他既有差异不变：`image:false`（微信侧拒图）、只有 `session/resume` 没有 `session/load`、`DSH_PERMISSION_MODE=danger-full-access` 的免审批默认值、以及 `wechat` MCP 永远被剔除。

---

## 8. 风险与未决项

| # | 风险 / 未决 | 影响 | 处置 |
|---|---|---|---|
| R1 | **凭据来源（仅 `sandbox`）**：`DSH_HOME` 指向沙箱后，真实 `.credentials.yaml` 不可见 | 桌面登录态用不了，必须 API Key | `direct` 直接共用真实 `~/.dsh`；`sandbox` 实测把 `.credentials.yaml` 复制进沙箱即可，或用 `DEEPSEEK_API_KEY`。敏感文件，收紧目录权限 |
| R2 | 当前代码只调 `session/load`，DSH 返回 `-32601` | 自愈后**静默新建会话**，多轮记忆丢失 | 实现 `session/resume` 兜底；**已实测 resume 保留 PINEAPPLE 上下文（含 `taskkill /T /F` 强杀）** |
| R3 | 官方只发「已提交」正文；纯推理阶段可能无帧 | 首帧误杀 + 心跳刷屏 | 实测首帧 1–2.3s，有 thought/tool/usage 帧；配置里的 `firstFrameMs` 60s、`heartbeatMs` 60s 兜底 |
| R4 | 反向请求 `session/request_permission` 无人应答 | 整轮卡死到超时 | M2 通用应答器；默认 yolo 放行，`WEMIND_ACP_AUTO_ALLOW=0` 恢复拒绝 |
| R5 | DSH 不读 kiro 式 MCP 文件；catalog 来源不同 | 动态 MCP 不可用/配错 | M3 按 agent 各自的 catalog；DSH 用 `WEMIND_MCP_CATALOG` 或 `mcpViaAcp`；stdio 已实测接受 |
| R6 | 第三方 `deepseek-acp` 供应链 / 维护 | 长期不可控 | 只作冒烟/回退；锁版本；不默认启用 |
| R7 | 版本是 RC，ACP 行为可能变化 | 升级即坏 | 锁 `0.2.1-rc.2`；升级先跑 M0 脚本；文档记录版本 |
| R8 | Node ≥22（社区包明确；官方以安装包为准），而仓库声明 ≥20 | 旧环境起不来 | 文档标注；`agentProblem` 加 `minNode` 检查；M0 记录 |
| R9 | DSH 的 Windows ACL 沙箱只限制普通 NTFS 写，不限制读/网络/进程可见性；预设默认 `danger-full-access` 连写限制也放开 | 微信侧提示注入可外带本机文件 | `allowFrom` 登录者白名单；专用 OS 账号；需要时在 daemon 环境设 `DSH_PERMISSION_MODE=workspace-write` 收紧（预设只是默认值）；不要把敏感目录设为 worker cwd |
| R10 | 模型/路由选择 | 不干预就落到 official 路由，需 API key（默认已由真实 profile 里的 `- id: acp` 跟随用户日常默认，见 R18）；用户自建网关未运行时，prompt 报该网关自己的连接错误 | 配置里的 `model` + 真实 profile 的 `- id: acp` / `agent-default-model`（direct 直接用、sandbox 复制）+ `session/set_config_option`（显式覆盖/兜底）。**rc.3 起 `deepseek-account/*` 已不在模型目录**；其它路由以本机 provider 配置为准，见 §7.6 |
| R11 | 桌面端 CLI 只有 `dsh.cmd`，无无扩展名 `dsh` | `onPath("dsh")` 找不到，`auto`/agent 判不可用 | 配置里的 `binWin: "dsh.cmd"`；或让 `onPath` 对 `.cmd` 补试；`WEMIND_BRAIN_BIN` 绝对路径兜底 |
| R12 | 多账号 / pm2 环境变量传递 | key 不生效 | 文档给 pm2 / `Start-Process -Environment` 示例 |
| R13 | 成本与长上下文 | 账单/延迟 | 限制 `allowFrom`；观察 usage；`WECHAT_BRAIN_CAP_MS` 兜底 |
| R14 | Windows `dsh.cmd` 经 shell 的引号/元字符 | 启动失败 | 复用现有 `spawnAgent` 的逐参数引号；`WEMIND_BRAIN_BIN` 可指向绝对路径 |
| R15 | **官方 `image:false`**，带图 prompt `-32602` | 微信收图/看图功能不可用 | M1 拦截并友好提示；若要保留收图，短期选 B `deepseek-acp` 或等官方 |
| R16 | 静默期心跳每 15s 一条 | 约 8 条后触发 10 条连发上限，最终答案要等用户回「继续」（**2026-10-24 未适配时的风险分析**；现行 `awaiting` 只挡进度、最终答案仍会发送） | 配置里的 `heartbeatMs` / committed 模式；实测有 thought/usage 帧，触发概率降低 |
| R17 | `session/resume` 不重放历史更新 | WeMind 不需要回放；只要上下文在即可 | **已实测上下文保留**（PINEAPPLE）；只拼新回合 chunk |
| R18 | **默认模型路由与凭据不匹配** | 桌面已登录仍报 `no API key for deepseek-official`；或 profile 只写了 `- id: acp` / 只写了 `agent-default-model` 时终端与微信不一致 | 桥插件 bundle patch 写死 `- id: acp`、用户 profile 不覆盖它。在**真实 profile** 里补 `- id: acp`（值取自 `agent-default-model`；`wemind brain` 给片段）；WeMind direct 直接用、sandbox 复制并读默认模型（优先 `- id: acp`，否则 `agent-default-model`）；会话建立后另发 `set_config_option`（agent 自己的接口）；读不到回退旧 `deepseek-account/*`（rc.3 已失效，只记 WARN）；或改用 `deepseek-official` + API key |
| R19 | DSH stdout 混入非 JSON 日志行 | 严格解析器可能报错/卡住 | 当前客户端忽略非 JSON；新增解析器要保持容错 |
| R20 | 社区 `deepseek-acp` 未实测 | 无法确认 image/load/权限行为 | 如选 B，先跑 `scripts/acp-probe.mjs`，不要直接上线 |
| R21 | **`sandbox` 下共用沙箱根的 `sessions/` 被别的 agent 写入**（kiro / pi 的平铺文件） | DSH 报 `unsupported flat-file layout`，起不了会话（2026-11-03 真机复现） | `isolateSessions: true` + `prepareAgent()` 落盘 `--patch`，root 指到 `agent-sessions/deepseek/<role>`；用户自带 `--patch` 时尊重用户。`direct` 使用真实 `~/.dsh` 会话库，不受影响 |
| R22 | **用户 `- id: acp` 的 model 被桌面端模型目录淘汰** | `session/new` 报 `no configured model`，像 agent 坏了 | `profile-model.ts` 的 `acpModelHint` 在 `wemind brain` 给出可粘贴替换（优先 `agent-default-model` 的值），只提示不代改；改真实 profile 后 `brain switch` 生效 |

---

## 9. 决策建议

- **M1/M2 已实现**：`deepseek` agent（`dsh.cmd` + `DSH_HOME` + `.credentials.yaml` 同步 + `model` 选择）、`resume` 兜底、反向请求应答、`firstFrameMs`/`heartbeatMs`、图片拦截。
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

## 11. 安装与准备

- **不需要另装 CLI**：DeepSeek Harness 桌面端已自带 `dsh`（`resources\runtime\cli\bin\dsh.cmd`，常见于 `$env:LOCALAPPDATA\Programs\DeepSeek Harness\...`，也可能装在其它的盘/目录）；初测版本 `0.2.1-rc.2`，2026-11-03 复测为 `0.2.1-rc.3`。
- **只有 `dsh.cmd`（没有无扩展名的 `dsh`）**：agent 预设写 `binWin: "dsh.cmd"`，或用 `WEMIND_BRAIN_BIN` 指向实际的 `dsh.cmd` 绝对路径；否则 `onPath("dsh")` 找不到。
- **也可以全局安装**：`npm i -g @deepseek-ai/dsh@0.2.1-rc.2`（§3.4 的安装行）；实测基线是 rc.2 / rc.3，Node 要求 ≥22（本机 Node 24 满足）。
- **启动方式**：`dsh --profile acp`，stdio 上的纯 ACP JSON-RPC；`dsh --profile acp --help` 打印帮助后退出。
- **凭据二选一**（详见 §7.1）：① 桌面登录态——rc.2 及更早由 `$DSH_HOME/.credentials.yaml` 提供（rc.3 已无 `deepseek-account` 路由）；② `DEEPSEEK_API_KEY`——必须对 daemon 进程可见，对应 `deepseek-official` 路由。用户自建 provider 的凭据按该 provider 的要求准备。
- **首次自检**：`npm run build` → `wemind brain set deepseek --bin <dsh.cmd 绝对路径> --restart` → `wemind brain` → `wemind brain check`（60s 内）；`brain check` 不验证 prompt/模型，模型路由与上下文用 `scripts/acp-probe.mjs` 验证。

## 12. 预设与沙箱

`brain-presets.ts` 的 `ACP_AGENT_PRESETS.deepseek`（§5.3 M1）关键字段：

- 启动：`bin: "dsh"`、`binWin: "dsh.cmd"`、`args: ["--profile", "acp"]`、`shell: true`。
- 沙箱：`homeEnvVar: "DSH_HOME"`、`realHome: ~/.dsh`、`inheritDirs: ["skills"]`、`inheritFiles: ["AGENTS.md"]`、`credentialFiles: [".credentials.yaml"]`；`configSubdir` 留空（`DSH_HOME` 本身就是 home）。
- 协议：`restore: "resume"`、`firstFrameMs: 60_000`、`heartbeatMs: 60_000`、`images: false`、`mcpViaAcp: true`。
- 模型：`realProfile: "acp"`（`direct` 直接使用真实 `profiles/acp/cordis.patch.yml`；`sandbox` 原样复制；缺 `- id: acp` 只提示不代改）、`model: '["deepseek-account","deepseek-flash"]'`（rc.2 旧兜底；rc.3 已失效，真被用到时只记 WARN）。
- 会话：`isolateSessions: true`。
- 权限：`envDefaults: { DSH_PERMISSION_MODE: "danger-full-access" }`（默认值，父进程同名变量优先）。

**沙箱布局（仅 `homeMode=sandbox`）**（§5.2）：brain 的 `DSH_HOME=<数据目录>/brain-home`，cwd 仍是 `<账号>/workspace/brain`；worker 的 `DSH_HOME=<数据目录>/worker-home`，cwd 是任务目录。`homeMode=direct`（默认）直接用真实 `~/.dsh`，cwd 同样不变。

**会话库**（§7.5）：`sandbox` 下在 `<账号目录>/agent-sessions/deepseek/{brain,worker}`，启动前 `prepareAgent()` 落盘 `session-root-<role>.patch.yml`，用 DSH 自己的 `--patch` 把 `session-persistence-jsonl.root` 指过去（用户 `--args` 里自带 `--patch` 时不再追加）；`direct` 下不追加 `--patch`，使用真实 `~/.dsh` 会话库。

**记忆 / 技能**（§5.3 M4）：`direct` 直接使用真实 `~/.dsh` 的 `skills` 与 `AGENTS.md`；`sandbox` 才按 `inheritDirs` / `inheritFiles` 复制。共享根 `~/.agents` 默认不受影响。

**MCP**（§5.3 M3）：不写任何 MCP 配置文件；`direct` 下发真实 catalog 全量，`sandbox` 下发激活集，均由 `toAcpMcpServers()` 转成 `session/new|resume` 的 `mcpServers`；catalog 用 `WEMIND_MCP_CATALOG` 指向中立 kiro 格式文件；`wechat` 永久排除。

## 13. 限制

- **无 `session/load`**：DSH 只有 `session/resume`，`session/load` 返回 `-32601`；预设用 `restore: "resume"`，恢复失败才新建。
- **不收图**：`promptCapabilities.image: false`，带图 `session/prompt` 返回 `-32602`；微信侧在 `askBrain` 前拦截并友好拒绝（纯图回「当前大脑暂不支持看图…」，带文字按文字回答并注明图片被忽略）。
- **正文非逐 token**：以「已提交消息」为单位在回合末整段提交；纯推理阶段可能长时间没有 `agent_message_chunk`，靠 `firstFrameMs` / `heartbeatMs`（预设均 60s）兜底，否则会被判首帧超时或每 15s 发进度。
- **MCP 只走 ACP**：不读 kiro 式 MCP 配置文件，`mcpServers` 随 `session/new|resume` 下发；catalog 需用 `WEMIND_MCP_CATALOG` 单独指向。
- **权限没有 ACP 开关**：`dsh --profile acp --help` 只有 `-h`，ACP 不声明权限配置项（`set_config_option` 只认 `model` 与 `reasoning_effort`）；免审批只能靠 `DSH_PERMISSION_MODE`（官方 bundle 的默认值来源，文档正文未收录，升级后可能失效）。
- **stdout 不纯**：会混入 `[llm-deepseek-account] model listing ...` 这类非 JSON 行，解析器必须容错。
- **Windows 只有 `dsh.cmd`**：`onPath("dsh")` 找不到，`auto` 探测依赖预设的 `binWin: "dsh.cmd"`。
- **Node ≥22**：仓库发布包声明 Node ≥20，旧环境起不来（§8 R8）。
- **RC 快速迭代**：实测基线 rc.2 / rc.3；2026-11-05 查 registry 时 `latest` 已是 rc.5，rc.4 / rc.5 未实测，升级前先跑 `scripts/acp-probe.mjs`。
- **默认路由与凭据**：`deepseek-official/deepseek-v4-flash` 需要 `DEEPSEEK_API_KEY`；rc.3 已无 `deepseek-account` 路由，其它路由的凭据要求由该 provider 自己决定。
- **沙箱边界有限**：DSH 的 Windows ACL 只限制普通 NTFS 写，不限制读/网络/进程可见性；预设 `danger-full-access` 连写限制也放开，靠 `allowFrom` 登录者白名单与专用 OS 账号兜底（§8 R9）。

## 14. 验证

- **构建与自检**（§7.2）：`npm run build` → `wemind brain set deepseek --bin <dsh.cmd 绝对路径> --restart` → `wemind brain`（应显示 `name=deepseek`、`bin=...dsh.cmd`、`home_env=DSH_HOME`）→ `wemind brain check`（真起进程跑 `initialize` + `session/new`，默认 60s 超时）。
- **ACP 探针回归**（M0 / 附录 A）：`scripts/acp-probe.mjs`（`ACP_BIN` / `ACP_ARGS` 指到 dsh，`ACP_MODEL` + 两次 prompt）逐项记录 `initialize` 能力、`session/new` 的 `configOptions`、首帧与 `session/update` 类型、kill 后 `resume` 的上下文、反向请求、非空 `mcpServers`、图片 prompt。
- **微信端到端**（§7.3）：发消息 → 日志 `spawn deepseek ... → initialized → session/new|resume → prompt ok` → 收到非空回复；杀 daemon 后追问仍走 `resume`；>30s 任务不被首帧超时杀掉且静默期不刷「还在思考」；「新会话」走 `session/new`；图片友好拒绝；`加载 <MCP>` 下一条生效且 `wechat` 仍被禁止；worker 派发 / `task-reply` / `task-stop` 正常。
- **单测**（§5.3 M5）：`brain-agents.test.ts`（deepseek agent 断言，含 `mcpViaAcp`）、`agent-mcp.test.ts`（`toAcpMcpServers` 转换/跳过/预校验）；M5 全量 136 tests 通过。
- **已验清单**：M0 探针、微信 brain E2E、worker E2E、M3 MCP、M4 记忆/技能、M5 多账号机制与失败路径，见附录 A。

## 待实测

- `@deepseek-ai/dsh` `0.2.1-rc.4` / `0.2.1-rc.5`：未实测（2026-11-05 查 registry 时 `latest` 已是 rc.5）；使用前先跑 `node scripts/acp-probe.mjs` 回归。
- HTTP MCP：能力已声明（`mcpCapabilities.http: true`），未真机实测（stdio MCP 已验）。
- 社区 `deepseek-acp@0.9.0`：未实测（附录 A「社区待跑」，image / load / 权限行为尚无法确认）；如选方案 B，先跑 `scripts/acp-probe.mjs`，不要直接上线。
- 双真机微信账号：多账号机制已用双数据目录各跑一轮验证，双真机微信账号待需要时再验。
- 官方后续打开 `image` 后：回归微信收图。
- resource / prompt 范围：留待后续（§9）。

---

## 附录 A · M0 实测记录（官方已完成，社区待跑）

> 实测环境：Windows 11 / 桌面端 `dsh 0.2.1-rc.2`（2026-11-03 复测于 `0.2.1-rc.3`）/ 隔离 `DSH_HOME`（复制 `.credentials.yaml`）/ 模型 `deepseek-account/deepseek-flash`。
> 工具：`scripts/acp-probe.mjs`（已提交到仓库，可复现）。

| 检查项 | 官方 `dsh --profile acp` | 社区 `deepseek-acp` | 结论 |
|---|---|---|---|
| 版本 / Node | 0.2.1-rc.2（桌面端 `dsh.cmd`）/ Node 24 | 未测 | 官方版本已锁定 |
| `initialize` 能力 | `close/list/resume`；无 `loadSession`；`mcp.http:true`；`image:false` | 未测 | 官方缺 load + image |
| `session/new` 返回 `configOptions` | 两个 provider 组：`deepseek-official/deepseek-v4-flash`、`deepseek-account/{deepseek-flash,v4-pro}`；`reasoning_effort=high`；无需 key | 未测 | **默认 official 路由需 key** |
| 模型切换 | `session/set_config_option {sessionId, configId:"model", value}` 成功；`currentValue` 立即变 | 未测 | 显式选 account；跟随日常默认则靠真实 profile 里用户写的 `- id: acp`（沙箱原样复制） |
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
| **M3：MCP via ACP** | 假 stdio MCP 经 `toAcpMcpServers()` 转换：`session/new` 挂载 → 模型调用（标记文件记到 `called`）答 `ok`；`session/resume` 再挂 → 再调用答 `okPINEAPPLE`；坏 MCP → `session/new` 回滚（`initial connection or tool synchronization failed`） | — | **M3 通过**（HTTP 未实测） |
| **M3：微信侧全链路** | 用户实测：`MCP` 列出 test-echo → `加载` → 下一条消息 `session/resume ok ... mcp=[test-echo]`，模型调用工具答 `MCP-OK`（调用记录写入磁盘）→ `卸载` 激活集回空 | — | **微信侧通过**（含微信侧 `resume` 首次实证） |
| **M4：记忆/技能** | 真实 `~/.dsh` 放测试 skill（KIWANO）+ `AGENTS.md` 规则（MANGO-42）→ brain/worker 沙箱均可读，回答均 `CODEWORD=MANGO-42 SECRET=KIWANO`；现场已还原 | — | **M4 通过** |
| **M5：多账号机制** | 双数据目录各跑一轮（历史记录使用当时的 sandbox 布局）：凭据各自独立，session id 不同，均答 `OK` | — | **机制通过**（双真机微信待需要时验） |
| **M5：model 失败路径** | 非法 model → `-32602 unknown model option`，随后默认路由明确报 no API key | — | 失败不静默 |
| **M5：图片友好拒绝（微信侧）** | 纯图片 → 收到「当前大脑暂不支持看图…」；日志 `image unusable and no text; rejected gracefully`；带文字 → 按文字回答并注明图片被忽略 | — | **通过**（无 `-32602` 重试） |
| **M5：微信派发 worker + 权限请求** | `任务：…` → worker spawn（`mcp=[test-echo]` 全量继承）→ 越界写被沙箱拒 → 2 次 `session/request_permission` 均被应答器拒绝（**不卡死**）→ agent 汇报阻塞 waiting | — | **机制通过**（越界拒绝属沙箱按设计；顺带修复重启后幽灵任务状态） |

> 结论：官方路线可行且 M1–M5 已落地（图片除外，上游 `image:false`）；关键增量是 **model 选择**、`resume` 兜底、图片拦截/心跳兜底、**MCP via ACP**。社区适配器按当前选择暂不采用，仅保留备查。

---

> **下一步**：M3–M5 已完成（验证结果见本文附录）。剩余开放项：官方打开 `image` 后回归收图；HTTP MCP 实测；双真机微信账号；DSH 升级时先跑 `scripts/acp-probe.mjs` 回归（`doctor.ps1` 会提醒）。
>
> **后续待办**：M3–M5 均已回填（M3 动态 MCP ✅、M4 记忆/技能 ✅、M5 除图片[上游]与双真机账号外 ✅），明细与遗留见本文附录。
