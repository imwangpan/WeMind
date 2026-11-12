# 接入 OpenAI Codex（探针 + 真机 E2E）

> **2026-11-12 口径**：默认 `homeMode=real`，微信侧使用 `<账号>/agent-view/<role>/<agent>/` 配置视图，并与终端共享真实配置、技能、记忆与会话库；本文涉及 `brain-home` / `worker-home` 的描述仅适用于显式 `homeMode=sandbox`。

> **最后核对**：2026-11-12 ｜ **状态**：✅ 已内置预设、**探针级实测**（ACP 握手 / 一轮 prompt / `session/load` 恢复 / 图片 / `set_mode` / `set_config_option(model)` / stdio MCP）；**真机 E2E 已通过**（2026-11-01：worker 通道任务 #21 + brain 通道微信单轮，回复均送达）；**适配器 2.6.0 探针复测通过**（2026-11-12，见 §2.1）。
>
> 实测环境：Windows 11、Node 24.21.0、`@agentclientprotocol/codex-acp` **2.6.0**（**ACP 项目维护，非 OpenAI 官方**）、Codex CLI 0.167.2。2.5.0 的结论仍保留在 §2，2.6.0 的复测见 §2.1；升级后请按 §2 重新跑探针。
> **相关文档**：[接入其它-ACP-Agent.md](接入其它-ACP-Agent.md) · [ai/recipes/add-acp-agent.md](../ai/recipes/add-acp-agent.md) · [接入-Qoder.md](接入-Qoder.md)（原生 ACP 样板）

---

## 0. TL;DR

- Codex CLI **本身不实现 ACP**，必须经适配器 `@agentclientprotocol/codex-acp`（npm 包，bin = `codex-acp`）桥接。
- **能力完整，协议层零改动**：`initialize` 报 `loadSession:true`、`promptCapabilities.image:true`、`sessionCapabilities` 含 `resume/close/fork/list/delete/additionalDirectories/subagents/systemPrompt`；`session/load`、`session/set_mode`、`session/set_config_option(model)` 全部实测通过；图片能进模型；工具调用**不发反向请求**。
- **MCP（2026-11-12 复测修正，2.5.0 与 2.6.0 均通过）**：`mcpCapabilities: { acp:false, http:true, sse:false }` 里的 `acp` 指 **MCP-over-ACP 传输**，**不表示 stdio 不支持**。实测 `codex-acp 2.5.0` / `2.6.0` 都能接收 `session/new` 的 stdio `mcpServers`：模型实际调用了探针的 `fake_ping` 并返回 `FAKE_PONG`。因此 WeMind 的 `codex` 预设已开 `mcpViaAcp: true`。Codex 自己的 `~/.codex/config.toml` 仍由 Codex 原生加载；同名 server 由 Codex 条目优先，适配器会跳过客户端重复项。
- 免审批：预设注入 `INITIAL_AGENT_MODE=agent-full-access`，并在会话建立/恢复后调 `session/set_mode {modeId:"agent-full-access"}`（适配器的 mode = 审批策略 + 文件沙箱的合成档；`agent-full-access` = 全放行）。
- **模型不预设**：适配器把 Codex 自己的 `model` 作为 `configOption` 暴露（`session/set_config_option` 可用），但 WeMind **不下发**——让微信大脑跟着用户 `~/.codex` 的日常配置走（§4.14「用 agent，不改造它」）。要固定就用 `wemind brain set codex --model "<modelId>"`。

---

## 1. 安装（**全局安装优先**，npx 只作兜底）

```bash
npm i -g @agentclientprotocol/codex-acp
codex-acp --version     # → @agentclientprotocol/codex-acp 2.6.0
```

**为什么必须全局安装，而不是 `npx -y @agentclientprotocol/codex-acp`**（口径与 claude-code 一致，**完整对照表在 [接入其它-ACP-Agent.md §5 适配器安装口径](接入其它-ACP-Agent.md)**）：daemon 常驻、worker 每条任务起进程，`npx` 每次冷启动都要问 registry（离线不可用），版本还会随 latest 漂移。

