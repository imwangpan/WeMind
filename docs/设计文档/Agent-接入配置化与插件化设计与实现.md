# Agent 接入：配置化与插件化设计与实现

> **状态**：设计定稿；**P0 契约 + P1（内置迁移 + 本机加载层 + `agent list/show/check`）+ P2（`agent spec/probe`、真实握手校验、一次性自助接入提示）已实现**；P3–P4 未实现（2026-11-16）｜**分支**：`feat/agent-definitions`｜**最后核对**：2026-11-16
>
> 本文描述如何把「接入一个新的 ACP Agent」从**改 TypeScript + 发新版**变成**加一份定义（必要时加一个插件）**：让用户在本机自己接入新 agent、让开发侧不再一个一个适配。本文是实现前定稿，进度以文末「实施阶段」与 [`docs/ai/README.md`](../ai/README.md) 事实状态表为准；未实测的结论标注「假设 / 待实测」。

---

## 1. 背景与目标

### 1.1 用户目标

- 用户在本机装了一个 WeMind 没适配过的 ACP agent，**不需要等 WeMind 适配、不需要更新版本**就能用上。
- 用户不需要手写三十多个字段：可以让**那个 agent 自己**读规格并把定义写好（"帮我接入 wemind"）。
- 定义可以分享：贴一份 JSON，或装一个定义包。

### 1.2 开发目标

- 常规 agent 只产出**数据**，不产出代码。
- 数据表达不了的部分（新文件格式解析、凭据派生、引擎版本探测）集中到**插件层**；插件是逃生舱，不是默认路径。
- 仓库守卫不再把「用户加一个 agent」和「给 WeMind 提 PR」绑在一起。

### 1.3 现状（为什么必须改）

**预设本身已经很"数据化"，但原先没有加载路径。** 迁移前的 `AcpAgentPreset`（`packages/wechat-daemon/src/agents/brain-presets.ts`，P1 已删除）共 36 个字段，边界很清楚：

- 35 个是数据（字符串 / 布尔 / 数组 / 对象），只有 **1 个是函数值**：`credentialEnv`（Cline 从凭据文件派生环境变量）——它必须移出数据面，成为 adapter 的一部分。
- 那 35 个数据字段里有 **3 个的"语义"要靠 per-agent 代码解释**：`realProfile`（DSH profile 语义）、`kiroEngine`（kiro v2/v3 探测与免审批方式）、`isolateSessions`（字段是布尔，但生成的 session patch 文件正文是写死的 DSH 专用 YAML）。

所以「配置化」落到 32 个纯数据字段 + 3 个"数据开闸、代码落地"字段 + 1 个只能是代码的字段。

**但"改预设就够"不成立，预设之外还有按 agent 名或专用格式写死的代码：**

| 位置 | 写死了什么 |
| --- | --- |
| `agents/brain-agents.ts` | `AUTO_PROBE_ORDER` 顺序表、`ADAPTER_INSTALL_HINT`、`agentProblem()` 的三条名字分支、`authHint()` 仅 cline、kiro 的 engine 探测与 `permissions.yaml` 生成、DSH 的 session patch 文件正文 |
| `agents/managed/mcp-adapters.ts` | `MCP_ADAPTERS` 是**按文件格式**的表（4 个 adapter）；新增一种格式就要新增 adapter + `mcpFormat` 取值 + 分派分支 |
| `agents/managed/dsh-mcp.ts` / `toml-mcp.ts` | 手写的 YAML / TOML 子集解析（只读） |
| `agents/profile-model.ts` | DSH `cordis.patch.yml` 的默认模型读取与 MCP 剥离 |
| `agents/cline-credentials.ts` | 从 `providers.json` 派生 `CLINE_PROVIDER` / `CLINE_API_KEY` |
| `agents/config/config-fingerprint.ts` | Claude Code 的易变文件清单（避免每轮重启） |
| `daemon/messaging/attachments.ts` | 出站敏感文件 denylist 里按 `realHome` 派生 + 三条硬编码路径 |

