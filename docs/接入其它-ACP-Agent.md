# 接入其它 AI Agent（ACP 配置指南）

> **适用版本**：WeMind 1.0.1 ｜ **最后核对**：2026-10-24 ｜ **状态**：kiro/opencode 已实测；其它预设为示例，接入前按 §8 验证。
>
> 本文说明如何把 WeMind 守护进程（daemon）的「大脑」从默认的 `auto`（优先 kiro）换成另一个 ACP agent。**多数原生 ACP agent 可以零代码接入；但 ACP 不是完全统一的能力集**——缺 `session/load`、会发反向请求、没有 activity 帧或图片能力不同，都需要协议层适配（见 §9）。

---

## 1. 工作原理

WeMind 的 daemon 把一个 agent CLI 当作常驻「大脑」，通过 **ACP（Agent Client Protocol）** 与它对话。ACP 是一个**通用协议**——JSON-RPC 2.0 over stdio（每行一个 JSON 消息），由 Zed 提出，kiro-cli、Gemini CLI 等多家 agent CLI 都已支持。

daemon 使用 ACP 的一个**最小方法集**，但不同 agent 的可用能力不同：

- `initialize` —— 握手；返回 `agentCapabilities`（是否支持 load/resume、image、MCP）；
- `session/new` —— 新建会话；
- `session/load` —— 按 sessionId 恢复会话（**不是所有 agent 都实现**）；
- `session/resume` —— 部分 agent（如 DSH）用它恢复持久会话；
- `session/prompt` —— 发一轮提问；
- `session/update`（通知）—— 流式回包：`agent_message_chunk`（正文）、`tool_call`/`tool_call_update`（工具进度）等；
- `session/request_permission`（反向请求）—— agent 请求权限；不应答会挂起。

因此「接入一个新 agent」主要是告诉 WeMind **怎么把它以 ACP 模式启动起来**；协议层能复用，但**能力差异要按 agent 补**（见 §9）。

相关代码：

- `packages/wechat-daemon/src/brain-agents.ts` —— 预设表与解析逻辑（本文主角）；
- `packages/wechat-daemon/src/acp-brain.ts` —— ACP 客户端（协议层；缺 load/反向请求时需要改）；
- `packages/wechat-daemon/src/worker-acp.ts` —— worker 的 ACP 客户端（与 brain 是两份实现，改动要同步）。

---

## 2. 接入一个 agent 需要确认的 4 件事

| # | 信息 | 说明 | kiro 的取值 |
|---|------|------|------------|
| 1 | **二进制名/路径** | 可执行文件名（在 PATH 上）或绝对路径 | `kiro-cli`（Win：`kiro-cli.exe`） |
| 2 | **ACP 启动参数** | 让该 CLI 进入「ACP server over stdio」模式的命令行参数 | `acp --trust-all-tools` |
| 3 | **配置目录环境变量名** | 该 agent 读取其配置/数据目录的环境变量名；WeMind 会把它指向 brain 沙箱目录，用于隔离与可选的 MCP 注入。没有就留空 | `KIRO_HOME` |
| 4 | **ACP 兼容性** | 该 CLI 是否实现了 ACP 的最小方法集；**还要看** `initialize.agentCapabilities` 的 `load/resume/image/mcp` 与是否会发反向请求 | 是 |

> 第 1、2 项几乎所有 agent 都有；第 3 项各家差异较大（见 §6 MCP 沙箱）；第 4 项是前提——不支持 ACP 的 agent 走不了这条路，得用「第二档：裸 LLM API 适配器」（尚未实现，见 §9）。
>
> **不要只看「支持 ACP」四个字**：`session/load`、图片、MCP 传输、权限请求都可能不同。接入前先跑 [`scripts/acp-probe.mjs`](../scripts/acp-probe.mjs)，把 `initialize` 能力与一次 prompt 的 `session/update` 类型记录下来。

---

## 3. 配置方式 A：选大脑（推荐落盘持久；环境变量为一次性覆盖）

**选择存在「账号级配置文件」里**（`<数据目录>/brain.json`），任何入口重启都能复现；`wemind brain` 是切换它的正门：

| 命令 | 作用 |
|------|------|
| `wemind brain [<key\|label>]` | 查看：配置、生效值、来源、二进制是否可用 |
| `wemind brain set <预设\|auto> [--bin X] [--args "…"] [--shell\|--no-shell] [--restart] [<key\|label>]` | 写入 brain.json（`--restart` 顺带重启 daemon 立即生效） |
| `wemind brain unset [<key\|label>]` | 删除 brain.json，回退到自动探测/默认 |
| `wemind brain check [<key\|label>]` | 真起一个进程跑 ACP 握手（`initialize` + `session/new`），验证「不仅找得到、而且能说 ACP」 |