> 结论：**适配器一律全局安装**；`npx` 只在「不想装、且能接受每次联网」时用（此时用 `wemind brain set codex --bin npx --args "-y @agentclientprotocol/codex-acp" --shell` 显式指定）。
>
> WeMind 侧的落点：`agentProblem()` 在找不到适配器时**直接给出可粘贴的 `npm i -g …` 命令**（见 `brain-agents.ts` 的 `ADAPTER_INSTALL_HINT`），不再只说一句「找不到二进制」。

**Windows 注意**：

- npm 全局安装产出的是 **`codex-acp.cmd`**（不是 `.exe`）→ 预设的 `binWin` 必须是 `codex-acp.cmd`，且 `shell: true`（`.cmd` 必须经 shell，见 AGENTS.md §4.6）。`onPath()` 按精确文件名判定，写成 `codex-acp.exe` **永远解析不到**（2026-10-30 已在 main 修正）。
- 想让 `codex-acp` 在 PATH 上稳定可见：**装进一个固定目录并把该目录加进用户 PATH**。用 fnm 时注意 `npm prefix -g` 会指向**当前 shell 的 multishell 临时目录**（换终端就变），应当用 `npm i -g --prefix "<fnm 常驻安装目录>"` 装，再把那个目录写进用户 PATH。
- 适配器默认**自带** `@openai/codex` 依赖。若想复用本机已装的 Codex（省 100 MB 下载），装适配器时加 `--omit=optional`，并设 `CODEX_PATH=<codex.exe 的绝对路径>`（适配器官方支持的环境变量）。**这个变量要设在 daemon 进程的环境里**（`wemind start` 前在同一个 shell 里设，或写进服务定义），设完要重启 daemon——`agentEnv()` 是从 `process.env` 起底再叠加预设值的，所以在别的窗口里 `$env:CODEX_PATH=…` 只对那个窗口里的进程有效。§2 探针块里的 `CODEX_PATH` 同理只作用于探针进程本身。

**认证**：适配器把认证交给 Codex 自己（`authMethods: api-key / chat-gpt`）→ 先在本机 `codex login`（ChatGPT 登录）或设 `OPENAI_API_KEY`；已有 `~/.codex/config.toml`（自定义网关/provider）时**直接沿用**，WeMind 不代管凭据。

---

## 2. M0 探针结果（2026-10-30，codex-acp 2.5.0）

探针：[`scripts/acp-probe.mjs`](../../scripts/acp-probe.mjs)

```powershell
$env:ACP_BIN = "codex-acp.cmd"          # 或绝对路径
$env:ACP_SHELL = "1"
$env:CODEX_PATH = "<codex.exe 绝对路径>" # 用本机已装的 Codex 时（只作用于这个探针进程）
node scripts/acp-probe.mjs
```