**没有任何加载外部定义的机制。** 全仓库无插件/动态加载注册表；唯一的注册表就是编译进产物的 `ACP_AGENT_PRESETS` 与 `MCP_ADAPTERS`。agent 名在 CLI 与微信指令里是白名单（`cli/subcommands/cli-brain.ts` 的 `brain set` / `switch`、`daemon/daemon-control.ts` 的「切换大脑」、`ipc/chat-command-specs.ts` 的「任务 \<agent\>」），`brain.json` 里给**非预设名**写 override 是死数据（`agents/brain-agents.ts` 的 `resolveAgentCore` 会置 `known=false` 并把 key 回落到 `kiro`）。用户今天唯一能做的是**借一个已有预设的身份**（`wemind brain set <已有名> --bin/--args/…`）。

**守卫把"加 agent"绑成了"提 PR"。** `scripts/check-agent-docs.mjs` 对 `ACP_AGENT_PRESETS` 的**每个 key** 断言仓库内存在 `docs/接入方案/接入-<name>.md`（含 5 类小节 + `## 待实测`）并在 4 个索引里出现；`scripts/doc-impact.rules.mjs` 的 `preset` 规则要求同一次改动补齐 5 处文档；`scripts/gen-docs-tables.mjs` 从 `brain-presets.ts` 反向生成文档表格。第三方作者不可能满足这些。

**单实例与信任边界（必须保持）。** 一个 bot token 只能有一个程序收消息；WeMind 自己下发的 MCP 集永久排除 `wechat`；`ipc/control-bridge.ts` 刻意只接受「agent 名 + 纯数据」（`target`/`ref`/`name`/`page`/`expiresAt`），**没有也不可能有** `bin`/`args`/`shell`——因此 `wemind brain set --bin/--args` 这类写入**只走磁盘、不走桥**，这是刻意的边界，不要拆。

### 1.4 非目标

- **不做账号级定义层**：定义描述的是"这台机器上装了什么、它的配置长什么样"，与账号无关（与「Agent 真实配置按单机共享」一致）。
- **不做上游"定义随包走"的发现约定**：只预留结构，不在本次实现。
- **不发官方独立数据包**：只预留目录结构。
- **不做非 ACP backend**：`Brain` 接口抽象继续暂缓（见 [`docs/接入方案/接入其它-ACP-Agent.md`](../接入方案/接入其它-ACP-Agent.md) 与 [`docs/repowiki/06-ACP-大脑与副本.md`](../repowiki/06-ACP-大脑与副本.md)）。
- **不引入定义文件监听、不自动切换大脑**。
- **不允许插件触碰会话协议层与反向请求**。

---

## 2. 已确认决策

| # | 决策点 | 取值 |
| --- | --- | --- |
| 1 | 扩展单元 | 分层：纯数据定义是主路径；数据表达不了才引用可安装代码模块（插件＝逃生舱） |
| 2 | 插件形态 | 定义里 `adapter` 字段指向模块，模块按**稳定命名 hook 契约**注册 |
| 3 | 插件能力边界 | 只碰**文件格式**与 **spawn 前准备**（env 派生/生成启动前文件/引擎探测/附加参数）；协议层与反向请求永不开放 |
| 4 | 插件适用面 | 只服务 ACP；非 ACP backend 不做 |
| 5 | 定义位置 | `~/.wemind/.agents/`（点号目录，避开账号 key 撞名），可用 `WEMIND_HOME` 覆盖 |
| 6 | 分发 | 本机文件 + 可选 npm 定义包（包内固定位置，`agent add` **复制**即安装）；运行期绝不联网拉取 |
| 7 | 优先级 | 内置 < 数据包 < 本机定义 < `brain.json` 字段 override < 环境变量 |
| 8 | 同名覆盖 | **整条替换** + 三处可见性；不加闸（加闸只会把模型推向绕过 `check` 的路） |
| 9 | 探针时机 | 只在 `agent add` / 显式重探时跑；结论写进定义并记下探测时的 agent 版本 |
| 10 | `agent check` 深度 | schema + **起进程握手**（`initialize` + `session/new`），不发真实 prompt；`--deep` 才发 |
| 11 | 内置预设 | 10 条全部迁成同一份数据 + schema 校验（dogfood，内置与用户同一套词汇表） |
| 12 | 文档守卫 | 键源从 `brain-presets.ts` 改成**内置数据文件**；用户目录不受守卫管 |
| 13 | 自助接入 | `agent spec`（规格 + 说明书）+ `probe --draft` + `agent check` 闭环 |
| 14 | 微信侧接入 | **不新增微信指令**：用户消息直接交给当前大脑，由大脑用自己的工具写定义；大脑靠一条一次性提示知道这条路 |
| 15 | 信任 | 安装即授权（不加额外确认）+ 透明展示来源与"会执行代码的 adapter" |
| 16 | 接入后行为 | **不自动切换**大脑；回执里给一句"要切过去就说『切到 X』" |
| 17 | 失败语义 | 坏定义 fail-closed（沿用现有退出码 78），但报错必须说清是哪份定义、坏在哪、怎么修 |
| 18 | 版本兼容 | 定义带 `schemaVersion`、插件声明 `apiVersion`；不匹配 fail-closed |
| 19 | 生效时机 | 新定义落地即可热切换（不重启）；定义改动不引入文件监听 |
| 20 | 用户定义的地位 | 与内置**完全平等**（可当 brain/worker、可被微信选中），但**不参与**自动挑脑 |
| 21 | 实施方案 | 反向检验后：**不采用**"单一脚本适配器"那种更粗的方案 |