```powershell
wemind brain set opencode --restart    # 切到 OpenCode 并立即重启 daemon
wemind brain                            # 查看当前大脑
wemind brain check                      # 真机自检（真实 ACP 握手）
```

`brain.json` 形如（`bin` / `args` / `shell` / `homeEnvVar` 可选，用于**覆盖该预设**的启动细节）：

```json
{ "agent": "opencode" }
```

> `--bin` / `--args` 只覆盖**已知预设**的启动细节（例如把 `opencode` 预设指向绝对路径的 `opencode.exe`）。
> 全新 agent 请先按 §4 加一条预设——预设携带沙箱/MCP 约定，光有二进制不足以接进来。

### 3.1 选择优先级（`resolveAgent()`）

```
预设：  WEMIND_BRAIN(env)  >  brain.json 的 agent  >  auto（自动探测）
```

- **`auto`（未配置时的默认）**：按 `kiro → opencode → gemini → deepseek` 取第一个**二进制在 PATH 上可解析**的预设；适配器类（`claude-code`/`codex`）不参与（`npx` 几乎总存在，会误选）。
- 一个都没装 → daemon **启动即失败并说人话**（不再「跑起来、第一条消息才炸」），提示安装或 `wemind brain set`。

### 3.2 环境变量（一次性覆盖，优先级最高）

临时试别的 agent 用它；**别写进 profile**——那等于把隐式默认换成另一个值固定死，换个入口重启仍会漂移。给 daemon 进程设这些变量，优先级高于 brain.json 与预设默认值：

| 环境变量 | 作用 | 默认 |
|------|------|------|
| `WEMIND_BRAIN` | 选用哪个预设（见 §5），如 `kiro` / `opencode` / `auto` | `auto`（自动探测） |
| `WEMIND_BRAIN_BIN` | 覆盖二进制（绝对路径或 PATH 上的名字） | 预设自动在 PATH 解析 |
| `WEMIND_BRAIN_ARGS` | 覆盖 ACP 启动参数（**空格分隔**） | 预设值 |
| `WEMIND_BRAIN_HOME_ENV` | 覆盖「配置目录环境变量名」（指向 brain 沙箱） | 预设值 |
| `WEMIND_BRAIN_SHELL` | 是否经 shell 启动（`1`/`true` 开）；npx/`.cmd`/`.bat` 类适配器在 Windows 需要 | 预设值（默认 false） |
| `WEMIND_BRAIN_INHERIT` | 是否继承真实配置目录的记忆/规则/技能（见 §6.5） | `1`（开） |
| `WEMIND_BRAIN_REAL_HOME` | 覆盖被继承的真实配置目录 | 预设 `realHome` |
| `WEMIND_BRAIN_INHERIT_DIRS` | 覆盖继承的子目录清单（逗号/空格分隔） | 预设 `inheritDirs` |
| `WEMIND_MCP_CATALOG` | 覆盖可选 MCP 的来源 mcp.json 路径 | `<realHome>/settings/mcp.json` |
| `KIRO_CLI_BIN` | 旧的 kiro 专用二进制覆盖（仅 `kiro` 预设、且未设 `WEMIND_BRAIN_BIN` 时生效） | — |

解析优先级（`resolveAgent()`）：