| # | 问题 | 结果 |
|---|---|---|
| C1 | capabilities | `loadSession:true`；`promptCapabilities:{image:true, embeddedContext:true}`；`sessionCapabilities:{resume,list,close,delete,fork,additionalDirectories,subagents,systemPrompt}`；`mcpCapabilities:{acp:false, http:true, sse:false}`；`authMethods:[api-key, chat-gpt]` |
| C2 | 恢复会话 | `session/load` ✅（`loadSession:true`）；恢复后再问，**上下文保留**（答出 `PINEAPPLE`）→ WeMind 用默认 `restore:"load"` 即可 |
| C3 | 免审批模式 | `session/new` 返回 `modes.availableModes = [read-only, workspace-write, agent, agent-full-access]`；`session/set_mode {modeId:"agent-full-access"}` **成功** |
| C4 | 模型 | `configOptions` 含 `mode` / `collaboration_mode` / `model` / `reasoning_effort`；`session/set_config_option {configId:"model"}` **成功**（本机默认 `auto/MiniMax-M3.1-Flash`，来自用户自己的模型网关路由） |
| C5 | 图片 | 带 1×1 PNG 的 prompt 正常 `end_turn`，模型能看到「附件在会话日志里」→ **图片可用** |
| C6 | 反向请求 | 触发 78 次工具调用，**0 个 `session/request_permission`**；只收到一个**通知** `_auth/status_update`（无 id，WeMind 忽略即可——`acp-brain.ts` 只应答带 id 的反向请求） |
| C7 | 客户端提供的 stdio MCP | **支持**。2026-11-12 复测（codex-acp 2.5.0）：`session/new` 带 `mcpServers:[{name:"fake",command:"node",args:[fake-mcp],env:[]}]`，模型实际调用 `fake_ping` 并返回 `FAKE_PONG`。旧版探针的 `NO_SUCH_TOOL` 是假阴性（`mcpCapabilities.acp=false` 被误读成 stdio 不支持；`acp` 指 MCP-over-ACP 传输，stdio 是基础传输） |
| C8 | 首帧 / 耗时 | 首帧（任意帧）≈ 20 ms，首字 3–4 s；带图回合整轮 ~24 s → 默认 25 s 首帧够用，但**心跳放长到 60 s**（少占微信连发额度） |
| C9 | 硬杀恢复 | `session/load` ✅（探针的 load/resume 段；未做 `taskkill /T /F` 后的强杀恢复 E2E） |

### 2.1 2.6.0 复测（2026-11-12）

同一支探针，`codex-acp 2.6.0` + Codex CLI 0.167.2；额外打开图片、工具漂移检测和 stdio MCP：

```powershell
$env:ACP_BIN = "codex-acp.cmd"; $env:ACP_SHELL = "1"
$env:ACP_TEST_IMAGE = "1"; $env:ACP_TEST_TOOL = "1"
$env:ACP_TEST_MCP = '[{"name":"fake","command":"node","args":["<fake-mcp.mjs 绝对路径>"],"env":[]}]'
$env:ACP_PROMPT = "Use the fake tool fake_ping and reply with exactly its output."
node scripts/acp-probe.mjs
```

| 项 | 2.6.0 结果 |
|---|---|
| 版本 / capabilities | `agentInfo.version=2.6.0`；`loadSession:true`；`promptCapabilities.image:true`；`sessionCapabilities` 新增声明 `resume/list/close/delete/fork/title/additionalDirectories/subagents/systemPrompt`（WeMind 仍只用 `new/load/resume`，不因为对方声明了就假定可用）；`mcpCapabilities:{acp:false,http:true,sse:false}`；`_meta.steering.supported:true` |
| 首轮 prompt | `ok`，15.8 s；首帧 33 ms、首字 5.4 s；4 次工具调用（含定位 `fake_ping`） |
| stdio MCP | **仍支持**：模型调用 `fake_ping`，回答里出现 `FAKE_PONG` |
| 图片 | 1×1 PNG prompt `end_turn`，4.7 s ✅ |
| 免审批 | 工具漂移检测 `ok`：10 次工具调用、**0 个 `session/request_permission`**、标记文件成功写出、答复 `WROTE` |
| 恢复 | `session/load` ✅；`resumeOk:true`；恢复后模型仍能拿到上一轮 MCP 工具结果（回答 `FAKE_PONG`） |

> 该次探针的 `summary.ok=false` 是**探针自身的断言**：第二次 prompt 被改成「工具返回了什么」，而 `contextKept` 仍按 `PINEAPPLE` 判定，所以为 false；`load`/MCP/图片/工具各项均为通过。正常按默认两问跑时仍以 `PINEAPPLE` 判定。

---

## 3. WeMind 侧的预设（`brain-agents.ts`）