---

## 3. 核心设计

### 3.1 定义（`AgentDefinition`）

`AcpAgentPreset` 按"数据 / 代码"拆成两半：

- **数据** → `AgentDefinition`：35 个数据字段（沿用今天的名字，按用途分组），加 `schemaVersion`、`adapter`（可选，指向插件模块）、`probe`（探测记录）。
- **代码** → adapter hook（见 §3.3）：`credentialEnv`（函数值，**不在数据面**）以及 §1.3 表格里那批按名字写死的逻辑。

**下表的顺序就是权威顺序**：`AgentDefinition` 类型的分组、`AGENT_DEFINITION_FIELDS` 字段表与自动生成的 JSON Schema 都按它排列，改一处要三处一起改。

| 分组 | 字段（沿用今天的名字） |
| --- | --- |
| 身份与启动 | `name` / `bin` / `binWin` / `fallbackBinPaths` / `requiresBins` / `args` / `shell` |
| 目录与继承 | `homeEnvVar` / `realHome` / `configSubdir` / `inheritDirs` / `inheritFiles` / `extraConfigFiles` |
| MCP | `mcpFormat` / `mcpConfigFile` / `catalogFile` / `acpMcpServers` / `mcpDelivery` |
| 会话与能力 | `restore` / `replayOnLoad` / `images` / `sessionMode` / `isolateSessions`※ |
| 超时与心跳 | `firstFrameMs` / `heartbeatMs` |
| 模型 | `model` / `modelArg` / `realProfile`※ |
| 环境 | `env` / `envDefaults` |
| 副本设置（仅 `managed`） | `settingsBase` / `settingsDefaults` / `credentialFiles` / `identityFiles` |
| 引擎差异 | `kiroEngine`※ |
| 插件与探测 | `adapter` / `probe`——**独立键**，不在数据字段表里，由各自的校验函数处理 |

※ 这 3 个是**数据字段、但语义要靠代码解释**（见 §3.3）：`realProfile`（profile 读写）、`isolateSessions`（启动前生成会话 patch 文件）、`kiroEngine`（引擎探测与免审批方式）。另外 `credentialEnv` 是函数值，必须留在代码侧。

**校验用自写校验器**：现有运行时依赖只有 `qrcode` 与 `silk-wasm`（`packages/wechat-daemon/package.json`），不引入 `ajv` / `zod`。JSON Schema 由**同一份定义**生成，供 `agent spec` 输出，避免两套真相。

**内置定义的位置**：源码 `packages/wechat-daemon/agents/<name>.json`，**构建期内联进 bundle**（tsdown 直接内联 JSON 导入），保持 `files: ["dist"]` 与 `scripts/prepack-guard.mjs` 的检查口径不变，运行期零 IO。仓库脚本（`check-agent-docs.mjs` / `gen-docs-tables.mjs`）直接读这些 JSON 作为键源；同一份目录结构就是未来官方数据包的结构（预留）。

### 3.2 来源、优先级与覆盖

```
内置（内联）  <  数据包（~/.wemind/.agents/ 里由 agent add 复制的文件）  <  本机定义  <  brain.json 字段 override  <  环境变量（一次性）
```

