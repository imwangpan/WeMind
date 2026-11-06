# 接入其它 AI Agent（ACP 配置指南）

> **最后核对**：2026-11-05 ｜ **状态**：内置 9 个预设——kiro/opencode/deepseek/qoder/cline 已实测，**gemini 已探针级实测 + 真机 E2E（0.66.0，2026-11-01）**、**claude-code 已实测（探针级 + 真机微信单轮 E2E）**、**codex 已实测（探针级 + 真机 E2E）**、**pi 已探针级实测 + 真机 E2E（2026-11-01）**。
>
> 本文说明如何把 WeMind daemon 的「大脑」从默认的 `auto` 换成另一个 ACP agent（默认 `auto` 按 `opencode → cline → qoder → gemini → deepseek → kiro` 探测已安装者，kiro 排最后）。**多数原生 ACP agent 可以零代码接入；但 ACP 不是完全统一的能力集**——缺 `session/load`、会发反向请求、没有 activity 帧或图片能力不同，都需要协议层适配（见 §9）。

---

## 0. 一句话版本（先看这段，30 秒判断能不能接）

> WeMind 的大脑必须是一个**可启动的命令行程序**（executable CLI：daemon 以子进程方式运行它，spawn as a child process），并且**实现 ACP 协议**（implements the ACP protocol：原生实现 built-in，或经由 **ACP 适配器** adapter 桥接 bridged），通过**标准输入输出**（stdin/stdout，即 stdio）交换 **JSON-RPC** 帧；其 ACP 实现至少要支持 `initialize`、`session/new`，以及能**流式**（streaming）回包的 `session/prompt`。`session/load`、`session/resume`、**图片输入**（image input）、**MCP 传输**（MCP transport）、**反向请求**（reverse request）这些是**可降级项**（optional / degradable capabilities），按**agent 配置字段**（preset fields）逐项适配。
>
> 反过来说：**没有 CLI 入口的裸 HTTP API**（bare HTTP API，如 OpenAI / Anthropic / Ollama）目前接不了——那需要抽象 `Brain` 接口（`Brain` interface abstraction）并另写一个 HTTP 实现（见 §9）。

拆成可判断的四个必要条件（four prerequisites）：

| # | 条件 | 怎么判断 | 不满足怎么办 |
|---|---|---|---|
| 1 | 有**可执行入口**（executable entry point：CLI 或可被 `spawn` 的程序） | 终端里能直接跑起来 | 没有进程可启动 → 只能走 §9 的「第二档：裸 API 适配器」（未实现） |
| 2 | **实现 ACP**（implements ACP），或有 **ACP 适配器**（ACP adapter） | 官方文档的 ACP / 「agent client protocol」章节；或社区适配器项目 | 有 CLI 但无 ACP → 找/写适配器（如 `claude-agent-acp`、`codex-acp`）；见 §5 |
| 3 | ACP 实现覆盖**最小方法集**（minimal method set） | 跑 [`scripts/acp-probe.mjs`](../../scripts/acp-probe.mjs) 看 `initialize` + `session/new`；跑 `wemind brain check` 做真握手 | `session/new` 或流式 `session/update` 缺失 → 不可用，放弃 |
| 4 | 能**完成自身认证**（agent's own authentication）并在 daemon 环境里可解析（resolvable on PATH / by absolute path） | 二进制在 `PATH` 上（或 `--bin` 给绝对路径）、模型/登录态已就绪 | 配 `--bin` 绝对路径、`homeEnvVar`、凭据同步；见 §7 平台注意 |

> 「支持 ACP」这四个字**不足以**说明可用：同一**协议**（protocol）的不同**实现**（implementation），能力差别很大。第 3 项才是真正决定能不能接入的那一步。
>
> **术语约定**：本文一律用「**实现/支持 ACP**」——ACP 是协议（规范），实现才是一个程序；完整中英对照见 [`docs/ai/术语表.md`](../ai/术语表.md)。

---

## 1. 工作原理

WeMind 的 daemon 把一个 agent CLI 当作常驻「大脑」：用 `child_process.spawn()` 把它**启动为子进程**，再通过 **ACP（Agent Client Protocol，JSON-RPC 2.0 over 标准输入输出，每行一个 JSON 消息）** 与它通信。ACP 由 Zed 提出，kiro-cli、Gemini CLI、opencode、DeepSeek Harness 等都已实现。

daemon 使用 ACP 的一个**最小方法集**，但不同 agent 的可用能力不同：

- `initialize` —— 握手；返回 `agentCapabilities`（是否支持 load/resume、image、MCP）；**WeMind 当前不解析该回包**：image / restore / mcpViaAcp 等能力全部来自 `brain-agents.ts` 的预设字段，不要误读为自动适配；
- `session/new` —— 新建会话；
- `session/load` —— 按 sessionId 恢复会话（**不是所有 agent 都实现**）；
- `session/resume` —— 部分 agent（如 DSH）用它恢复持久会话；
- `session/prompt` —— 发一轮提问；
- `session/update`（通知）—— 流式回包：`agent_message_chunk`（正文）、`tool_call`/`tool_call_update`（工具进度）等；
- `session/request_permission`（反向请求）—— agent 向 client 发请求；不应答会挂起。

因此「接入一个新 agent」主要是告诉 WeMind **怎么把它以 ACP 模式启动起来**；协议层能复用，但**能力差异要按 agent 补**（见 §9）。

相关代码：

- `packages/wechat-daemon/src/brain-agents.ts` —— agent 表与解析逻辑（本文主角）；
- `packages/wechat-daemon/src/acp-brain.ts` —— ACP 客户端（协议层；缺 load/反向请求时需要改）；
- `packages/wechat-daemon/src/worker-acp.ts` —— worker 的 ACP 客户端；协议层（帧分类、超时、模型与模式、回放静默）brain 与 worker 共用 `acp-connection.ts`，只有进程生命周期与会话持久化各自实现。

---

## 2. 接入一个 agent 需要确认的 4 件事

| # | 信息 | 说明 | kiro 的取值 |
|---|------|------|------------|
| 1 | **二进制名/路径** | 可执行文件名（在 PATH 上）或绝对路径 | `kiro-cli`（Win：`kiro-cli.exe`） |
| 2 | **ACP 启动参数** | 让该 CLI 进入「ACP server over stdio」模式的命令行参数 | `acp --trust-all-tools` |
| 3 | **配置目录环境变量名** | 该 agent 读取其配置/数据目录的环境变量名；WeMind 会把它指向 brain 沙箱目录，用于隔离与可选的 MCP 挂载。没有就留空 | `KIRO_HOME` |
| 4 | **ACP 兼容性** | 该 CLI 是否实现了 ACP 的最小方法集；**还要看** `initialize.agentCapabilities` 的 `load/resume/image/mcp` 与是否会发反向请求 | 是 |

> 第 1、2 项几乎所有 agent 都有；第 3 项各家差异较大（见 §6 MCP 沙箱）；第 4 项是前提——不支持 ACP 的 agent 走不了这条路，得用「第二档：裸 LLM API 适配器」（尚未实现，见 §9）。
>
> **不要只看「支持 ACP」四个字**：`session/load`、图片、MCP 传输、权限请求都可能不同。接入前先跑 [`scripts/acp-probe.mjs`](../../scripts/acp-probe.mjs)，把 `initialize` 能力与一次 prompt 的 `session/update` 类型记录下来。

---

## 3. 配置方式 A：选大脑（推荐写入磁盘持久；环境变量为一次性覆盖）