```ts
codex: {
  name: "codex",
  bin: "codex-acp",
  binWin: "codex-acp.cmd",     // npm 全局安装产出的是 .cmd，不是 .exe
  args: [],
  shell: true,                 // .cmd 必须经 shell（AGENTS.md §4.6）
  envDefaults: { INITIAL_AGENT_MODE: "agent-full-access" }, // 适配器自己的环境变量（免审批兜底；父进程已设则以其为准）
  sessionMode: "agent-full-access",                // 会话建立/恢复后 session/set_mode
  heartbeatMs: 60_000,         // 回合可能几十秒；少占微信连发额度
  realHome: path.join(os.homedir(), ".codex"), // 只用于配置指纹/危险路径；不传给适配器
  catalogFile: "config.toml",  // 原生 MCP 由 Codex 自己加载；WeMind 只读解析它用于列出/指标（不写回、无法 unload）
  mcpViaAcp: true,             // 支持客户端经 ACP 传入 stdio MCP（2026-11-12 实测）
  // 不设 model：跟随用户 ~/.codex 的默认（要用就 `wemind brain set codex --model …`）
  // 不设 homeEnvVar：适配器不读 WeMind 沙箱，凭据/配置全用 Codex 自己的
}
```

- **不在 `AUTO_PROBE_ORDER`**：适配器类一律不参与自动探测（独立安装、各有认证；「装了但没登录」的机器被自动选中会静默换脑）。要用得显式：`wemind brain set|switch codex`、一次性 `WEMIND_BRAIN=codex`，或微信「切换大脑 codex」。
- 沙箱：适配器不读 `KIRO_HOME` 之类，故无 `homeEnvVar`；WeMind 只把 **cwd** 指到 `BRAIN_HOME`（隔离工作目录），Codex 自己的 `~/.codex` 照常使用（用户日常配置原样生效）。**凭据不同步进沙箱**——Codex 的登录态在 `~/.codex`，适配器直接用（§4.9 的密钥纪律：WeMind 不碰用户的 auth.json）。
- **免审批的两道保险**：`envDefaults.INITIAL_AGENT_MODE`（适配器建会话时的初始模式）与 `session/set_mode {modeId:"agent-full-access"}`（会话建立/恢复后补切）。`applyAcpSessionMode` 会核对会话回包的 `modes.availableModes`——codex 的回包含 `agent-full-access`（实测），所以会真的切；想关掉设 `WEMIND_ACP_SESSION_MODE=0/false/off/no`。

---

## 4. 已知限制

1. **MCP 有两条来源，别混为一谈**（C7）：
   - **Codex 原生 MCP**：`~/.codex/config.toml` 里定义的 server 由 Codex 自己加载；WeMind 只读解析 `[mcp_servers.*]` 用于 `列出`/指标，**不会写回、也无法 unload**。终端 Codex 能用的原生 MCP，微信侧 codex 也能用；因此 brain 的“默认空 MCP”管不住这部分。原生条目里出现 `wechat`（或任何会跑 `wemind-mcp` 的定义）时，brain/worker 直接拒绝启动，避免第二个 poller。
   - **WeMind 动态 MCP**：`mcpViaAcp: true` 后，微信侧 `加载/卸载` 通过 ACP `session/new|load|resume` 的 `mcpServers` 下发给 codex；只对 WeMind catalog / overlay `mcp.extra` 里的定义有效。原生 config.toml 里的名字不会出现在 `加载` 的候选列表里。
   - **同名冲突**：Codex 原生条目优先，适配器会跳过同名的客户端条目（并记日志）；不会出现两个同名 server。
   - **brain 默认空** 只控制 WeMind 下发的 ACP 集合；Codex 原生 `config.toml` 的 MCP 仍会被 Codex 加载。这是 codex 没有独立配置目录带来的边界，不是 WeMind 静默忽略。
