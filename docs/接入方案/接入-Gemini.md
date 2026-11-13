# 接入 Gemini CLI（原生 ACP，探针 + 真机实测）

> **2026-11-13 口径**：默认 `homeMode=direct`，WeMind 不写任何 Agent 配置，Agent 直接读真实 home，并与终端共享配置、技能、记忆与会话库；本文涉及 `brain-home` / `worker-home` 的描述仅适用于显式 `homeMode=sandbox`。

> **最后核对**：2026-11-12 ｜ **实测环境**：Windows 11 + Node 24 + `@google/gemini-cli` 0.66.0
>
> **状态**：✅ 内置预设、ACP 探针全部通过（`initialize` / `session/new` / prompt / 图片 / 工具调用 0 反向请求 / 强杀后 `session/load`）；MCP 与沙箱已实测；`wemind brain check` 握手通过（约 3.0s）；**微信真机 E2E 已通过（2026-11-01：单轮、杀 daemon 后 `session/load`、热切换、worker 任务）**。
>
> Gemini CLI 原生实现 ACP，不需要适配器。WeMind 内置预设名：**`gemini`**。

---

## 1. 准备

```powershell
npm i -g @google/gemini-cli    # 实测 0.66.0；要求 Node ≥20
gemini                         # 终端里先完成认证（Google 登录 / API key / 自定义网关）
gemini --version               # 确认版本（0.66+）
gemini --help                  # 确认 --acp 参数存在（--version 只打印版本号，不列参数）
```

认证方式以 `~/.gemini/settings.json` 的 `security.auth.selectedType` 为准；API key / 自定义网关（如用户自建网关）的 base URL 写在 `~/.gemini/.env`：

```ini
GEMINI_API_KEY=...
GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:<port>
```

WeMind 把 API key 的 `.env`，以及 Google 登录用的 `oauth_creds.json` / `google_accounts.json` 作为**凭据文件**同步进沙箱，并把真实 `settings.json` 作为**设置基底**——终端 `gemini` 与微信大脑用同一套认证与模型。

## 2. 预设要点（`brain-agents.ts`）

| 项 | 值 | 说明 |
|---|---|---|
| 启动 | `gemini --acp --approval-mode yolo --skip-trust`，Windows shim 是 `.cmd` → `shell: true` | `--acp` 取代已弃用的 `--experimental-acp`；`--approval-mode yolo` 与 `--yolo` 互斥，二选一 |
| `--skip-trust` | **必须带** | 未信任的目录不仅把 yolo **静默降回 default**，连 MCP 都不加载（用户级 server 也被抑制）；实测 `gemini mcp list` 在未信任目录直接显示 Disabled |
| 配置目录 | `homeEnvVar: "GEMINI_CLI_HOME"` 仅在 `sandbox` 指向沙箱根；`direct` 不注入，直接用真实 `~/.gemini`，`configSubdir: ".gemini"` | Gemini 把 `GEMINI_CLI_HOME` 当「家目录」，配置目录是 `<它>/.gemini`（实测：临时 home 自动生成 `.gemini/projects.json`）；不是指到配置目录本身 |
| 记忆/技能继承 | `inheritDirs: ["skills"]` + `inheritFiles: ["GEMINI.md"]` | 全局技能在 `<配置目录>/skills`，全局记忆是 `<配置目录>/GEMINI.md`（源码 `path.join(geminiDir, "skills")` / `getGlobalMemoryFilePath`） |
| 设置基底 | `settingsBase: "settings.json"` + `settingsStrip: ["mcpServers"]` | 保留用户自己的 `model.name` / `security` / `ui` / `general`；只剥 `mcpServers`（MCP 必须来自沙箱 curated，防 `wechat` 回环），并强制 `general.enableAutoUpdate=false`（不要让常驻 daemon 自己换版本）。Gemini 自己用 `strip-json-comments` 解析，允许 `//` / `/* */` 注释——沙箱镜像与 MCP 目录也按 JSONC 读 |
| 凭据同步 | `credentialFiles: [".env", "oauth_creds.json", "google_accounts.json"]` | API key 用户：`GEMINI_API_KEY` / `GOOGLE_GEMINI_BASE_URL` 在 `.env`；Google 登录用户：OAuth token 与账号缓存跟着用户日常配置走（新者胜）。**只镜像 `selectedType=oauth-personal` 却不带 token 时，Gemini 会卡在登录流程，连 ACP `initialize` 都不回** |
| MCP | 配置目录 `settings.json` 的 `mcpServers`（kiro 格式），`mcpViaAcp: false` | `--skip-trust` 后实测可被调用（探针 MCP server 的 `probe_ping` 返回 `PONG`）；`initialize` 的 `mcpCapabilities` 只声明 http/sse、不声明 acp |
| 模型 | 预设不带 `model` → 跟随 `settings.json` 的 `model.name`；覆盖走 `modelArg: "--model"` | Gemini 0.66 **不支持** `session/set_config_option`（`-32601`），所以 `wemind brain set gemini --model …` 会追加成 `gemini … --model <值>`，不再走 ACP 下发 |
| 历史回放 | `replayOnLoad: true` | `loadSession` 返回后它还会**异步回放历史**（源码 `session.streamHistory(messages)` 不 await）；恢复会话后先等帧流安静（`acp-quiet.ts`：200ms 静默窗口、最多 3s）再提问，否则旧回复会被拼进本轮答复 |
| 免审批 | `--approval-mode yolo`（会话模式）；不设 `sessionMode` | `session/new` 回包的 `modes` 里 `currentModeId` 就是 `yolo`；`session/set_mode` 不是必需 |
| 恢复 | 默认 `load`（`loadSession: true`） | 强杀后 `session/load` 能接回上下文（探针 PINEAPPLE） |
| 自动探测 | **在 `AUTO_PROBE_ORDER` 第 4 位** | 原生 ACP，`opencode → cline → qoder → gemini → deepseek → kiro` |

