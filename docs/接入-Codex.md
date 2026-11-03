# 接入 OpenAI Codex（设计文档）

> **适用版本**：WeMind 1.3.0 ｜ **最后核对**：2026-11-02 ｜ **状态**：✅ 已内置预设、**探针级实测**（ACP 握手 / 一轮 prompt / `session/load` 恢复 / 图片 / `set_mode` / `set_config_option(model)`）；**真机 E2E 已通过**（2026-11-01：worker 通道任务 #21 + brain 通道微信单轮，回复均送达）。
>
> 实测环境：Windows 11、Node 24.21.0、`@agentclientprotocol/codex-acp` **2.5.0**（官方维护）、Codex CLI 0.165–0.166。适配器还在 2.x，升级后请按 §2 重新跑探针。
> **相关文档**：[接入其它-ACP-Agent.md](接入其它-ACP-Agent.md) · [ai/recipes/add-acp-agent.md](ai/recipes/add-acp-agent.md) · [接入-Qoder.md](接入-Qoder.md)（原生 ACP 样板）

---

## 0. TL;DR

- Codex CLI **本身不说 ACP**，必须经适配器 `@agentclientprotocol/codex-acp`（npm 包，bin = `codex-acp`）桥接。
- **能力完整，协议层零改动**：`initialize` 报 `loadSession:true`、`promptCapabilities.image:true`、`sessionCapabilities` 含 `resume/close/fork/list/delete/subagents/systemPrompt`；`session/load`、`session/set_mode`、`session/set_config_option(model)` 全部实测通过；图片能进模型；工具调用**不发反向请求**。
- **唯一缺口**：适配器声明 `mcpCapabilities: { acp: false, http: true, sse: false }`——**不支持客户端提供的 stdio MCP server**（实测传进去工具也不出现）→ WeMind 的 `codex` 预设**不开** `mcpViaAcp`，微信里「加载/卸载 MCP」对 codex 无效。**与 claude-code 相反**：claude-agent-acp 只声明 http/sse 但 stdio 实测可用——能力字段两家都不可信，只能以实测为准。
- 免审批：预设注入 `INITIAL_AGENT_MODE=agent-full-access`，并在会话建立/恢复后调 `session/set_mode {modeId:"agent-full-access"}`（适配器的 mode = 审批策略 + 文件沙箱的合成档；`agent-full-access` = 全放行）。
- **模型不预设**：适配器把 Codex 自己的 `model` 作为 `configOption` 暴露（`session/set_config_option` 可用），但 WeMind **不下发**——让微信大脑跟着用户 `~/.codex` 的日常配置走（§4.14「用 agent，不改造它」）。要固定就用 `wemind brain set codex --model "<modelId>"`。

---

## 1. 安装（**全局安装优先**，npx 只作兜底）

```bash
npm i -g @agentclientprotocol/codex-acp
codex-acp --version     # → @agentclientprotocol/codex-acp 2.5.0
```

**为什么必须全局安装，而不是 `npx -y @agentclientprotocol/codex-acp`**（口径与 claude-code 一致，见 [接入-ClaudeCode.md](接入-ClaudeCode.md) §1）：

| 维度 | 全局安装 | `npx -y` |
|---|---|---|
| 首次启动 | 装一次即可 | 现下（适配器 + 依赖的 Codex 平台二进制约 100 MB） |
| 之后每次启动 | 直接起进程（~1 s） | 多一层 `npm exec` 解析 + **每次都要问一次 registry**（离线即失败） |
| daemon 常驻 | ✅ 适合 | ❌ 热切换/重启时反复拉起，且要联网 |
| 路径 | `codex-acp`（Windows 上是 **`codex-acp.cmd`**） | 走 `npx` 裸名，PATH 上永远有 → 不能用来「判定装没装」 |