**选择存在「账号级配置文件」里**（`<数据目录>/brain.json`），任何入口重启都能复现；`wemind brain` 是切换它的正门：

| 命令 | 作用 |
|------|------|
| `wemind brain [<key\|label>]` | 查看：配置、生效值、来源、二进制是否可用 |
| `wemind brain set <agent 名\|auto> [--bin X] [--args "…"] [--extra-args "…"] [--shell\|--no-shell] [--model X\|auto] [--restart] [<key\|label>]` | 写入 brain.json；daemon 在跑且认控制桥时，**只给 agent 名**会当场热切换（成功才写入磁盘，失败不改 brain.json）；带 `--bin`/`--args`/`--extra-args`/`--shell`/`--model` 不能由它当场应用（控制桥只认 agent 名）——重启后生效，或（除 `--shell` 外）随后 `wemind brain switch <同名 agent>` 当场应用；`--restart` 顺带重启 daemon 立即生效 |
| `wemind brain unset [<key\|label>]` | 删除 brain.json，回退到自动探测/默认 |
| `wemind brain check [<key\|label>]` | 真起一个进程跑 ACP 握手（`initialize` + `session/new`；预设带 `sessionMode` 时再补一次 `session/set_mode`，失败只写进结论不判整体失败），验证「不仅找得到、而且能实现 ACP」 |

```powershell
wemind brain set opencode --restart    # 切到 OpenCode 并立即重启 daemon
wemind brain                            # 查看当前大脑
wemind brain check                      # 真机自检（真实 ACP 握手）
```

`brain.json` 形如（`bin` / `args` / `shell` / `homeEnvVar` 可选，用于**覆盖该 agent**的启动细节）：

```json
{ "agent": "opencode" }
```

> `--bin` / `--args` 只覆盖**已知 agent**的启动细节（例如把 `opencode` agent 指向绝对路径的 `opencode.exe`）。
> 全新 agent 请先按 §4 加一条 agent——agent 携带沙箱/MCP 约定，光有二进制不足以接进来。

### 3.1 选择优先级（`resolveAgent()`）

```
agent：  WEMIND_BRAIN(env)  >  brain.json 的 agent  >  auto（自动探测）
参数：   WEMIND_BRAIN_ARGS（整段替换）  >  brain.json 的 args  >  presets[agent 名].args  >  预设 args
追加：   WEMIND_BRAIN_EXTRA_ARGS  >  brain.json 的 extraArgs  >  presets[agent 名].extraArgs（拼在「参数」结果之后）
```

- **`auto`（未配置时的默认）**：按 `opencode → cline → qoder → gemini → deepseek → kiro` 取第一个**二进制在 PATH 上可解析**的 agent；适配器类（`claude-code`/`codex`/`pi`）不参与（独立安装、各有认证，误选中会让「装了但没登录」的机器静默换脑；显式选用更安全）。
- 一个都没装 → daemon **启动即失败并说人话**（不再「跑起来、第一条消息才炸」），提示安装或 `wemind brain set`。

### 3.2 环境变量（一次性覆盖，优先级最高）

临时试别的 agent 用它；**别写进 profile**——那等于把隐式默认换成另一个值固定死，换个入口重启仍会变。给 daemon 进程设这些变量，优先级高于 brain.json 与内置默认值：

| 环境变量 | 作用 | 默认 |
|------|------|------|
| `WEMIND_BRAIN` | 选用哪个 agent（见 §5），如 `kiro` / `opencode` / `auto` | `auto`（自动探测） |
| `WEMIND_BRAIN_BIN` | 覆盖二进制（绝对路径或 PATH 上的名字） | 默认自动在 PATH 解析 |
| `WEMIND_BRAIN_ARGS` | 覆盖 ACP 启动参数（**空格分隔、整段替换**） | 内置默认值 |
| `WEMIND_BRAIN_EXTRA_ARGS` | 追加 ACP 启动参数（**空格分隔**，拼在预设/覆盖参数之后；只加开关时用它，不会漏掉 `acp`） | 无 |
| `WEMIND_ACP_SESSION_MODE` | 覆盖/关闭预设的 `sessionMode`：`0`/`false`/`off`/`no` 关闭 `session/set_mode`，其它非空值 = 该 modeId（影响 claude-code / codex 的免审批） | 用预设值 |
| `WEMIND_BRAIN_HOME_ENV` | 覆盖「配置目录环境变量名」（指向 brain 沙箱） | 内置默认值 |
| `WEMIND_BRAIN_SHELL` | 是否经 shell 启动（`1`/`true` 开）；npx/`.cmd`/`.bat` 类适配器在 Windows 需要 | 内置默认值（默认 false） |
| `WEMIND_BRAIN_INHERIT` | 是否继承真实配置目录的记忆/规则/技能（见 §6.5） | `1`（开） |
| `WEMIND_BRAIN_REAL_HOME` | 覆盖被继承的真实配置目录 | 配置里的 `realHome` |
| `WEMIND_BRAIN_INHERIT_DIRS` | 覆盖继承的子目录清单（逗号/空格分隔） | 配置里的 `inheritDirs` |
| `WEMIND_MCP_CATALOG` | 覆盖可选 MCP 的来源文件路径（默认取该 agent 真实配置目录下的 `catalogFile`：kiro `settings/mcp.json`、opencode `opencode.json`、qoder `settings.json`、cline `data/settings/cline_mcp_settings.json`、gemini `settings.json`、pi `mcp.json`） | `<realHome>/<catalogFile>` |
| `KIRO_CLI_BIN` | 旧的 kiro 专用二进制覆盖（仅 `kiro` agent、且未设 `WEMIND_BRAIN_BIN` 时生效） | — |

解析优先级（`resolveAgent()`）：

```
二进制：WEMIND_BRAIN_BIN  >  (kiro agent 时) KIRO_CLI_BIN  >  brain.json 的 bin  >  PATH 查找  >  agent 裸名
参数：  WEMIND_BRAIN_ARGS（空格切分）  >  brain.json 的 args  >  agent args
追加：  WEMIND_BRAIN_EXTRA_ARGS（空格切分）  >  brain.json 的 extraArgs  >  （拼在上面结果之后）
目录变量：WEMIND_BRAIN_HOME_ENV  >  brain.json 的 homeEnvVar  >  agent homeEnvVar
```

### 例子

完全用环境变量接入一个假想的 `acme-agent`（它用 `acme-agent serve --acp` 进入 ACP，配置目录环境变量是 `ACME_HOME`）：

```powershell
$env:WEMIND_BRAIN_BIN      = "acme-agent"
$env:WEMIND_BRAIN_ARGS     = "serve --acp"
$env:WEMIND_BRAIN_HOME_ENV = "ACME_HOME"
# 然后照常启动 daemon
```

> 这些变量需要对 **daemon 进程**生效。若用 `scripts/run-daemon.ps1` / `run-all-daemons.ps1` 启动，请在脚本里或计划任务的环境中设置（注意：多账号用 `Start-Process -Environment` 显式传，靠 `$env:` 继承不可靠）。

---

## 4. 配置方式 B：新增一条 agent 配置（推荐长期使用）

在 `packages/wechat-daemon/src/brain-agents.ts` 的 `ACP_AGENT_PRESETS` 里加一条：