- **本机定义**：`~/.wemind/.agents/<name>.json`。**点号目录**是必须的——账号 key 由 `deriveAccountKey()` 从 botId 净化成 `[a-zA-Z0-9_-]`（`packages/wechat-ilink-core/src/store/accounts.ts`），所以 `~/.wemind/agents/` 有可能被某个真账号目录占掉；key 不可能含 `.`，点号目录永不撞名（现有 `accounts.json` 也是靠扩展名与账号目录区分）。
- **同名**：整条替换，不做字段合并。可见性三处：`wemind agent list` 标来源、daemon 启动/切换时 WARN、微信回执里明说。理由：覆盖机制**必须**存在（官方数据包就是靠它生效），所以只剩粒度问题；字段合并会带来"标量/数组/对象各怎么合"的规则集与四层推理成本，而"只想调几个字段"本来就有 `brain.json` 的字段 override 这条轻量通道。
- **`brain.json` 的 `presets` 段保留**（`wemind brain set <名> --bin/--args/--extra-args/--shell/--model` 继续写磁盘）。它只覆盖少量字段，且**不走控制桥**这条边界不变。
- **环境变量一次性覆盖**（`WEMIND_BRAIN_BIN` / `ARGS` / `EXTRA_ARGS` / `SHELL` / `HOME_ENV` / `REAL_HOME` / `INHERIT_DIRS`、`WEMIND_ACP_SESSION_MODE`）继续有效，位置在链尾。

### 3.3 插件层（adapter + hook）

定义是 JSON，需要代码时在 `adapter` 字段写模块说明符（包名或绝对路径），模块默认导出注册一组**命名 hook**。hook 名是稳定契约，对应今天写死在核心里那批逻辑：

| hook | 替换掉今天的 |
| --- | --- |
| `mcp.read` / `mcp.write` / `mcp.stripSettings` / `mcp.toAcp` / `mcp.nativeRead` | `MCP_ADAPTERS` 里按格式分派的 4 个 adapter（`mcp-adapters.ts`） |
| `settings.inherit` | `jsonMcpServers.inheritSettings` 里按 `mcp.json` 名字特判的逻辑 |
| `profile.readDefaultModel` / `profile.copyForManaged` | `profile-model.ts`（DSH `cordis.patch.yml`） |
| `env.derive` | `cline-credentials.ts` 的 `clineCredentialEnv` |
| `engine.detect` | `brain-agents.ts` 的 kiro v2/v3 探测与 `stripKiroV2TrustArgs` |
| `spawn.prepare` | DSH 的 session patch 文件生成（`dshSessionPatchFor` / `prepareAgent`）、kiro 的 `permissions.yaml` |
| `fingerprint.volatile` | `config-fingerprint.ts` 里 Claude Code 的易变文件清单 |
| `paths.sensitive` | `attachments.ts` 里按 `realHome` 派生 + 三条硬编码的敏感路径 |
| `hint.install` / `hint.auth` | `ADAPTER_INSTALL_HINT`、`authHint()` 的名字分支 |

**永不开放的 hook**：会话恢复策略、回合帧处理、静默等待、`session/request_permission` 应答、任何反向请求——这些是 brain / worker / `brain check` **三处共用**、且最容易出"微信能跑但 `brain check` 超时"的路径。能力差异继续由数据声明（`restore` / `replayOnLoad` / `sessionMode` / `firstFrameMs` / `heartbeatMs`）。

**为什么不是"单一脚本适配器"**（反向检验结论）：让插件用一个脚本接管配置目录、MCP 落盘、凭据与参数，等于把 WeMind 已经做好并测过的东西（副本生成与目录继承、MCP 激活集与 `wechat` 条目剥离、敏感文件 denylist、UNC/数据流拦截、会话指针落盘、失败时连接回收）推给每个插件作者重写，必然有人漏掉安全清单；同时定义不再是数据，`agent list` / `agent check` / 文档守卫 / 来源可见性全部失效。

### 3.4 探针

`wemind agent probe <bin> [--args …] [--draft]` 把 `scripts/acp-probe.mjs` 的能力搬进 CLI（脚本改成薄壳调用，避免两套真相），一次回答六个问题并**把结论写进定义**。

能自动得到：