```
二进制：WEMIND_BRAIN_BIN  >  (kiro 预设时) KIRO_CLI_BIN  >  brain.json 的 bin  >  PATH 查找  >  预设裸名
参数：  WEMIND_BRAIN_ARGS（空格切分）  >  brain.json 的 args  >  预设 args
目录变量：WEMIND_BRAIN_HOME_ENV  >  brain.json 的 homeEnvVar  >  预设 homeEnvVar
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

## 4. 配置方式 B：新增一条预设（推荐长期使用）

在 `packages/wechat-daemon/src/brain-agents.ts` 的 `ACP_AGENT_PRESETS` 里加一条：

```ts
export const ACP_AGENT_PRESETS: Record<string, AcpAgentPreset> = {
  kiro: { name: "kiro", bin: "kiro-cli", binWin: "kiro-cli.exe", args: ["acp", "--trust-all-tools"], homeEnvVar: "KIRO_HOME" },

  // 新增：
  acme: {
    name: "acme",
    bin: "acme-agent",          // 非 Windows 的可执行名
    binWin: "acme-agent.exe",   // Windows 可执行名（默认在 bin 后加 .exe）
    args: ["serve", "--acp"],   // 进入 ACP 模式的参数
    homeEnvVar: "ACME_HOME",    // 没有就删掉这行
  },
};
```

然后构建并选用（推荐落盘持久）：

```powershell
npm run build
wemind brain set acme --restart          # 写入 brain.json 并重启 daemon
# 或一次性覆盖（仅对本次启动的 daemon 生效）：$env:WEMIND_BRAIN = "acme"
```

`AcpAgentPreset` 字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | 预设名（也用于日志） |
| `bin` | 是 | 非 Windows 可执行名 |
| `binWin` | 否 | Windows 可执行名，缺省为 `bin + ".exe"`（经 shell 启动时可用裸名让 shell 解析） |
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
| `env` | 否 | 额外注入的环境变量（值里 `%HOME%` → 沙箱根），如 opencode 的 `OPENCODE_DISABLE_PROJECT_CONFIG` |

---

## 5. 内置预设

ACP agent 分两类，接入方式不同：

- **原生 ACP**：CLI 自带 ACP 模式，加个参数直接起（如 kiro、Gemini）。
- **需适配器**：CLI 本身不说 ACP，要起一个**第三方适配器进程**来桥接（如 Claude Code、Codex）。适配器一般有自己的认证（API key / 登录），且不读 WeMind 的 `KIRO_HOME` 沙箱（故无 `homeEnvVar`、动态 MCP 注入不适用，见 §6）。

| 预设键 | agent | 类型 | 状态 | 启动（示意） |
|--------|-------|------|------|------|
| `kiro` | kiro-cli | 原生 | ✅ **已实测** | `kiro-cli acp --trust-all-tools`，`KIRO_HOME` |
| `opencode` | OpenCode | 原生 | ✅ **已实测** | `opencode acp`，`XDG_CONFIG_HOME`（详见 [接入-OpenCode.md](接入-OpenCode.md)） |
| `deepseek` | DeepSeek Harness `dsh` | 原生（官方 ACP profile） | ✅ **已内置/已实测**：prompt / 工具 / resume 上下文 / stdio MCP；`load` ❌、`image:false`（收图友好拒绝） | `dsh --profile acp`，`DSH_HOME`；建议 `--bin` 绝对路径（详见 [接入-DeepSeek.md](接入-DeepSeek.md)） |
| `gemini` | Gemini CLI | 原生 | ⚠️ 未实测 | `gemini --experimental-acp`，`GEMINI_CLI_HOME`（flag 以官方为准） |
| `claude-code` | Claude Code | 需适配器 | ⚠️ 未实测 | `npx -y @zed-industries/claude-code-acp`（Zed 官方适配器；需 Claude Code 登录或 `ANTHROPIC_API_KEY`） |
| `codex` | OpenAI Codex | 需适配器 | ⚠️ 未实测 | `codex-acp`（社区适配器 [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)，需自行安装其二进制；Codex 本身暂不原生支持 ACP） |

> ⚠️ 除 `kiro`、`opencode` 外均为**示例/评估**：包名、参数、二进制、ACP 能力可能随上游变化，**接入前务必对照各自官方/仓库核对**，并跑 §8 的验证。DeepSeek 的 M0 已实测（prompt/resume/工具/MCP；见其文档），但**没有内置预设**，需先补 M1/M2。

**适配器类的准备工作（示例）**：

- **Claude Code**：预设用 `npx -y @zed-industries/claude-code-acp`（`shell:true`，因 Windows 上是 `npx.cmd`）。需先装好 Claude Code 并完成认证（登录或设 `ANTHROPIC_API_KEY`）。该适配器把 Claude Code 暴露成 ACP server over stdio。
- **Codex**：需先安装社区适配器 `codex-acp`（见其仓库说明，多为 Rust 构建出的二进制），把它放到 PATH（或用 `WEMIND_BRAIN_BIN` 指向）。Codex 官方原生 ACP 仍在推进中（openai/codex#2785）。

---

## 6. MCP 沙箱（重要差异点）

WeMind 让大脑跑在一个独立沙箱目录（`BRAIN_HOME`，由 `WECHAT_BRAIN_HOME` 决定），目的是：

1. **隔离**——大脑用的配置/会话与你本机日常用的该 agent 分开；
2. **可选 MCP 注入**——通过微信指令 `加载/卸载 <MCP>` 动态改沙箱里的 MCP 配置，重启 agent 生效；
3. **杜绝回环**——默认不加载 `wechat` 自身 MCP。

实现方式是：把 `homeEnvVar`（kiro 是 `KIRO_HOME`）指向沙箱目录，并在该目录放一个 **kiro 格式的 `mcp.json`**。

**注意**：这套「沙箱 + MCP 配置」现在**按 agent 分派**（预设字段驱动，见 `brain-agents.ts`）：

- `homeEnvVar` 决定把哪个环境变量指向沙箱（kiro 用 `KIRO_HOME`；opencode 用 `XDG_CONFIG_HOME`——后者能**替换**默认 global 目录，实现真正隔离）；
- `configSubdir` 决定 agent 配置目录相对沙箱根的位置（kiro 空=沙箱根；opencode `opencode`）；
- `mcpFormat` / `mcpConfigFile` / `catalogFile` 决定 MCP 文件的结构与路径（kiro：`settings/mcp.json` 的 `mcpServers`；opencode：`opencode.json` 的 `mcp.servers`）。

因此：**kiro 与 opencode 现已开箱支持「微信里动态加载/卸载 MCP」**；**DSH 走 `mcpViaAcp: true`**——不写配置文件，激活集由 `toAcpMcpServers()` 转成 ACP 声明随 `session/new|resume` 下发（已真机验证）。其它 agent 若格式不同，则是上述预设字段填对即可；实在不同再按其约定适配。

- 若该 agent 也用「某个 HOME 环境变量 + 兼容结构」，设对 `homeEnvVar` 即可，MCP 注入大概率可用；
- 该 agent 完全不需要配置目录时，把 `homeEnvVar` 留空，仅做隔离 cwd。

> 简言之：**对话/工具是通用的；「动态 MCP 注入」依赖该 agent 的配置约定，跨 agent 不保证开箱即用。**

---

## 6.5 继承记忆 / 规则 / 技能（按 agent 配置）

为了让微信里的大脑和你日常使用同一 agent 时读到**同样的记忆、规则、技能**，沙箱会把该 agent 真实配置目录里的「知识/记忆」类子目录用 junction 链进 brain 沙箱（`settings`、`sessions` 除外——前者 MCP 必须隔离防回环，后者是 brain 自有会话）。

这一项**按 agent 配置驱动**（不同 agent 目录布局/记忆机制不同）：

| 预设字段 / 环境变量 | 含义 |
|---|---|
| 预设 `realHome` / `WEMIND_BRAIN_REAL_HOME` | 被继承的真实配置目录 |
| 预设 `inheritDirs` / `WEMIND_BRAIN_INHERIT_DIRS`（逗号/空格分隔） | 从 `realHome` 继承的子目录清单 |
| `WEMIND_BRAIN_INHERIT=0` | 关闭继承 |

- **kiro 已预置**：`realHome=~/.kiro`，`inheritDirs=steering,memories,skills,agents,powers,tasks,extensions`。
- **其它 agent 默认不继承**：因为记忆机制差异大——例如 Gemini CLI / Claude Code 的「记忆」是**单个文件**（`GEMINI.md` / `CLAUDE.md`）而非目录，本机制（按目录 junction）不适用；需要时给预设填 `realHome`/`inheritDirs`，或用上面的环境变量。**单文件式记忆需另行处理**（本机制只链目录）。
- 仅当目标 agent 用「配置目录 + 目录式记忆」模型时此继承才直接可用。

## 7. 平台注意（Windows）

- 默认 `shell: false` 直接 spawn 二进制。对 `.exe`（如 `kiro-cli.exe`）没问题。
- 若某 agent 在 Windows 上是 `.cmd` / `.bat` / 经 `npx` 启动（如 `npx.cmd`、`gemini.cmd`、Claude Code 适配器），`shell: false` 直接 spawn 会失败。本项目已支持经 shell 启动：
  - 预设里设 `shell: true`（`claude-code`、`gemini` 预设已设）；或运行时设 `WEMIND_BRAIN_SHELL=1`。
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
   wemind brain          # 查看：解析到哪个预设/二进制、来源、是否可用
   wemind brain check    # 真起一个 agent 进程跑 ACP 握手（initialize + session/new）
   ```

   想直接看解析对象（不走 CLI）：

   ```powershell
   npx tsx -e "import { resolveAgent } from './packages/wechat-daemon/src/brain-agents.ts'; console.log(resolveAgent())"
   ```