```ts
export const ACP_AGENT_PRESETS: Record<string, AcpAgentPreset> = {
  kiro: { name: "kiro", bin: "kiro-cli", binWin: "kiro-cli.exe", args: ["acp", "--trust-all-tools"], homeEnvVar: "KIRO_HOME", kiroEngine: true },

  // 新增：
  acme: {
    name: "acme",
    bin: "acme-agent",          // 非 Windows 的可执行名
    binWin: "acme-agent.exe",   // Windows 可执行名（默认在 bin 后加 .exe）
    args: ["serve", "--acp"],   // 进入 ACP 模式的参数
    homeEnvVar: "ACME_HOME",    // 没有就删掉这行
    // requiresBins: ["acme"],  // 适配器内部还要 spawn 的运行时（只装适配器不够；缺失时 agentProblem() 提前报）
  },
};
```

> **适配器类不要加进 `AUTO_PROBE_ORDER`**：`claude-code` / `codex` / `pi` 都是显式选用（装好适配器 ≠ 已登录，参与探测会让「装了但没登录」的机器静默换脑）。原生 ACP 才追加到探测顺序末尾。

然后构建并选用（推荐写入磁盘持久）：

```powershell
npm run build
wemind brain set acme --restart          # 写入 brain.json 并重启 daemon
# 或一次性覆盖（仅对本次启动的 daemon 生效）：$env:WEMIND_BRAIN = "acme"
```

`AcpAgentPreset` 字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | agent 名（也用于日志） |
| `bin` | 是 | 非 Windows 可执行名 |
| `binWin` | 否 | Windows 可执行名，缺省为 `bin + ".exe"`（经 shell 启动时可用裸名让 shell 解析） |
| `requiresBins` | 否 | 除 `bin` 外还必须在 PATH 上解析到的运行时（如 pi-acp 内部还要 spawn `pi`；只装适配器不够），缺失时 `agentProblem()` 提前报错 |
| `args` | 是 | 进入 ACP 模式的启动参数数组 |
| `homeEnvVar` | 否 | 配置目录环境变量名；留空则不向 agent 传沙箱目录 |
| `shell` | 否 | 是否经 shell 启动（`.cmd`/`.bat`/`npx` 类在 Windows 需要 `true`） |
| `realHome` | 否 | 被继承的真实配置目录（记忆/技能来源） |
| `inheritDirs` | 否 | 从 `realHome` 链入沙箱的「目录式」记忆子目录 |
| `inheritFiles` | 否 | 从 `realHome` 拷入沙箱的单文件记忆（如 `AGENTS.md`） |
| `configSubdir` | 否 | agent 配置目录相对沙箱根的子路径（kiro 空；opencode `opencode`） |
| `mcpFormat` | 否 | MCP 配置格式：`kiro`（`mcpServers`）或 `opencode`（`mcp.servers`）；默认 `kiro` |
| `mcpConfigFile` | 否 | MCP 配置文件相对配置目录的路径（默认 `settings/mcp.json`） |
| `catalogFile` | 否 | 可选 MCP 目录来源文件相对 `realHome` 的路径（默认 `settings/mcp.json`） |
| `mcpViaAcp` | 否 | MCP 是否走 ACP `session/new`/`resume` 的 `mcpServers`（不写配置文件；如 DSH、Claude Code） |
| `env` | 否 | 额外注入的环境变量（强制；值里 `%HOME%` → 沙箱根），如 opencode 的 `OPENCODE_DISABLE_PROJECT_CONFIG` |
| `envDefaults` | 否 | **默认值**环境变量：父进程已设同名变量时**不覆盖**（如 DSH `DSH_PERMISSION_MODE`、codex `INITIAL_AGENT_MODE`）。审批/沙箱类开关用它，部署方可在 daemon 环境里收紧权限；跳过时会记日志 `env defaults kept from parent: …` |
| `credentialEnv` | 否 | 从 agent 自己的凭据文件**派生**环境变量（仅父进程未显式提供时；如 Cline 的 `clineCredentialEnv()` 从 `providers.json` 的 `lastUsedProvider` + `apiKey` 派生 `CLINE_PROVIDER` / `CLINE_API_KEY`）。只读、解析失败静默返回空；显式 env 永远优先 |
| `sessionMode` | 否 | 会话建立/恢复后经 `session/set_mode { sessionId, modeId }` 切到的模式（**agent 自己的 ACP 接口**；用于免审批：claude-code `bypassPermissions`、codex `agent-full-access`）。会话回包报告 `modes.availableModes` 且不含该值时**跳过**并记日志；调用失败只记日志、不拖垮回合。`WEMIND_ACP_SESSION_MODE=0/false/off/no` 关闭，其它非空值 = 覆盖 modeId |
| `replayOnLoad` | 否 | `session/load`/`resume` **返回后仍会异步回放历史帧**的 agent（gemini 的 `loadSession` 里 `streamHistory` 不 await）：恢复后先等帧流安静（200ms 静默窗口、最多 3s）再发本轮 prompt，否则历史会被拼进本轮答复。默认 `false` |
| `restore` | 否 | 恢复会话的方式：`load`（默认）或 `resume`（如 DSH） |
| `images` | 否 | 是否接受图片输入（默认 `true`；`false` 时 daemon 对带图消息友好拒绝，如 DSH / Cline） |
| `firstFrameMs` | 否 | 首帧超时覆盖（默认 25s；慢启动 / committed-only agent 可放宽） |
| `heartbeatMs` | 否 | 静默期心跳间隔覆盖（默认 15s；有 thought/tool/usage 帧的 agent 通常不需要） |
| `fallbackBinPaths` | 否 | `onPath()` 失败时依次尝试的绝对路径（官方安装不在 PATH 时兜底）。**`auto` 探测与 `resolveAgent` 共用这一份判据**（`presetAvailable()` → `presetBinPath()`），所以靠 fallback 命中的 agent 也会参与自动探测 |
| `settingsBase` | 否 | 以 `realHome` 下该文件为基底生成沙箱设置：按 `settingsStrip` 剥离键，并强制 `general.enableAutoUpdate=false`（qoder 与 gemini 都用 `settings.json`） |
| `settingsStrip` | 否 | `settingsBase` 基底里要删掉的键。默认 `mcpServers` / `enabledPlugins` / `providers` / `model`（qoder）；gemini 只删 `mcpServers`——它的 `model` / `security` 是用户自己的选择，必须原样保留 |
| `settingsDefaults` | 否 | 沙箱 `settings.json` 的**默认键**：只补真实配置里没有的键（用户显式设过就保留用户的值；只改沙箱副本、真实文件不动）。用于「agent 自己已有开关、但默认值不适合微信」的情形，如 pi 的 `quietStartup: true`（pi-acp 会把 pi 启动横幅当 `agent_message_chunk` 发出来） |
| `credentialFiles` | 否 | 需从 `realHome` 同步进沙箱配置目录的凭据文件（新者胜；DSH `.credentials.yaml`、qoder `.auth/user`） |
| `identityFiles` | 否 | 必须与 `realHome` 完全一致的标识文件（内容不同即覆盖；qoder `.auth/machine_id`——被 agent 重新生成会导致永久认证失败） |
| `model` | 否 | 默认模型（如 DSH 的 `'["deepseek-account","deepseek-flash"]'`，格式是 `[provider 路由, 模型名]`）：会话建立后经 `session/set_config_option { configId:"model", value }` 下发一次（显式覆盖以它为准）；**用户可用 `wemind brain set <agent 名> --model …` 覆盖**（写进 `brain.json` 的 `presets.<名>.model`）。解析优先级「本段 > `presets[agent 名]` > 真实 profile 的默认 > 预设兜底」，`--model auto`/`default` = 跟随真实 profile 的默认（见下行 `realProfile`），**读不到就不下发**（由 agent 用自己的默认，**不会**改用本行的预设值）；只有完全没写 model 时，读不到才用本行预设值兜底 |
| `modelArg` | 否 | 不支持 `session/set_config_option` 的 agent（gemini 实测 `-32601`）：模型改为追加到启动参数，如 `"--model"` → `gemini … --model <值>`（进程启动时生效，不再走 ACP 下发） |
| `realProfile` | 否 | 该 agent **用户层 profile 的名字**（DSH：`"acp"`，对应真实 `<realHome>/profiles/acp/`）。沙箱在 `syncSettings` 里**原样复制**这份 `cordis.patch.yml`（agent 自己首次启动生成的往往是空壳 `[]`，不同步就连它的 provider 路由都不存在；WeMind 不追加任何条目——缺的配置由用户自己补，`wemind brain` 只提示），并由 `profile-model.ts` 从它读默认模型（优先用户写的 `- id: acp`，否则 `agent-default-model`）——用户日常怎么用，WeMind 就跟着怎么用 |
| `kiroEngine` | 否 | kiro 专用（`true`）：按 `--agent-engine` → 真实 `settings/cli.json` 的 `acp.agentEngine` → CLI 主版本 ≥3 判断 v2/v3（`acp --help`：两者都没设时默认 v2；CLI ≥3 默认 v3 为假设/待实测，仅作兜底）；v3 时剔除 v2 专属的 `--trust-all-tools` / `-a` / `--trust-tools`、补 `--agent-engine v3`，并在沙箱写 `settings/permissions.yaml` 的 allow-all 规则（真实设置已有则原样保留）。见 §5 |
| `isolateSessions` | 否 | DSH 专用（`true`）：启动前落盘 `<数据目录>/agent-sessions/deepseek/session-root-<brain\|worker>.patch.yml`，用 `--patch` 把 `session-persistence-jsonl.root` 指到 `agent-sessions/deepseek/<role>`，避免与 kiro/pi 共用沙箱根时把其它 agent 写进 `sessions/` 的平铺文件当成自己的会话库；用户 `--args` 自带 `--patch` 时不再追加 |