## 3. 探针实测结论（`scripts/acp-probe.mjs`，2026-11-01）

| 项 | 结果 |
|---|---|
| `initialize` | `protocolVersion: 1`；`agentInfo = gemini-cli 0.66.0`；`loadSession: true`；`promptCapabilities: { image: true, audio: true, embeddedContext: true }`（**WeMind 只用预设的 `images` 字段决定发不发图，`audio` / `embeddedContext` 未使用**）；`mcpCapabilities: { http: true, sse: true }`（**没有 acp 字段**）；`authMethods` 含 oauth-personal / gemini-api-key / vertex-ai / gateway |
| `session/new` | OK；回包有 `modes`（default / autoEdit / yolo / plan，当前 yolo）与 `models`（`currentModelId` = 用户 settings 里的模型，如 `auto/hy3`） |
| prompt | 首帧 ~1ms（usage/thought），**首段正文 3.4s**，整轮 ~3.6s；update 类型 `user_message_chunk` / `agent_thought_chunk` / `agent_message_chunk` / `available_commands_update` / `usage_update`（有 activity 帧，心跳无忧） |
| 图片 | ✅ 接受（1×1 PNG → `end_turn`，无报错） |
| 工具调用（`ACP_TEST_TOOL=1`） | ✅ 标记文件落盘、2 次 tool_call、**0 个 `session/request_permission`**（yolo 生效） |
| 反向请求 | **0** |
| 强杀后 `session/load` | ✅ 上下文接上（PINEAPPLE）；load 返回约 0.6s |
| **load 后的历史回放** | ⚠️ load 返回后约 11ms 起，把历史消息逐条当 `user_message_chunk` / `agent_message_chunk` 发回来（源码不 await `streamHistory`）。若不处理，下一轮答复会以旧回复开头（实测拼出 `STOREDPINEAPPLE`）→ 预设用 `replayOnLoad` 先等安静 |
| `session/set_config_option` | ❌ `-32601 Method not found`（模型必须走 `--model`） |
| `session/close` | ❌ `-32601`（WeMind 不调用） |
| MCP（配置文件） | ✅ `sandbox` 的 `settings.json` 的 `mcpServers` 被加载；模型真实调用 `probe_ping` → `PONG`；`direct` 由真实配置决定 |
| MCP（ACP `session/new.mcpServers`） | ✅ 也能用（同样是 `probe_ping` → `PONG`），但 `initialize` 不声明 acp → 预设仍走配置文件，不依赖未声明的能力 |

升级后要复现上表，直接用下面这段（临时 home，不碰真实 `~/.gemini`）：