> 结论：**适配器一律全局安装**；`npx` 只在「不想装、且能接受每次联网」时用（此时用 `wemind brain set codex --bin npx --args "-y @agentclientprotocol/codex-acp" --shell` 显式指定）。
>
> WeMind 侧的落点：`agentProblem()` 在找不到适配器时**直接给出可粘贴的 `npm i -g …` 命令**（见 `brain-agents.ts` 的 `ADAPTER_INSTALL_HINT`），不再只说一句「找不到二进制」。

**Windows 注意**：

- npm 全局安装产出的是 **`codex-acp.cmd`**（不是 `.exe`）→ 预设的 `binWin` 必须是 `codex-acp.cmd`，且 `shell: true`（`.cmd` 必须经 shell，见 AGENTS.md §4.6）。`onPath()` 按精确文件名判定，写成 `codex-acp.exe` **永远解析不到**（2026-10-30 已在 main 修正）。
- 想让 `codex-acp` 在 PATH 上稳定可见：**装进一个固定目录并把该目录加进用户 PATH**。用 fnm 时注意 `npm prefix -g` 会指向**当前 shell 的 multishell 临时目录**（换终端就变），应当用 `npm i -g --prefix "<fnm 常驻安装目录>"` 装，再把那个目录写进用户 PATH。
- 适配器默认**自带** `@openai/codex` 依赖。若想复用本机已装的 Codex（省 100 MB 下载），装适配器时加 `--omit=optional`，并设 `CODEX_PATH=<codex.exe 的绝对路径>`（适配器官方支持的环境变量）。

**认证**：适配器把认证交给 Codex 自己（`authMethods: api-key / chat-gpt`）→ 先在本机 `codex login`（ChatGPT 登录）或设 `OPENAI_API_KEY`；已有 `~/.codex/config.toml`（自定义网关/provider）时**直接沿用**，WeMind 不代管凭据。

---

## 2. M0 探针结果（2026-10-30）

探针：[`scripts/acp-probe.mjs`](../scripts/acp-probe.mjs)

```powershell
$env:ACP_BIN = "codex-acp.cmd"          # 或绝对路径
$env:ACP_SHELL = "1"
$env:CODEX_PATH = "<codex.exe 绝对路径>" # 用本机已装的 Codex 时
node scripts/acp-probe.mjs
```