---

## 5. 内置 agent

ACP agent 分两类，接入方式不同：

- **原生 ACP**：CLI 自带 ACP 模式，加个参数直接起（如 kiro、Gemini、Cline）。
- **需适配器**：CLI 本身不实现 ACP，要起一个**第三方适配器进程**来桥接（如 Claude Code、Codex）。适配器一般有自己的认证（API key / 登录）。同一个适配器能否用上 WeMind 沙箱/MCP 机制，取决于它**自己**提不提供对应接口：Claude Code 适配器认 `CLAUDE_CONFIG_DIR`（可直接指到沙箱）、并通过 ACP `session/new|load` 的 `mcpServers` 接收 MCP；Codex 适配器已实测（2026-10-30 探针 + 2026-11-01 真机 E2E，`load`/图片/`set_mode`/模型设置可用，stdio MCP 不可用）。见 §6。

| agent 名 | 程序 | 类型 | 状态 | 启动（示意） |
|--------|-------|------|------|------|
| `kiro` | kiro-cli | 原生 | ✅ **已实测（v2 2.37.1 真机；v3 探针级 2026-11-03）**：v2 用 `acp --trust-all-tools`；v3 **拒绝**这批 v2 参数（会连 `initialize` 都不回），免审批改为沙箱 `settings/permissions.yaml` 的 allow-all 规则，启动参数补 `--agent-engine v3`。引擎判定顺序见下方注。 | v2：`kiro-cli acp --trust-all-tools`；v3：`kiro-cli acp --agent-engine v3`；`KIRO_HOME`。引擎判定见下方注 |
| `opencode` | OpenCode | 原生 | ✅ **已实测** | `opencode acp`，`XDG_CONFIG_HOME`（详见 [接入-OpenCode.md](接入-OpenCode.md)） |
| `deepseek` | DeepSeek Harness `dsh` | 原生（官方 ACP profile） | ✅ **已内置/已实测（0.2.1-rc.3，2026-11-03 复测）**：prompt / 工具 / resume 上下文 / stdio MCP；`load` ❌、`image:false`（收图友好拒绝）。**会话 root 已隔离**：启动前 `prepareAgent()` 落盘 `--patch` 文件，把 DSH 的会话库指到 `<账号目录>/agent-sessions/deepseek/<brain\|worker>`（否则会把它人写进共用沙箱根的 `sessions/` 当成自己的，报 `unsupported flat-file layout`） | `dsh --profile acp --patch "<账号目录>/agent-sessions/deepseek/session-root-<role>.patch.yml"`，`DSH_HOME`；建议 `--bin` 绝对路径（详见 [接入-DeepSeek.md](接入-DeepSeek.md)） |
| `qoder` | Qoder CLI `qodercli` | 原生（`--acp`） | ✅ **已内置/已实测**：`load`/`resume`、图片、stdio/HTTP/SSE MCP、`--yolo` 下 0 反向请求；M1 沙箱 + M3 真机 E2E 均通过（详见 [接入-Qoder.md](接入-Qoder.md)） | `qodercli --acp --yolo`，`QODER_CONFIG_DIR`；直接起本体，**不要**走 `qoder` 分发器；需同步 `.auth/user` + `.auth/machine_id` |
| `cline` | Cline CLI `cline` | 原生（`--acp`） | ✅ **已内置/已实测（3.0.74）**：`loadSession`、硬杀后 `session/load` 上下文保留、0 反向请求；**图片 ❌**（广告 `image:true` 但 ACP `prompt` 只保留 text → `images:false`）；`session/close` ❌（WeMind 不调用）。**认证注意**：ACP 只自动恢复 `cline`/`cline-pass`/`openai-codex`；自定义 provider 由 `credentialEnv` 从 `providers.json` 自动派生 `CLINE_PROVIDER`+`CLINE_API_KEY`（显式 env 优先；详见 [接入-Cline.md](接入-Cline.md)） | `cline --acp --auto-approve true`；`CLINE_DIR`/`CLINE_DATA_DIR`/`CLINE_MCP_SETTINGS_PATH` 指向沙箱；`providers.json`/`models.json` 同步（缺 models.json 会回退 `gpt-4o`）；MCP 走 `cline/mcp.json`（ACP `mcpServers` 不生效） |
| `gemini` | Gemini CLI | 原生（`--acp`） | ✅ **已内置/已实测（0.66.0 探针）**：`loadSession` ✅（强杀后 `session/load` 上下文保留；但 load 返回后仍会**异步回放历史** → `replayOnLoad` 先等帧流安静）、图片 ✅、工具调用 0 反向请求（yolo）；`session/set_config_option` ❌（`-32601`，模型走 `--model` 启动参数）、`session/close` ❌（WeMind 不调用）。MCP：`settings.json` 的 `mcpServers` 实测生效（ACP `session/new` 的 mcpServers 也能用，但 `initialize` 只声明 http/sse、不声明 acp → 走配置文件更稳）。**`--skip-trust` 必须带**：未信任目录不仅把 yolo 静默降回 default，连 MCP 都不加载（用户级 server 也被抑制） | `gemini --acp --approval-mode yolo --skip-trust`；`GEMINI_CLI_HOME` 指向沙箱根，配置目录是 `<它>/.gemini`（`configSubdir: ".gemini"`）；`settings.json` 作设置基底（只剥 `mcpServers`，保留 model/security）、`.env` 作凭据同步、`skills/` + `GEMINI.md` 继承。详见 [接入-Gemini.md](接入-Gemini.md) |
| `claude-code` | Claude Code | 需适配器（官方维护） | ✅ **已内置/已实测（探针级 + 真机微信单轮 E2E）**：`load`/`resume` ✅、图片 ✅、stdio MCP ✅、`bypassPermissions` ✅、该模式下 0 反向请求；2026-10-31 真机微信单轮通过（`prompt ok 5381ms`、回复送达）；重启续聊 / MCP / 任务待复测 | `claude-agent-acp`（npm 包 `@agentclientprotocol/claude-agent-acp`，**先 `npm i -g` 全局安装**；**Node ≥22，且必须是运行 daemon 的那个 Node**——`agentProblem()` 只查 PATH 不查版本，Node 20 的 daemon 会通过预检却在 spawn 时失败；Windows 上是 `claude-agent-acp.cmd`，故预设 `binWin: "claude-agent-acp.cmd"` + `shell: true`）。`CLAUDE_CONFIG_DIR` 指到沙箱；MCP 走 ACP `mcpServers`（`mcpViaAcp`，目录取真实 `~/.claude.json`）。适配器不解析 CLI 权限 flag，免审批走 `session/set_mode {modeId:"bypassPermissions"}`（**以 root 跑且未设 `IS_SANDBOX=1` 时该模式不可用**，会话回包的 `availableModes` 里没有它，WeMind 会跳过并记日志）。详见 [接入-ClaudeCode.md](接入-ClaudeCode.md) |
| `codex` | OpenAI Codex | 需适配器（官方维护） | ✅ **已内置/已实测（探针级 + 真机 E2E：worker 与 brain 通道均通过）**：`load` ✅、图片 ✅、`set_mode` ✅、`set_config_option(model)` ✅、工具调用 0 反向请求；**stdio MCP ❌**（适配器 `mcpCapabilities.acp=false`，实测传进去的工具模型也看不到 → 不开 `mcpViaAcp`，微信侧「加载/卸载 MCP」对它无效）。2026-11-01 真机：切 worker 后 `wemind task` 由 codex 执行（`prompt ok 4436ms`，回话正常）；切 brain 后微信单轮 `prompt ok 2962ms`、回复送达。**没有沙箱配置目录**（只有 cwd 指向沙箱根） | `codex-acp`（npm 包 `@agentclientprotocol/codex-acp`，**先 `npm i -g` 全局安装**；Windows 上装出来的是 **`codex-acp.cmd`**，故预设 `binWin: "codex-acp.cmd"` + `shell: true`）。免审批：env `INITIAL_AGENT_MODE=agent-full-access`（预设 `envDefaults`）+ `session/set_mode {modeId:"agent-full-access"}`；codex 的 `--yolo` 不被适配器转发。详见 [接入-Codex.md](接入-Codex.md) |
| `pi` | pi coding agent | 需适配器（社区 `pi-acp`） | ✅ **已内置/探针级实测 + 真机 E2E（2026-11-01）**：`load` ✅、图片 ✅、首帧 0–3ms、有 thought/tool 帧、工具调用 0 反向请求、强杀后 `session/load` 上下文保留；`ACP_TEST_TOOL=1` 漂移检测通过（标记文件落盘、0 个权限请求）。**沙箱隔离不完整**：pi-acp 从真实 `homedir()` 读 `~/.pi/pi-acp/session-map.json`、`~/.pi/agent/prompts`、`~/.agents/skills` | `pi-acp`（**先 `npm i -g pi-acp`**；Windows 上是 `pi-acp.cmd`，故 `binWin: "pi-acp.cmd"` + `shell: true`）+ **`requiresBins: ["pi"]`**：另需 `npm i -g @earendil-works/pi-coding-agent` 并在终端里 `pi` 登录；只装适配器会被 `agentProblem()` 提前拒绝。`PI_CODING_AGENT_DIR` 指到沙箱根；MCP 走 `<沙箱根>/mcp.json`（kiro 格式，`mcpViaAcp: false`）；免审批无需开关。详见 [接入-pi.md](接入-pi.md) |