- `loadSession` / `sessionCapabilities.resume`——**这俩本来就在 `initialize` 回包里，今天完全没被解析**，属于白拿。
- 非空 `mcpServers` 是否被接受（决定 `acpMcpServers` / `mcpDelivery`）。
- `image` 是否被接受（决定 `images`，含"带图 prompt 被拒"这一档）。
- `session/set_config_option` 是否支持（回 `-32601` 就知道），否则走 `modelArg`。
- `replayOnLoad` 现象、首帧耗时与静默期特征（`firstFrameMs` / `heartbeatMs`）。
- `session/new` 返回的 `configOptions` 里可用的 mode id（决定 `sessionMode`）——「假设：部分 agent 能直接列出」。

补不上、必须由人（或 agent 自己）写：

`realHome` / `configSubdir` / `mcpConfigFile` / `catalogFile` / `mcpFormat`（尤其是 YAML / TOML 这类非 JSON 格式）/ `credentialFiles` / `identityFiles` / `credentialEnv` / `settingsBase` / 继承清单 / `requiresBins`。这些是"它把东西放在哪、长什么样"，只有它的源码、文档或它自己知道。

**纪律**：探针结论进定义后才是权威；运行期不做探测。定义里记 `probe.at`（探测时间）与 `probe.agentVersion`（探测时的 agent 版本），以便识别结论漂移。发真实 prompt 只在用户显式要（`--deep` / `--prompt`）时做，因为它要花钱、且会把测试对话写进 agent 的会话历史。

### 3.5 自助接入

三件产物，构成一个闭环（也是"用户不需要手写 36 个字段"的答案）：

1. `wemind agent spec [--json]`：规格 + **给 agent 读的接入说明书**（哪些字段探得到、哪些探不到、探不到的那几项该去 agent 自己的哪个文件里找，配正确与错误示例）+ `check` 的用法。
2. `wemind agent probe --draft`：直接产出**草稿骨架**（协议层结论已填好），agent 只补领域知识那几项。
3. `wemind agent check <name|file>`：schema + 起进程握手，退出码与错误文案可直接回给用户。

**大脑怎么知道这条路**：沿用现成的注入口（`acp/acp-brain.ts` 里那条"系统提示…**此提示只出现一次**"的机制，与 `agents/config/wechat-settings.ts` 的 `replyStyleHint()` 同族），加一行指向 `wemind agent spec`。不做每轮注入，也不往 agent 的技能目录塞文件（`direct` 下那正是不写 agent 目录的原则，会让 `direct` 与 `managed` 行为分叉）。

**微信侧**：不新增任何指令。用户在微信里说"帮我接入 Test Agent"就是一条普通消息，交给当前大脑；大脑用自己的文件/shell 工具跑 `agent spec` → `probe --draft` → 补字段 → `agent check` → 落盘。写完**不自动切换**大脑，回执里给一句"要切过去就说『切到 X』"。

### 3.6 信任、写入边界与失败语义

- **安装即授权**：能写 `~/.wemind/.agents/` 的人本来就能在本机执行任意命令，所以不再加一次确认。但**必须透明**：`agent list` / `agent show` / daemon 日志显示来源，以及"这个定义会执行代码：`<module>`"。
- **微信侧只"选"不"装"**：WeMind 自己不提供任何微信侧的安装/修改接口（`切换大脑` / `任务` 仍然只认名字，控制桥的字段集不变）。**但要如实说明**：大脑默认 yolo、本来就带着文件与 shell 工具，它能自己写定义文件；这是既有能力，WeMind 既不阻止、也不保护——不要写一句"禁止"当作护栏。
- **失败语义**：坏定义 fail-closed。选中不可用 agent 时沿用现有行为（`agentProblem()` → 退出码 78），但错误文案必须说清"哪份定义、坏在哪、怎么修"（删掉该文件，或跑 `wemind agent check <name>`）。这是本次唯一需要**新增**的东西——"坏定义只是不可用、不会被选上"本来已经是现有模型（`known` / `available`）。
- **不做静默降级**：起不来就明确报错，不回退到上一个可用 agent。与本仓库既定立场一致（恢复会话失败就如实报错、不回退新建）。

### 3.7 版本与兼容

- 定义带 `schemaVersion`（整数），adapter 声明 `apiVersion`。不匹配 **fail-closed**，报错给出"这份定义需要 wemind ≥ X"。
- 理由：定义与插件是**外部产物**、更新节奏与 daemon 独立，一定会出现"新定义装在旧 daemon 上"。宽容策略（不认识的字段忽略、版本不符只 WARN）的表现是**静默半生效**——正是本仓库最怕的故障类型（"终端能用、微信不能用"）。
- 不做字段级合并，也就没有"新旧字段如何叠加"的问题。