---

## 9. 适用范围与限制

- 本指南覆盖「**能说 ACP 的 agent CLI**」。这是接入成本最低的一档，但**不等于零适配**：先跑能力探针，再决定是否需要改 `acp-brain.ts` / `worker-acp.ts`。
- **能力差异清单**（接入前逐条确认）：
  - **会话恢复**：有 `session/load`？只有 `session/resume`？都没有？当前客户端会按预设 `restore` 选 `load`/`resume`；DSH 走 `resume`，其余 agent 先 `load`，失败再试 `resume`/`new`；
  - **图片**：`initialize.promptCapabilities.image` 是否为 true？false 时带图 `session/prompt` 会报 `-32602`；
  - **MCP**：走 agent 配置文件，还是 ACP `session/new` 的 `mcpServers`？支持 stdio/HTTP 哪些传输？
  - **反向请求**：是否会发 `session/request_permission` / `fs/*` / `terminal/*`？当前 `handleFrame` 不应答，遇到会挂起；
  - **进度**：是否逐 token 发 `agent_message_chunk`？committed-only 时 15s 心跳会烧连发额度；
  - **Windows**：二进制是 `.exe` 还是 `.cmd`/`npx`？后者必须 `shell:true`，`binWin` 要写实际文件名。
- **不支持 ACP 的对象**（如直接调 OpenAI / Anthropic / Ollama 等 LLM HTTP API）走不了本路，需要「第二档：API 适配器」。**注意：仓库当前没有 `Brain` 接口抽象；当前建议先不抽**——ACP 是唯一实现，先不抽接口避免增加间接层；等 API 适配器真正立项时，再抽 `askBrain`/`newSession`/`restart` 契约并改 `index.ts` 调用方，然后写 HTTP 实现（自行维护多轮历史与工具循环）。纯对话容易，复刻 kiro 那样的「会用工具的 agent」相当于自造迷你 agent。该档尚未实现。
- 另：**MCP 服务模式**（`@wemind/wechat-mcp`）与本文无关且本就 agent 无关——任何支持 MCP 的客户端（Claude Desktop、Cursor、kiro IDE 等）都能直接驱动 WeMind 收发微信，不需要 daemon 这套大脑。