> **kiro v2 / v3（2026-11-03）**：预设 `kiroEngine: true`。引擎判定顺序：启动参数 `--agent-engine`（`v2`/`v3`，含 `=` 写法）→ 真实 `settings/cli.json` 的 `acp.agentEngine` → `kiro-cli --version` 主版本 ≥3 → 其余 v2。2.37.1 的 `kiro-cli acp --help` 原文是「`v2` when neither is set」；「CLI ≥3 默认 v3」是**假设/待实测**，只作兜底。`--agent-engine` 还接受 `v1`，未验证、WeMind 按 v2 处理（保留 v2 参数）。`chat.agentEngine` 只影响交互式 chat、**不影响 `acp`**（官方文档原话），别拿它推断。v3 时 WeMind 自动剔除 v2 专属的 `--trust-all-tools` / `-a` / `--trust-tools`（v3 会拒绝这些参数，表现为握手超时），补 `--agent-engine v3`，并在两个沙箱的 `settings/permissions.yaml` 写入 `rules: - capability: all / effect: allow`；真实设置里已有这份文件就原样同步、不覆盖用户规则。`_meta.kiro.policyPreset` 是**假方案**：2026-11-03 实测多种写法（`["allow-all"]` / `["allow_all"]` / `["trust-all"]` / `["all"]`）都不生效——权限请求照发、写文件仍被拒。v3 免审批的权威位置是 agent 自己的 **permissions 策略文件**，不是 ACP 元数据。
>
> **内置预设默认免审批**（2026-10-30 起）：每个 agent 用**自己官方**的机制——kiro v2 `--trust-all-tools`（v3 见上条：`settings/permissions.yaml`）、gemini `--approval-mode yolo (+ --skip-trust)`、qoder `--yolo`、cline `--auto-approve true`、opencode 沙箱 `opencode.json` 的 `"permission": "allow"`（`opencode acp` 不接受 `--auto`，官方 issue #52216）、DSH `DSH_PERMISSION_MODE=danger-full-access`（`envDefaults`：daemon 进程已设同名变量时以你的为准）、claude-code `session/set_mode bypassPermissions`、codex `agent-full-access`（`INITIAL_AGENT_MODE` 兜底 + `set_mode`）、pi 无需任何开关（官方默认不逐次审批，也没有要切的 `session/set_mode`）。**这不是统一开关**：写进 `--args` 的 CLI flag 只在 agent 真的解析它时才有效（claude-code / codex / pi 适配器都不解析）。想收紧：审批类环境变量（`DSH_PERMISSION_MODE`、`INITIAL_AGENT_MODE`）在 daemon 环境里设了就不被预设覆盖；`WEMIND_ACP_SESSION_MODE=0/false/off/no` 关掉 `session/set_mode`。边缘情况（各 agent 的 ask 规则、MCP 工具审批）仍可能发 `session/request_permission`：WeMind 默认**拒绝**，要全放行设 `WEMIND_ACP_AUTO_ALLOW=1`——它只是「每次自动点允许」，不放宽沙箱。**「免审批」≠「最高权限」**：DSH/codex 还有沙箱层，默认预设已把两层都放开。