---

## 4. 命令面

| 命令 | 作用 |
| --- | --- |
| `wemind agent list` | 名称、来源（内置 / 数据包 / 本机）、可用性、探测记录 |
| `wemind agent show <name> [--explain]` | 最终生效值；`--explain` 打印每一层的来源 |
| `wemind agent spec [--json]` | 规格 + 说明书 + 示例（同一份源的 Markdown / JSON Schema） |
| `wemind agent probe <bin> [--args …] [--draft] [--deep]` | 能力探针；`--draft` 产出定义草稿 |
| `wemind agent check <name\|file> [--schema] [--deep]` | 默认真实 ACP 握手；`--schema` 只校验数据、不启动进程；`--deep` 再发一条真实 prompt |
| `wemind agent add <pkg\|file>` / `wemind agent remove <name>` | 复制安装 / 移除本机定义 |

**受影响的既有命令**：`wemind brain set` / `brain switch` / 微信「切换大脑」/「任务 \<agent\>」的**名字白名单放开**为"已定义的 agent"；`wemind config agent <name> show\|set` 的语义扩展为：**有 adapter 走 adapter 的读写 hook，纯数据定义按其声明的 `mcpFormat` 走内置格式 adapter，格式不认识时明确报错**（不搞"用户定义的 agent 一律不支持"）。

---

## 5. 实施阶段

每一阶段都必须齐**代码 + 测试 + 文档**三件套，并过 `npm run verify`（硬性要求，见 [`AGENTS.md`](../../AGENTS.md) §4.15）。

### P0 契约

- **改动面**：新增 `AgentDefinition` 类型、`schemaVersion` / `apiVersion`、自写校验器、由同一份源生成的 JSON Schema。
- **验收**：校验器单测（正常 / 边界 / 未知字段 / 版本不匹配）；P0 交付时 `gen-docs-tables.mjs` 与 `check-agent-docs.mjs` 仍读 `brain-presets.ts`，键源已在 P1 改成 `definitions/*.json`。

**已实现（2026-11-16）**：新增 `packages/wechat-daemon/src/agents/agent-definition.ts`（字段表 `AGENT_DEFINITION_FIELDS` 同时驱动 `validateAgentDefinition()` 与 `agentDefinitionJsonSchema()`；`AgentDefinition` 类型 + 编译期字段覆盖守卫）与 `agent-definition.test.ts`（22 个用例）。三条实现细节：未知字段一律拒绝（含 JSON 里真实存在的 `__proto__` 键，且断言不污染原型）；相同 `schemaVersion` 内允许新增可选字段，所以正常的兼容升级不用动常量；自定义 `mcpFormat` 必须同时给 `adapter`，这条**条件必填**也由同一份表生成进 JSON Schema（用 `anyOf` 表达，与 `if`/`then` 等价且避开 lint 的 `then` 告警——仓库里不加任何 lint 豁免）。P0 交付时 `brain-presets.ts` 尚未改动，两个既有文档守卫不受影响；键源已在 P1 改掉（见下段）。