```powershell
$env:ACP_BIN = "gemini.cmd"                       # 或绝对路径
$env:ACP_ARGS = '["--acp","--approval-mode","yolo","--skip-trust"]'
$env:ACP_SHELL = "1"
$env:ACP_HOME_ENV = "GEMINI_CLI_HOME"             # 预设的 homeEnvVar
$env:ACP_HOME = "$env:TEMP\gemini-acp-probe"
$env:ACP_TEST_TOOL = "1"                          # 漂移检测：强制一次工具调用
$env:ACP_TEST_IMAGE = "1"
node scripts/acp-probe.mjs
```

> 探针只验证**参数与能力**；凭据要另备（临时 home 里没有认证信息）。要看微信大脑的真实效果，仍然以 `wemind brain check` 和真机一轮为准。

## 4. 已知限制 / 坑

- **`--skip-trust` 不能省**：未信任目录 = yolo 降级 + MCP 全禁用。大脑 cwd 是账号默认工作区 `<账号>/workspace/brain`（`sandbox` 模式也不改 cwd），新账号/新工作区仍可能未受信任，所以必须显式信任。
- **模型名必须能被你的网关解析**：`session/new` 的 `availableModels` 是 Gemini CLI 自己的候选列表，**不等于**网关实际提供的模型。实测在自建网关下 `--model auto` 会路由到 `gemini-3.1-pro-preview`，网关回 `knows no model …`；网关部署要写它认识的 id（如 `auto/hy3`）。`wemind brain set gemini --model …` 原样传给 `gemini --model`。
- **load 后回放**：这是 Gemini 的 ACP 实现细节，不是 WeMind 的会话记录；`replayOnLoad` 只在恢复后**丢掉**这些帧（不转发给微信用户）。上限 3s 是防它持续发帧把回合卡住；正常历史（几十条）实测 10ms 级回放完。
- **自动更新关掉（仅 `sandbox`）**：沙箱 `settings.json` 的 `general.enableAutoUpdate` 由 `settingsBase()` 统一写成 `false`（用户已有的其它 `general` 键保留）；终端日常 `gemini` 的真实配置不动。理由：常驻 daemon 不该在运行中自己换版本。
- **MCP 策略**：`direct` 由真实配置决定；`sandbox` 下大脑默认空 + 微信里 `加载 <名>` 才写进沙箱，worker 继承真实 `mcpServers` 全量但**永久排除 `wechat`**。真实 `~/.gemini/settings.json` 不动。
- **不支持 `session/set_config_option`**：除模型外，其它想通过 ACP 改的配置项也走不了；优先改 `settings.json`（WeMind 会镜像进沙箱）或启动参数。
- **`session/close` 未实现**：WeMind 本来就不调用；只是探针会记一条。
- **`GEMINI_CLI_HOME` 的隔离边界**：配置目录整体重定向（实测临时 home 会生成 `.gemini/`，真实 `~/.gemini` 不被写）。`extensions/` 不在继承清单里（WeMind 不复制、不 junction）；Gemini 是否仍会从真实 home 读到扩展**待实测**——别把「没继承」直接当成「不会加载」。确需共享时按 agent 布局加 `inheritDirs`。
- **OAuth 凭据的范围**：默认文件存储下同步 `oauth_creds.json` + `google_accounts.json`。若显式开启 `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE`，凭据可能在系统钥匙串或 `gemini-credentials.json`，沙箱无法可靠复用（待实测）；这种部署改用 API key，或关闭该选项。
- **settings.json 允许注释**：Gemini CLI 用 `strip-json-comments` 读配置，`//` / `/* */` 是它的合法输入。WeMind 的沙箱镜像、MCP 目录读取与 `wemind brain check` 都按 JSONC 解析，不会因为注释把 model/security 静默丢成空基底。
- **上游版本会变**：0.66.0 的 `--acp`、`mcpCapabilities`、`set_config_option` 缺失都是当前事实；升级后重跑 `scripts/acp-probe.mjs`（含 `ACP_TEST_TOOL=1`）与 `wemind brain check`，别拿旧结论当现状。

## 5. 审批机制与漂移预案