> ⚠️ 9 个内置预设**都至少过了探针级实测**，但包名/参数/ACP 能力会随上游版本变化：**升级 agent 后按 §8 复验**，不要拿旧结论当当前事实。逐项：`kiro`/`opencode`/`deepseek`/`qoder`/`cline` 已真机长期使用；`gemini` 已过**探针级实测 + 真机 E2E**（0.66.0，2026-11-01：load/图片/MCP/yolo；brain 单轮、重启 `session/load`、热切换、worker；见 [接入-Gemini.md](接入-Gemini.md)）；`claude-code` 已过**探针级实测 + 真机微信单轮 E2E**（2026-10-31；重启续聊 / MCP / 任务待复测）；`codex` 已过**探针级实测 + 真机 E2E**（2026-11-01：worker 与 brain 通道均通、切脑回切已验；发图 / 冷重启待复测）；`pi` 已过**探针级实测 + 真机 E2E**（2026-11-01：brain 单轮、热切换、微信「任务 pi：…」派发）。
>
> `auto` 只探测 6 个原生预设（`opencode → cline → qoder → gemini → deepseek → kiro`）；三个适配器（`claude-code` / `codex` / `pi`）**不参与**（独立安装、各有认证，误选中会让「装了但没登录」的机器静默换脑），要显式指定：`wemind brain set|switch <agent 名>`、一次性的 `WEMIND_BRAIN=<agent 名>`，或微信「切换大脑 <agent 名>」。

**适配器类的准备工作**：