2. **不走 WeMind 的凭据沙箱**：Codex 的登录态在 `~/.codex`，适配器直接用；WeMind 不同步、不改写（§4.14）。
3. **模型/推理档位由 Codex 决定**：WeMind 默认不下发；需要固定时 `wemind brain set codex --model "<modelId>"`（`session/set_config_option`，幂等）。
4. **真机 E2E 已过一轮**（2026-11-01）：**worker 通道**——`wemind brain switch codex --worker` 后 `wemind task "…"` 由 codex 执行，`prompt ok 4436ms`，回话「2」正常产出（`set_mode agent-full-access` 生效，0 反向请求）；**brain 通道**——微信发「你好，自我介绍一句」，`turn start` → `session/prompt` → `prompt ok 2962ms` → `final send`（3 段），回复送达。**发图 / 冷重启 `session/load` 待复测**；切脑回切已随 pi↔codex 双向热切换验证（2026-11-01，见 `docs/接入方案/接入-pi.md`）。
5. **没有独立配置目录**：codex 适配器不认 `KIRO_HOME`/`CLAUDE_CONFIG_DIR` 之类，WeMind 只能把 **cwd** 指到角色默认工作区（`<账号>/workspace/{brain,worker}`；`sandbox` 模式才是沙箱根）。所以微信里 codex 看到的「当前目录」是工作区，**不一定是你正在开发的项目**；要它处理某个项目请在消息里点明路径，或把工作区切到该项目（worker 侧也可用 `wemind task --cwd`）。
6. **版本敏感**：`codex-acp` 的 capabilities 与 mode id 随版本变化；升级后重跑 §2 的探针（本文当前基线 2.6.0）。

---

## 5. 复现命令（贴给用户）

```powershell
# 1) 装适配器（全局）
npm i -g @agentclientprotocol/codex-acp
codex-acp --version

# 2) 确认 Codex 自己的认证可用
codex login status

# 3) 选 codex 当大脑（写盘；daemon 在跑就用 switch 热切）
wemind brain set codex
wemind brain check

# 4) 跑一遍探针（可选，复现本文结论）
$env:ACP_BIN = "codex-acp.cmd"; $env:ACP_SHELL = "1"; node scripts/acp-probe.mjs
```

---

## 6. 待实测

以下条目在本文中没有通过记录，来自状态行、§2 探针结果与 §4 已知限制里已明确标注的「待复测 / 未做」项：

- **真机带图一轮**：真机 E2E 只覆盖纯文本（worker 任务 #21、brain 微信单轮）；探针 C5 已验证图片能力，但微信侧发图的真机复测**待做**（§4 第 4 条）。
- **冷重启后续聊**：杀掉 daemon 再起、追问上一轮上下文（`session/load`）**待复测**（§4 第 4 条）。
- **`taskkill /T /F` 强杀恢复**：探针只验证了正常 `session/load`，强杀后的恢复 E2E **未做**（§2 C9；对应 [`docs/ai/已知坑.md`](../ai/已知坑.md)「仍未单独测」条）。
- **适配器升级后重跑探针**：`codex-acp` 的 capabilities 与 mode id 随版本变化（本文实测基线 2.6.0、Codex CLI 0.167.2；2.5.0 的旧结果保留在 §2）。升级后需按 §2 重新验证 `loadSession`、`image`、`availableModes` 含 `agent-full-access` 等结论是否仍成立（状态行与 §4 第 6 条）。

> **日志格式说明（2026-11-11，历史实测记录不改正文）**：本文记录的日志线索沿用当时的写法；现行运行日志统一由 `core/logging.ts` 的 `createLogger(scope)` 输出为 `[wemind/<scope>][INFO|WARN|ERROR|DEBUG] …`，全部 stderr。ACP 帧级关键线索（`spawn` / `initialized` / `session/new` / `prompt ok`）归 **INFO**（排障必须可见），`prompt FAIL` 与自愈归 **WARN**。CLI 用户输出走 stdout 的 `print()`，无前缀无级别；`wemind log --errors` 精确认 `[ERROR]/[WARN]` 标记，升级前写入的旧日志仍按关键词兼容。详见 [`AGENTS.md`](../../AGENTS.md) 与 [`repowiki/11`](../repowiki/11-开发指南.md)。