- **免审批是 Gemini 自己的 approval mode**：`--approval-mode yolo` 在 `session/new` 里直接体现为 `currentModeId: yolo`；未信任目录会静默降回 `default`（这就是 `--skip-trust` 必须带的原因）。
- **漂移检测已实现**：`ACP_TEST_TOOL=1` 跑探针——强制一次真实工具调用（写 `drift-check.txt`），同时断言 `session/request_permission` 为 0、文件确实落盘。升级 Gemini 后先跑它，别等微信第一条消息卡住才发现审批行为变了。
- **若上游改成必须先审批**：先看它是否提供新的 `--approval-mode` 值或 settings 键（用 `gemini --help` / `~/.gemini/settings.json` 的 schema），优先用 agent 自己的开关（§4.14）；实在没有才依赖宿主兜底（默认即逐次自动允许；`WEMIND_ACP_AUTO_ALLOW=0` 才会拒绝，不改变沙箱）。

## 6. 验证记录

- 探针（2026-11-01，0.66.0）：§3 全绿；`ok=true`、`contextKept=true`、图片 `end_turn`、`toolTest.ok=true`（2 次工具调用 / 0 权限请求 / 标记文件落盘）、反向请求为空。
- 回放专项（临时脚本，2026-11-01）：`session/load` 返回 t+627ms，回放帧在 t+638ms / t+640ms 到达；等 3s 后再 prompt，答复只有 `PINEAPPLE`（不带历史）；不等时探针答复为 `STOREDPINEAPPLE`。
- `wemind brain check`（从源码构建的 CLI，`WEMIND_BRAIN=gemini`）：`ACP 握手成功（initialize + session/new，3036ms）`。
- 单测：`brain-agents.test.ts` 覆盖 gemini 预设字段、`--model` 追加到启动参数、默认 `settingsStrip`、OAuth 凭据清单；`sandbox-gemini.test.ts` 覆盖**带注释的**设置基底（保留 model/security/general、剥 `mcpServers`、关自动更新）、`.env` + OAuth 凭据 / `skills` / `GEMINI.md` 继承、大脑 curated MCP 与 `wechat` 拒绝、worker 全量 MCP 除 `wechat`；`acp-quiet.test.ts` 覆盖回放等待的静默/持续/上限三种路径。
- 凭据/JSONC 回归（2026-11-02）：`sandbox-gemini.test.ts` 用**带 `//` 与 `/* */` 注释**的真实 settings.json 验证沙箱仍镜像 `model` / `security`、`加载 <MCP>` 仍能读到目录；OAuth 的 `oauth_creds.json` / `google_accounts.json` 同步进 brain 与 worker 沙箱。OAuth 登录的实机握手仍待有 Google 登录环境的机器复验（本机是 API key 用户）。
- **微信真机 E2E（2026-11-01，已通过）**：新会话单轮 → `prompt ok 4757ms` → 微信收到「4」；杀 daemon 重启后追问 → `session/load` + `drained 20 replay frame(s)` → `prompt ok 3682ms` → 回复「4」（旧历史未混入）；热切换 gemini ↔ pi 两个方向都成功，切回 gemini 时 `session/load` + 再排空 34 帧，下一轮 `prompt ok 3540ms` → 回复「9」；worker 任务 #28 / #29 均由 gemini 执行（`prompt ok 4313ms` / `3215ms`）；之后又一次重启 + `session/load`（排空 40 帧）→ `prompt ok 3296ms` → 回复「7」。微信侧 `加载 <MCP>` 尚未单独复测（配置文件方式加载 MCP 已在探针验证）。

## 7. 待实测

- **微信侧 `加载 <MCP>`**：尚未单独复测（配置文件方式加载 MCP 已在探针验证，§3）。
- **`extensions/` 的真实来源**：`extensions/` 不在继承清单里（WeMind 不复制、不 junction），但 Gemini 是否仍会从真实 home 读到扩展**待实测**——「没继承」不等于「不会加载」（§4）。
- **OAuth 登录的实机握手**：本机是 API key 用户；OAuth 的 `oauth_creds.json` / `google_accounts.json` 已同步进 brain 与 worker 沙箱（单测覆盖），实机握手仍待有 Google 登录环境的机器复验（§6）。
- **加密文件存储下的凭据复用**：显式开启 `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE` 时，凭据可能落在系统钥匙串或 `gemini-credentials.json`，沙箱能否可靠复用**待实测**；这种部署目前建议改用 API key 或关闭该选项（§4）。

> 升级 Gemini 后先按 §3 的命令重跑 `scripts/acp-probe.mjs`（含 `ACP_TEST_TOOL=1`）与 `wemind brain check`，再按新版本更新本节结论（§4「上游版本会变」）。