- **Claude Code**：**先全局安装适配器** `npm i -g @agentclientprotocol/claude-agent-acp`（得到 `claude-agent-acp`；Windows 上是 `claude-agent-acp.cmd`；**Node ≥22，且必须是运行 daemon 的那个 Node**——发布包 `engines` 只声明 ≥20.19，`agentProblem()` 不查 Node 版本，Node 20 的 daemon 能过预检却会在 spawn 时失败）。需完成 Claude Code 认证（`claude` 登录，或 daemon 环境设 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`，自定义网关再加 `ANTHROPIC_BASE_URL`）。该适配器把 Claude Code 暴露成 ACP server over stdio；**CLI 权限 flag 不会被解析**，WeMind 在会话建立后调用 `session/set_mode {modeId:"bypassPermissions"}`。预设 `CLAUDE_CONFIG_DIR` 指到 `<BRAIN_HOME>/claude`（实测连 `~/.claude.json` 一起隔离），`CLAUDE.md`/`skills`/`agents`/`commands` 与日常共享，MCP 走 ACP `mcpServers`（`mcpViaAcp`，目录取真实 `~/.claude.json`，`wechat` 永久禁止）。注意：Claude Code 以 **root** 运行时 `bypassPermissions` 不可用，除非设 `IS_SANDBOX=1`——此时会话回包的 `availableModes` 里没有它，WeMind 记录「跳过」日志，审批请求回到应答器（默认拒绝）。2026-10-30 探针实测（0.99.1）：`loadSession` ✅、图片 ✅、stdio MCP ✅、`bypassPermissions` 下 0 反向请求、强杀后 `session/load` 上下文保留；详见 [接入-ClaudeCode.md](接入-ClaudeCode.md)。
- **Codex**：**先全局安装适配器**：`npm i -g @agentclientprotocol/codex-acp`（Windows 产出 `codex-acp.cmd`，预设已按 `.cmd` 记录并通过 shell 启动），或用它仓库提供的 standalone 二进制并把 `--bin` 指向绝对路径。认证走 Codex 自己（`codex login` 或 `OPENAI_API_KEY`）；已有 `~/.codex/config.toml` 直接沿用。免审批由预设注入的 `INITIAL_AGENT_MODE=agent-full-access` 与会话建立后的 `session/set_mode` 完成；`codex` 自己的 `--yolo`/`--full-auto` 都不经适配器转发（`--full-auto` 在官方 CLI 里也不存在）。**MCP 不支持客户端提供的 stdio server**（探针实测）→ 微信侧「加载/卸载 MCP」对 codex 无效。**也没有沙箱配置目录**（适配器不认 `KIRO_HOME`/`CLAUDE_CONFIG_DIR` 之类），只有 cwd 指向沙箱根。详见 [接入-Codex.md](接入-Codex.md)。
- **pi**：需要两样东西——`npm i -g @earendil-works/pi-coding-agent`（pi 本体；**Node ≥22.19**，这是 pi 本体 engines 的要求，比 `pi-acp` 的 ≥20 更严；先在终端里 `pi` 登录/配好模型）与 `npm i -g pi-acp`（社区适配器）。**只装适配器不够**：预设的 `requiresBins: ["pi"]` 会让 `agentProblem()` 提前报「运行时 pi 缺失」并给出两条安装命令。`PI_CODING_AGENT_DIR` 指到沙箱根（`settings.json`/`auth.json`/`models*.json` 原样同步，`skills/` junction、`AGENTS.md` 复制）；预设用 `settingsDefaults: { quietStartup: true }` 关掉 pi-acp 当消息发出来的启动横幅（用户显式设过则保留）；worker 侧每次派发前按该任务 agent 重备沙箱（否则 `--agent pi` 会拿空配置跑）；MCP 走 pi 自己的 `<沙箱根>/mcp.json`（kiro 格式，`pi mcp list` 实测），适配器不消费 ACP `mcpServers` → `mcpViaAcp: false`；免审批无需开关。沙箱隔离不完整（适配器从真实 `homedir()` 读 session-map / prompts / skills）。详见 [接入-pi.md](接入-pi.md)。

> **适配器的安装口径（统一）**：**优先全局安装**（`npm i -g <适配器包>`），**不把 `npx -y` 当默认路径**。daemon 常驻、worker 每条任务起进程，两种方式的实际差别：

| 维度 | 全局安装（推荐） | `npx -y <包>` |
|---|---|---|
| 首次启动 | 装一次即可 | 现下（适配器 + 它依赖的 agent 本体/平台二进制，常见 100 MB 级） |
| 之后每次启动 | PATH 上直接起进程（~1 s） | 多一层 `npm exec` 解析 + **每次都要问 registry**（离线即失败） |
| daemon 常驻 | ✅ 适合 | ❌ 热切换/重启时反复拉起，且要联网 |
| 版本 | 由 `npm i -g` 固定，可复现 | 默认取 latest，静默漂移 |
| 出问题时 | `npm ls -g` / `where <bin>` 一眼可见 | 藏在 npm `_npx` 缓存里，难排查 |
| 路径判定 | 按精确文件名（Windows 上是 `<bin>.cmd`） | 走 `npx` 裸名，PATH 上永远「有」→ **不能用来判断装没装** |

`npx` 只作为「不想装、且能接受每次联网」的兜底：`wemind brain set <agent 名> --bin npx --args "-y <包名>" --shell`。
WeMind 侧的落点：找不到适配器二进制时，`agentProblem()` 会**直接给出可粘贴的 `npm i -g …` 命令**（`brain-agents.ts` 的 `ADAPTER_INSTALL_HINT`）。原生 ACP 的 agent（如 Cline）不需要适配器——`cline-acp` 已归档，直接用 `cline --acp`。

---

## 6. MCP 沙箱（重要差异点）

WeMind 让大脑跑在一个独立沙箱目录（`BRAIN_HOME`，由 `WECHAT_BRAIN_HOME` 决定），目的是：

1. **隔离**——大脑用的配置/会话与你本机日常用的该 agent 分开；
2. **可选 MCP 挂载**——通过微信指令 `加载/卸载 <MCP>` 动态改沙箱里的 MCP 配置，重启 agent 生效；
3. **杜绝回环**——默认不加载 `wechat` 自身 MCP。

实现方式是：把 `homeEnvVar`（kiro 是 `KIRO_HOME`）指向沙箱目录，再按该 agent 的 MCP 约定把**沙箱里**的那份配置文件写成 curated 内容（kiro 是沙箱配置目录的 `settings/mcp.json`，`mcpServers` 格式）。**catalog 则从该 agent 的「真实」配置目录读**（`catalogPath()` 用 `realHome`），真实文件一律不动——「读真实、写沙箱」。

**注意**：这套「沙箱 + MCP 配置」现在**按 agent 分派**（agent 配置字段驱动，见 `brain-agents.ts`）：

- `homeEnvVar` 决定把哪个环境变量指向沙箱（kiro 用 `KIRO_HOME`；opencode 用 `XDG_CONFIG_HOME`——后者能**替换**默认 global 目录，实现真正隔离）；
- `configSubdir` 决定 agent 配置目录相对沙箱根的位置（kiro 与 pi 空=沙箱根；opencode `opencode`；claude-code `claude`；gemini `.gemini`——它的 `GEMINI_CLI_HOME` 是「家目录」，配置目录在 `<它>/.gemini`）；
- `mcpFormat` / `mcpConfigFile` / `catalogFile` 决定 MCP 文件的结构与路径（kiro：`settings/mcp.json` 的 `mcpServers`；opencode：`opencode.json` 的 `mcp.servers`；pi：沙箱根 `mcp.json` 的 `mcpServers`；gemini：配置目录 `settings.json` 的 `mcpServers`）。

因此：**kiro、opencode、qoder、cline、pi、gemini 现已开箱支持「微信里动态加载/卸载 MCP」**（qoder 用 `QODER_CONFIG_DIR` + `settings.json` 的 `mcpServers`，沙箱实测生效；cline 用文件式 MCP：`CLINE_MCP_SETTINGS_PATH` → `cline/mcp.json`；pi 用 `<沙箱根>/mcp.json`，`pi mcp list` 实测可识别；gemini 用 `<沙箱>/.gemini/settings.json`，探针实测 MCP 工具可调用）；**DSH 与 Claude Code 走 `mcpViaAcp: true`**——不写配置文件，激活集由 `toAcpMcpServers()` 转成 ACP 声明随 `session/new|resume` 下发（DSH 已真机验证；Claude Code 探针实测 stdio MCP 可用）。其它 agent 若格式不同，则是上述 agent 配置字段填对即可；实在不同再按其约定适配。

- 若该 agent 也用「某个 HOME 环境变量 + 兼容结构」，设对 `homeEnvVar` 即可，MCP 挂载大概率可用；
- 该 agent 完全不需要配置目录时，把 `homeEnvVar` 留空，仅做隔离 cwd。

> 简言之：**对话/工具是通用的；「动态挂 MCP」依赖该 agent 的配置约定，跨 agent 不保证开箱即用。**

---

## 6.5 继承记忆 / 规则 / 技能（按 agent 配置）

为了让微信里的大脑和你日常使用同一 agent 时读到**同样的记忆、规则、技能**，沙箱会把该 agent 真实配置目录里的「知识/记忆」类子目录用 junction 链进 brain 沙箱（`settings`、`sessions` 除外——前者 MCP 必须隔离防它把消息发回自己，后者是 brain 自有会话）。

这一项**按 agent 配置驱动**（不同 agent 目录布局/记忆机制不同）：

| agent 配置字段 / 环境变量 | 含义 |
|---|---|
| 配置里的 `realHome` / `WEMIND_BRAIN_REAL_HOME` | 被继承的真实配置目录 |
| 配置里的 `inheritDirs` / `WEMIND_BRAIN_INHERIT_DIRS`（逗号/空格分隔） | 从 `realHome` 继承的子目录清单 |
| `WEMIND_BRAIN_INHERIT=0` | 关闭继承 |

- **kiro 已预置**：`realHome=~/.kiro`，`inheritDirs=steering,memories,skills,agents,powers,tasks,extensions`。
- **qoder 已预置**：`realHome=~/.qoder`，`inheritDirs=memory,skills,agents,commands`，`inheritFiles=AGENTS.md`。M3 实测：`memory/`（用户画像/偏好）存在并以 junction 与日常使用共享，大脑可读到真实记忆；`skills/agents/commands` 与 `AGENTS.md` 在 Qoder 1.1.78 不存在，当前是空操作，保留以便上游新增后自动生效。
- **并非「其它 agent 默认不继承」**：9 个内置预设里 **8 个**都配了 `inheritDirs`（只有 codex 例外——适配器不认沙箱配置目录，无从继承）。记忆机制差异靠**按 agent 配置**吸收：**单文件式记忆用 `inheritFiles`**（opencode 的 `AGENTS.md`、Claude Code 的 `CLAUDE.md`、gemini 的 `GEMINI.md`），**目录式用 `inheritDirs`**（kiro 的 `steering/memories/skills/...`、cline 的 `rules/skills/agents`、qoder 的 `memory/skills/agents/commands`）。接新 agent 时按它自己的目录布局填这两个字段即可，不需要改继承机制。
- **Claude Code 已预置**：`realHome=~/.claude`，`inheritDirs=skills,agents,commands`，`inheritFiles=CLAUDE.md`；`settings.json` / `plugins/` 不继承（插件可自带 MCP，且 settings 常含网关凭据）。
- 仅当目标 agent 用「配置目录 + 目录式记忆」模型时此继承才直接可用。

## 7. 平台注意（Windows）

- 默认 `shell: false` 直接 spawn 二进制。对 `.exe`（如 `kiro-cli.exe`）没问题。
- 若某 agent 在 Windows 上是 `.cmd` / `.bat` / 经 `npx` 启动（如 `claude-agent-acp.cmd`、`gemini.cmd`、`npx.cmd`），`shell: false` 直接 spawn 会失败。本项目已支持经 shell 启动：
  - agent 里设 `shell: true`（`claude-code`、`gemini` agent 已设）；或运行时设 `WEMIND_BRAIN_SHELL=1`。
  - 经 shell 启动时，二进制用「裸名」让 shell 从 PATH 解析（避免带空格的全路径在 shell 下出问题）。
  - 参数由我们自己逐条加引号拼成**一条命令串**再交给 shell（`spawn-agent.ts` 的 `spawnAgent`），**不传 `args` 数组**——Node 20+ 对「`shell:true` + args 数组」会报 DEP0190（args 只按空格拼接、不做转义），参数含空格会被拆开、含 `&`/`|` 等 cmd 元字符则会被 shell 自行解释。三处启动点（对话大脑 / 任务 worker / `brain check`）都走这个入口。
- 仍可用 `WEMIND_BRAIN_BIN` 指向真正的 `.exe` / node 入口绕开 shim（则无需 shell）。

---

## 8. 验证是否接入成功

1. 启动 daemon 后，在微信给 bot 发一条消息；
2. 看该账号日志 `~/.wemind/<key>/daemon.log`，应出现：

   ```
   [wemind/wechat-daemon/acp] spawn <name> acp pid=<pid> bin=<解析到的二进制> args=[<启动参数>]
   [wemind/wechat-daemon/acp] initialized
   [wemind/wechat-daemon/acp] → session/new#... 或 session/load#...
   [wemind/wechat-daemon/acp] → session/prompt#... (idle=... cap=...)
   [wemind/wechat-daemon/acp] prompt ok <耗时>ms chunks=<n> updateTypes=[...]
   [wemind/wechat-daemon] replied to <user>: <回复前若干字>
   ```

   - 没有 `spawn` 行 / 立刻 `acp exited` → 二进制或参数不对（检查 §2 第 1、2 项）；
   - 卡在 `initialize` 超时 → 该 agent 可能不是 ACP，或参数没真正进入 ACP server 模式（检查 §2 第 4 项）；
   - `prompt ok` 出现即表示一轮成功。

3. 也可不经微信、直接验证选择与连通性：

   ```powershell
   wemind brain          # 查看：解析到哪个 agent/二进制、来源、是否可用
   wemind brain check    # 真起一个 agent 进程跑 ACP 握手（initialize + session/new）
   ```

   想直接看解析对象（不走 CLI）：

   ```powershell
   npx tsx -e "import { resolveAgent } from './packages/wechat-daemon/src/brain-agents.ts'; console.log(resolveAgent())"
   ```

---

## 9. 适用范围与限制

- 本指南覆盖「**实现 ACP 的 agent CLI**」。这是接入成本最低的一档，但**不等于零适配**：先跑能力探针，再决定是否需要改 `acp-brain.ts` / `worker-acp.ts`。
- **能力差异清单**（接入前逐条确认）：
  - **会话恢复**：有 `session/load`？只有 `session/resume`？都没有？当前客户端会按配置里的 `restore` 选 `load`/`resume`；DSH 走 `resume`，其余 agent 先 `load`，失败再试 `resume`/`new`。会话映射按 agent 分开存（`brain-sessions.json` 键 `<agent>:<userId>`，`worker-sessions.json` 键 `<agent>:task-<编号>@<userId>`），切换大脑互不覆盖，切回原大脑仍能恢复；
  - **图片**：探针看 `initialize.promptCapabilities.image` 是否为 true？false 时带图 `session/prompt` 会报 `-32602`。**结论要写进预设的 `images` 字段**——WeMind 运行时不读这个回包（见 §4 与 [AGENTS.md §4.2](../../AGENTS.md)），不写就等于默认支持；
  - **MCP**：走 agent 配置文件，还是 ACP `session/new` 的 `mcpServers`？支持 stdio/HTTP 哪些传输？
  - **反向请求**：是否会发 `session/request_permission` / `fs/*` / `terminal/*`？brain、worker、`brain check` 三处共用 `acp-reverse.ts` 的应答器（唯一实现）：权限请求默认拒绝（`WEMIND_ACP_AUTO_ALLOW=1` 才逐次放行），未知 method 回 `-32601`，不会挂起；
  - **进度**：是否逐 token 发 `agent_message_chunk`？committed-only 时 15s 心跳会烧连发额度；
  - **Windows**：二进制是 `.exe` 还是 `.cmd`/`npx`？后者必须 `shell:true`，`binWin` 要写实际文件名。
- **不支持 ACP 的对象**（如直接调 OpenAI / Anthropic / Ollama 等 LLM HTTP API）走不了本路，需要「第二档：API 适配器」。**注意：仓库当前没有 `Brain` 接口抽象；当前建议先不抽**——ACP 是唯一实现，先不抽接口避免增加间接层；等 API 适配器真正立项时，再抽 `askBrain`/`newSession`/`restart` 契约并改 `index.ts` 调用方，然后写 HTTP 实现（自行维护多轮历史与工具循环）。纯对话容易，复刻 kiro 那样的「会用工具的 agent」相当于自造迷你 agent。该档尚未实现。
- 另：**MCP 服务模式**（`@wemind/wechat-mcp`）与本文无关且本就 agent 无关——任何支持 MCP 的客户端（Claude Desktop、Cursor、kiro IDE 等）都能直接驱动 WeMind 收发微信，不需要 daemon 这套大脑。

---

## 10. 速查

```text
选择大脑（推荐，写入磁盘持久）：
  wemind brain set <agent 名|auto> [--bin X] [--args "…"] [--shell|--no-shell] [--model X|auto] [--restart]   # 写入 <数据目录>/brain.json
  wemind brain / wemind brain check                                 # 查看 / 真机自检
  （未配置时默认 auto：按 opencode → cline → qoder → gemini → deepseek → kiro 探测已安装者）

一次性覆盖（仅本次启动的进程）：
  WEMIND_BRAIN_BIN=<二进制>
  WEMIND_BRAIN_ARGS=<进入 ACP 的参数，空格分隔>
  WEMIND_BRAIN_HOME_ENV=<配置目录环境变量名，没有则不设>

长期接入（加 agent）：
  在 brain-agents.ts 的 ACP_AGENT_PRESETS 加一条 → npm run build → wemind brain set <键>

验证：
  看 daemon.log 的 [wemind/wechat-daemon/acp] spawn / prompt ok；或 wemind brain check
  接入前先跑：node scripts/acp-probe.mjs（记录 initialize、首帧、update、load/resume、反向请求）
  注意：brain check 默认 60s，冷启动慢的 agent 仍可能误报
```


---

## 11. 附录：ACP 生态可接入 agent 清单（参考）

> **这不是 WeMind 的支持清单。** 下面只说明「上游有哪些 agent 实现了 ACP（或提供 ACP 适配器）」；WeMind **内置**的只有 §5 的 9 个（均已至少探针级实测：kiro/opencode/deepseek/qoder/cline/claude-code/codex/gemini/pi）。未内置的 agent 需要你按 §2–§5 自行配置、按 §8 验证——文档列出 ≠ 已适配。
>
> 来源：ACP 官方站 `agentclientprotocol.com/get-started/agents`（截至 2026 年；生态在扩大，以官方为准）。
> ACP 通用介绍见知识库笔记《ACP（Agent Client Protocol）详解》。

**原生支持 ACP（可直接配 agent/环境变量接入，理论可当 WeMind 大脑/工作机）**：
- 已内置：Kiro CLI（✅ 已实测）、OpenCode（✅ 已实测）、DeepSeek Harness（✅ 已实测）、Qoder CLI（✅ 已实测）、Cline CLI（✅ 已实测）、Gemini CLI（✅ 探针级实测 + 真机 E2E，0.66.0）。
- 未内置（示例/评估）：Goose、OpenHands、Cursor、GitHub Copilot（公开预览）、Junie（JetBrains）、Kimi CLI、Hermes Agent、Docker cagent、fast-agent、Augment Code、Factory Droid、AgentPool、AutoDev、Blackbox AI、Code Assistant、crow-cli、Minion Code、Mistral Vibe、fount、OpenClaw…

**需经适配器（CLI 本身不原生实现 ACP，需先起桥接进程）**：
- 已内置：Claude Code → `@agentclientprotocol/claude-agent-acp`（**全局安装**，旧包 `@zed-industries/claude-code-acp` 已弃用；探针级 + 真机微信单轮 E2E）；Codex CLI → `@agentclientprotocol/codex-acp`（官方维护，**全局安装**，探针级 + 真机 E2E）；Pi → `pi-acp`（社区维护，**全局安装**，另需 `@earendil-works/pi-coding-agent` 本体；探针级实测 + 真机 E2E（2026-11-01））。
- 未内置：Bub → `bub-acp-server`…

> 接入任一 agent 的通用步骤见本文 §2–§5；带「适配器」的先 `npm i -g <适配器包>`（npx 只作兜底），再把 `WEMIND_BRAIN_BIN/ARGS` 指向适配器启动命令。除 §5 里已实测的内置预设（kiro / opencode / deepseek / qoder / cline，加上 gemini：探针级 + 真机 E2E（0.66.0，2026-11-01）、claude-code：探针级 + 真机微信单轮 E2E、codex：探针级 + 真机 E2E、pi：探针级 + 真机 E2E）外，均建议先实测。
>
> 远程 ACP（HTTP/WebSocket）官方仍在完善——成熟后可把工作机部署到独立/更强机器（见《方案C-受控ACP工作机设计》）。