| # | 问题 | 结果 |
|---|---|---|
| C1 | capabilities | `loadSession:true`；`promptCapabilities:{image:true, embeddedContext:true}`；`sessionCapabilities:{resume,list,close,delete,fork,additionalDirectories,subagents,systemPrompt}`；`mcpCapabilities:{acp:false, http:true, sse:false}`；`authMethods:[api-key, chat-gpt]` |
| C2 | 恢复会话 | `session/load` ✅（`loadSession:true`）；恢复后再问，**上下文保留**（答出 `PINEAPPLE`）→ WeMind 用默认 `restore:"load"` 即可 |
| C3 | 免审批模式 | `session/new` 返回 `modes.availableModes = [read-only, workspace-write, agent, agent-full-access]`；`session/set_mode {modeId:"agent-full-access"}` **成功** |
| C4 | 模型 | `configOptions` 含 `mode` / `collaboration_mode` / `model` / `reasoning_effort`；`session/set_config_option {configId:"model"}` **成功**（本机默认 `auto/MiniMax-M3.1-Flash`，来自用户自己的 magpie 网关路由） |
| C5 | 图片 | 带 1×1 PNG 的 prompt 正常 `end_turn`，模型能看到「附件在会话日志里」→ **图片可用** |
| C6 | 反向请求 | 触发 78 次工具调用，**0 个 `session/request_permission`**；只收到一个**通知** `_auth/status_update`（无 id，WeMind 忽略即可——`acp-brain.ts` 只应答带 id 的反向请求） |
| C7 | 客户端提供的 stdio MCP | `session/new` 带 `mcpServers:[{name:"fake",command,args}]` **不报错**，但模型**看不到**该 MCP 的工具（实测回答 `NO_SUCH_TOOL`）→ 与 `mcpCapabilities.acp=false` 一致 → **WeMind 不给 codex 开 `mcpViaAcp`** |
| C8 | 首帧 / 耗时 | 首帧（任意帧）≈ 20 ms，首字 3–4 s；带图回合整轮 ~24 s → 默认 25 s 首帧够用，但**心跳放长到 60 s**（少占微信连发额度） |
| C9 | 硬杀恢复 | `session/load` ✅（探针的 load/resume 段；未做 `taskkill /T /F` 后的强杀恢复 E2E） |

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
  // 不设 mcpViaAcp：适配器不支持 stdio MCP
  // 不设 model：跟随用户 ~/.codex 的默认（要用就 `wemind brain set codex --model …`）
  // 不设 homeEnvVar：适配器不读 WeMind 沙箱，凭据/配置全用 Codex 自己的
}
```

- **不在 `AUTO_PROBE_ORDER`**：适配器类一律不参与自动探测（`npx` 几乎总在 PATH 上，会被误选）。要用得显式：`wemind brain set|switch codex`、一次性 `WEMIND_BRAIN=codex`，或微信「切换大脑 codex」。
- 沙箱：适配器不读 `KIRO_HOME` 之类，故无 `homeEnvVar`；WeMind 只把 **cwd** 指到 `BRAIN_HOME`（隔离工作目录），Codex 自己的 `~/.codex` 照常使用（用户日常配置原样生效）。**凭据不同步进沙箱**——Codex 的登录态在 `~/.codex`，适配器直接用（§4.9 的密钥纪律：WeMind 不碰用户的 auth.json）。
- **免审批的两道保险**：`envDefaults.INITIAL_AGENT_MODE`（适配器建会话时的初始模式）与 `session/set_mode {modeId:"agent-full-access"}`（会话建立/恢复后补切）。`applySessionMode` 会核对会话回包的 `modes.availableModes`——codex 的回包含 `agent-full-access`（实测），所以会真的切；想关掉设 `WEMIND_ACP_SESSION_MODE=0/false/off`。

---

## 4. 已知限制

1. **无 stdio MCP**（C7）：微信里「加载/卸载 MCP」对 codex 不生效。
2. **不走 WeMind 的凭据沙箱**：Codex 的登录态在 `~/.codex`，适配器直接用；WeMind 不同步、不改写（§4.14）。
3. **模型/推理档位由 Codex 决定**：WeMind 默认不下发；需要固定时 `wemind brain set codex --model "<modelId>"`（`session/set_config_option`，幂等）。
4. **真机 E2E 已过一轮**（2026-11-01）：**worker 通道**——`wemind brain switch codex --worker` 后 `wemind task "…"` 由 codex 执行，`prompt ok 4436ms`，回话「2」正常产出（`set_mode agent-full-access` 生效，0 反向请求）；**brain 通道**——微信发「你好，自我介绍一句」，`turn start` → `session/prompt` → `prompt ok 2962ms` → `final send`（3 段），回复送达。**发图 / 冷重启 `session/load` 待复测**；切脑回切已随 pi↔codex 双向热切换验证（2026-11-01，见 `docs/接入-pi.md`）。
5. **没有沙箱配置目录**：codex 适配器不认 `KIRO_HOME`/`CLAUDE_CONFIG_DIR` 之类，WeMind 只能把 **cwd** 指到 `BRAIN_HOME`——所以微信里 codex 看到的「当前目录」是沙箱根（实测它据此说「可以分析这个 brain-home 目录」），**不在你真实项目里**。要在真实目录干活请在消息里点明路径（worker 侧由 `wemind task --cwd` 指定）。
6. **版本敏感**：`codex-acp` 的 capabilities 与 mode id 随版本变化；升级后重跑 §2 的探针。

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