**P1 检查点 1（内置迁移）已实现（2026-11-16）**：10 份定义迁到 `src/agents/definitions/*.json`，`agent-registry.ts` 静态导入、展开 `~`、逐份 `validateAgentDefinition()`、按 `adapter.module` 挂 `credentialEnv`；`brain-presets.ts` 删除，6 个 import 点改读注册表；`scripts/check-agent-docs.mjs` 与 `scripts/gen-docs-tables.mjs` 的键源改成 `definitions/*.json`（新增 `scripts/agent-definitions.mjs` 共用读取/文件名校验），`doc-impact.rules.mjs` 的 `preset` 规则改为「新增 definitions/*.json」；迁移保真测试逐字段对照旧表跑过（10 × 35 字段一致），现有 `brain-agents.test.ts` / `attachments.test.ts` / managed 用例不退化。加载层在检查点 2 补齐（见下段）。

**P1 检查点 2（本机加载层 + 命令面）已实现（2026-11-16）**：`agent-registry.ts` 扫描 `~/.wemind/.agents/*.json`（`WEMIND_AGENTS_DIR` 可覆盖），按目录指纹缓存、下一次解析自动重读；优先级**内置 < 本机定义 < `brain.json` 字段覆盖 < 环境变量**，同名**整条替换**。坏定义（JSON/schema/未知字段/`name` 与文件名不一致/`name: "auto"`/自定义 `mcpFormat`/外部 adapter）按文件名遮住同名内置，`ResolvedAgent.definitionProblem` → `agentProblem()` → 退出码 78，文案含文件与修法；`ACP_AGENT_PRESETS` 改为合并视图 Proxy，`resolvePresetByName()` / 微信「切换大脑」「任务 <agent>」/ CLI 白名单自动接受本机定义；daemon 启动与切脑结果打印本机来源。新增 `wemind agent list|show [--explain]|check <name|文件>`；`config agent` 通过定义的 `realHome` / `mcpConfigFile` / `settingsBase` 工作，不按 agent 名硬编码。测试新增 `agent-registry.test.ts`（本机层/坏定义/热重读）、`cli-agent.test.ts`、`chat-commands.test.ts` 本机名用例、`cli-config.test.ts` 本机定义路径用例；`vitest.setup.ts` 把测试的定义目录指到空临时目录，避免读开发者真实 `~/.wemind`。

**P2 自助接入已实现（2026-11-16）**：新增 `agents/agent-spec.ts`，用同一份 `AGENT_DEFINITION_FIELDS` + `FIELD_GUIDES` 输出人读 Markdown 与机器可读 JSON（含 JSON Schema、正例、错误示例、安装/选择命令），字段明确区分「自动 / `--deep` / 人工」。新增 `acp/agent-probe.ts`，把 `scripts/acp-probe.mjs` 的实现搬进 CLI：默认只做 `initialize` + `session/new` + load/resume 实测，不发真实 prompt；`--deep` 才发真实回合并验证恢复后的上下文，`--image` / `--tool` 需要显式配合 `--deep`；默认用临时假 MCP 测试 `session/new.mcpServers`，`--no-mcp-test` 可关闭；`--draft` 只填协议层能确认的字段，并在 notes 里列出仍需人工补的领域字段。`agent check` 默认改为真实 ACP 握手，`--schema` 才是纯数据校验，`--deep` 再发一条真实 prompt；`resolveAgentFromDefinition()` 让“检查未安装文件”和安装后使用同一套 adapter 解析。`scripts/acp-probe.mjs` 改成薄壳，兼容旧 `ACP_*` 变量并默认 `--deep`（`ACP_NO_PROMPT=1` 关闭）。反向请求统一走 `acp-reverse.ts`，探针可显式拒绝权限请求；草稿在检测到恢复后历史回放时自动写 `replayOnLoad: true`。大脑的一次性系统提示加入 `wemind agent spec` 入口，不新增微信指令、不每轮注入。**验收边界**：fake ACP 进程的探针、握手、`--deep`、草稿与提示注入已有单测；真实 agent 的「spec → probe → check → 落盘 → 热切换」闭环仍待真机跑通。**未做（按阶段）**：外部 adapter 插件（P3）、`agent add/remove` 与数据包分发（P4）。

### P1 内置迁移 + 加载层（交付用户侧目标的大半）

- **改动面**：10 条内置定义迁成 `packages/wechat-daemon/src/agents/definitions/*.json`（构建期内联）；本机 `~/.wemind/.agents/` 加载；优先级链；`wemind agent list` / `agent show --explain`；坏定义报错质量；放开名称白名单（`cli-brain.ts`、`daemon-control.ts`、`chat-command-specs.ts`）；`config agent` 语义扩展（§4）。
- **验收**：优先级与同名覆盖用例；本机定义一个 agent 并热切换成功（真机）；坏定义 fail-closed 且文案含修法；`agents/managed/*.test.ts` 不退化。
- **文档**：`README.md` 命令一览（自动生成）、[`docs/ai/README.md`](../ai/README.md) 事实状态表（"任意兼容 ACP 的 agent 无需改代码"要从 ⚪ 改成按阶段标注）、[`docs/接入方案/接入其它-ACP-Agent.md`](../接入方案/接入其它-ACP-Agent.md)。

### P2 自助接入

- **改动面**：`agent spec` / `probe --draft` / `agent check`（握手复用 `brain check` 的自检副本机制）；`scripts/acp-probe.mjs` 改成薄壳；一次性提示注入。
- **验收**：让一个真实 agent 走完"读 spec → 产草稿 → check → 落盘 → 热切换"闭环（真机）；`--deep` 与不带的差异有测试；提示只注入一次。
- **文档**：`docs/接入方案/接入其它-ACP-Agent.md` 新增"用户自助接入"章节；[`docs/ai/recipes/add-acp-agent.md`](../ai/recipes/add-acp-agent.md) 拆成"官方内置定义"与"用户自定义"两条路。

**P2 已实现（2026-11-16）**：见上方 P2 段；`agent spec/probe/check --schema/--deep`、薄壳脚本、字段说明守卫、一次性提示与 fake ACP 用例均已落地。真实 agent 闭环仍待真机验证。

### P3 插件层（交付开发侧目标）

- **改动面**：hook 契约 + `adapter` 加载（动态 `import()` + `apiVersion` 校验 + 来源展示）；把 §3.3 表格里的 per-agent 代码全部迁成**内置 adapter**（先内部接口、后对外公开）。
- **验收**：现有 `agents/managed/*.test.ts`、`brain-agents.test.ts`、`acp-reverse.test.ts` 全绿；迁移后**没有任何**按 agent 名的分支残留（用新测试断言 `agent-registry.ts` 之外不再出现 agent 名）。
- **文档**：`docs/repowiki/*`（06 / 07 篇）与 [`docs/ai/代码地图.md`](../ai/代码地图.md)。

### P4 分发与守卫

- **改动面**：包内定义约定（如包根 `wemind-agent.json` 或 `package.json` 的 `wemind` 字段）+ `agent add/remove`（复制即安装）；`llms.txt` 与 `docs/README.md` 同步；官方数据包结构预留。文档守卫键源已在 P1 改成 `definitions/*.json`，P4 只需确认用户目录不进入守卫。
- **验收**：`npm run verify` 全绿；一个第三方定义包能装进 `~/.wemind/.agents/` 并被选中（真机）；用户目录里的定义**不触发**任何仓库守卫。

---

## 6. 明确不做

账号级定义层；上游"定义随包走"的发现约定（只预留）；官方独立数据包（只预留结构）；非 ACP backend；定义文件监听；接入后自动切换大脑；覆盖内置加闸；npx 式运行期拉取；定义与插件之间的字段级合并。

---

## 7. 风险与待实测

- **待实测**：`session/new` 的 `configOptions` 是否总能列出可用 mode id；tsdown 对 JSON 导入的内联行为（`resolveJsonModule` + `noEmit` 组合）；用户定义 agent 作为 worker 时进程池与会话持久化的表现。
- **风险**：用户写一份劣质定义覆盖内置（如 kiro 漏了 engine 探测）→ 症状静默。缓解：三处可见性 + `agent check` + `agent show --explain`。
- **风险**：模型自行写定义文件时可能绕过 `agent add`。这是**既有能力**，靠"合法路径最顺畅 + 三处可见性"缓解，不靠一道能被绕过的闸。
- **风险**：P3 触碰的是"终端能用、微信不能用"的高发区（profile 剥离、session patch、凭据派生、引擎探测）。缓解：放到最后做，用现有单测当安全网。

---

## 8. 参考

- [`docs/ai/recipes/add-acp-agent.md`](../ai/recipes/add-acp-agent.md) —— 今天的接入清单（本文的替代目标）
- [`docs/接入方案/接入其它-ACP-Agent.md`](../接入方案/接入其它-ACP-Agent.md) —— 通用 ACP 接入指南 + agent 表（由 `gen-docs-tables.mjs` 生成）
- [`docs/repowiki/06-ACP-大脑与副本.md`](../repowiki/06-ACP-大脑与副本.md)、[`docs/repowiki/07-远程任务-Worker.md`](../repowiki/07-远程任务-Worker.md)
- [`docs/设计文档/文档守卫设计.md`](文档守卫设计.md) —— 三个守卫脚本的设计与维护指南
- [`scripts/acp-probe.mjs`](../../scripts/acp-probe.mjs) —— 能力探针的兼容薄壳（实现与唯一事实源是 `wemind agent probe`）