---

## 10. 速查

```text
选择大脑（推荐，落盘持久）：
  wemind brain set <预设|auto> [--bin X] [--args "…"] [--restart]   # 写入 <数据目录>/brain.json
  wemind brain / wemind brain check                                 # 查看 / 真机自检
  （未配置时默认 auto：按 kiro → opencode → gemini → deepseek 探测已安装者）

一次性覆盖（仅本次启动的进程）：
  WEMIND_BRAIN_BIN=<二进制>
  WEMIND_BRAIN_ARGS=<进入 ACP 的参数，空格分隔>
  WEMIND_BRAIN_HOME_ENV=<配置目录环境变量名，没有则不设>

长期接入（加预设）：
  在 brain-agents.ts 的 ACP_AGENT_PRESETS 加一条 → npm run build → wemind brain set <键>

验证：
  看 daemon.log 的 [wemind/wechat-daemon/acp] spawn / prompt ok；或 wemind brain check
  接入前先跑：node scripts/acp-probe.mjs（记录 initialize、首帧、update、load/resume、反向请求）
  注意：brain check 默认 60s，冷启动慢的 agent 仍可能误报
```


---

## 11. 附录：ACP 生态可接入 agent 清单（参考）

> 来源：ACP 官方站 `agentclientprotocol.com/get-started/agents`（截至 2026 年；生态在扩大，以官方为准）。
> ACP 通用介绍见知识库笔记《ACP（Agent Client Protocol）详解》。

**原生支持 ACP（可直接配预设/环境变量接入，理论可当 WeMind 大脑/工作机）**：
- Kiro CLI（✅ 已实测，默认）、Gemini CLI、Goose、OpenCode、OpenHands、Cline、Cursor、GitHub Copilot（公开预览）、Junie（JetBrains）、Kimi CLI、Hermes Agent、Docker cagent、fast-agent、Augment Code、Factory Droid、AgentPool、AutoDev、Blackbox AI、Code Assistant、crow-cli、Minion Code、Mistral Vibe、fount、OpenClaw…

**需经适配器（CLI 本身不原生说 ACP，需先起桥接进程）**：
- Claude Code → `@zed-industries/claude-code-acp`（npx）；
- Codex CLI → `codex-acp`（社区适配器）；
- Bub → `bub-acp-server`；Pi → `pi-acp`…

> 接入任一 agent 的通用步骤见本文 §2–§5；带"适配器"的把 `WEMIND_BRAIN_BIN/ARGS` 指向适配器启动命令（如 `npx -y @zed-industries/claude-code-acp`）。除 kiro 外均建议先实测。
>
> 远程 ACP（HTTP/WebSocket）官方仍在完善——成熟后可把工作机部署到独立/更强机器（见《方案C-受控ACP工作机设计》）。
