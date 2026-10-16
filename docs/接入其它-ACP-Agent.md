# 接入其它 AI Agent（ACP 配置指南）

本文说明如何把 WeMind 守护进程（daemon）的「大脑」从默认的 `kiro-cli` 换成**任意兼容 ACP 的 agent**，无需改动代码，仅靠环境变量或新增一条预设即可。

---

## 1. 工作原理

WeMind 的 daemon 把一个 agent CLI 当作常驻「大脑」，通过 **ACP（Agent Client Protocol）** 与它对话。ACP 是一个**通用协议**——JSON-RPC 2.0 over stdio（每行一个 JSON 消息），由 Zed 提出，kiro-cli、Gemini CLI 等多家 agent CLI 都已支持。

daemon 只用到 ACP 的标准方法，与具体是哪个 agent 无关：

- `initialize` —— 握手；
- `session/new` —— 新建会话；
- `session/load` —— 按 sessionId 恢复会话（自愈重建后用它找回多轮上下文）；
- `session/prompt` —— 发一轮提问；
- `session/update`（通知）—— 流式回包：`agent_message_chunk`（正文）、`tool_call`/`tool_call_update`（工具进度）等。

因此「接入一个新 agent」本质上只需要告诉 WeMind **怎么把它以 ACP 模式启动起来**，协议层完全复用。

相关代码：

- `packages/wechat-daemon/src/brain-agents.ts` —— 预设表与解析逻辑（本文主角）；
- `packages/wechat-daemon/src/acp-brain.ts` —— ACP 客户端（协议层，通用，一般不用改）。

---

## 2. 接入一个 agent 需要确认的 4 件事

| # | 信息 | 说明 | kiro 的取值 |
|---|------|------|------------|
| 1 | **二进制名/路径** | 可执行文件名（在 PATH 上）或绝对路径 | `kiro-cli`（Win：`kiro-cli.exe`） |
| 2 | **ACP 启动参数** | 让该 CLI 进入「ACP server over stdio」模式的命令行参数 | `acp --trust-all-tools` |
| 3 | **配置目录环境变量名** | 该 agent 读取其配置/数据目录的环境变量名；WeMind 会把它指向 brain 沙箱目录，用于隔离与可选的 MCP 注入。没有就留空 | `KIRO_HOME` |
| 4 | **ACP 兼容性** | 该 CLI 是否真的实现了 ACP（上面那几个方法） | 是 |

> 第 1、2 项几乎所有 agent 都有；第 3 项各家差异较大（见 §6 MCP 沙箱）；第 4 项是前提——不支持 ACP 的 agent 走不了这条路，得用「第二档：裸 LLM API 适配器」（尚未实现）。

---

## 3. 配置方式 A：环境变量（零代码，最快）

给 daemon 进程设这些环境变量即可，优先级高于预设默认值：

| 环境变量 | 作用 | 默认 |
|------|------|------|
| `WEMIND_BRAIN` | 选用哪个预设（见 §5），如 `kiro` / `gemini` | `kiro` |
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
二进制：WEMIND_BRAIN_BIN  >  (kiro 预设时) KIRO_CLI_BIN  >  PATH 查找  >  预设裸名
参数：  WEMIND_BRAIN_ARGS（空格切分）  >  预设 args
目录变量：WEMIND_BRAIN_HOME_ENV  >  预设 homeEnvVar
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

然后构建并用 `WEMIND_BRAIN=acme` 选用：

```powershell
npm run build
$env:WEMIND_BRAIN = "acme"   # 启动 daemon
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
| `kiro` | kiro-cli | 原生 | ✅ **已实测**（默认） | `kiro-cli acp --trust-all-tools`，`KIRO_HOME` |
| `opencode` | OpenCode | 原生 | ✅ **已实测** | `opencode acp`，`XDG_CONFIG_HOME`（详见 [接入-OpenCode.md](接入-OpenCode.md)） |
| `gemini` | Gemini CLI | 原生 | ⚠️ 未实测 | `gemini --experimental-acp`，`GEMINI_CLI_HOME`（flag 以官方为准） |
| `claude-code` | Claude Code | 需适配器 | ⚠️ 未实测 | `npx -y @zed-industries/claude-code-acp`（Zed 官方适配器；需 Claude Code 登录或 `ANTHROPIC_API_KEY`） |
| `codex` | OpenAI Codex | 需适配器 | ⚠️ 未实测 | `codex-acp`（社区适配器 [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)，需自行安装其二进制；Codex 本身暂不原生支持 ACP） |

> ⚠️ 除 `kiro` 外均为**示例预设**：包名、参数、二进制可能随上游变化，**接入前务必对照各自官方/仓库核对**，必要时改 `ACP_AGENT_PRESETS` 里的对应条目或用环境变量覆盖。

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

因此：**kiro 与 opencode 现已开箱支持「微信里动态加载/卸载 MCP」**。其它 agent 若格式不同，则是上述预设字段填对即可；实在不同再按其约定适配。

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
- 仍可用 `WEMIND_BRAIN_BIN` 指向真正的 `.exe` / node 入口绕开 shim（则无需 shell）。

---

## 8. 验证是否接入成功

1. 启动 daemon 后，在微信给 bot 发一条消息；
2. 看该账号日志 `~/.wemind/<key>/daemon.log`，应出现：

   ```
   [acp] spawn <name> acp pid=<pid> bin=<解析到的二进制> args=[<启动参数>]
   [acp] initialized
   [acp] → session/new#... 或 session/load#...
   [acp] → session/prompt#... (idle=... cap=...)
   [acp] prompt ok <耗时>ms chunks=<n> updateTypes=[...]
   [daemon] replied to <user>: <回复前若干字>
   ```

   - 没有 `spawn` 行 / 立刻 `acp exited` → 二进制或参数不对（检查 §2 第 1、2 项）；
   - 卡在 `initialize` 超时 → 该 agent 可能不是 ACP，或参数没真正进入 ACP server 模式（检查 §2 第 4 项）；
   - `prompt ok` 出现即表示一轮成功。

3. 也可不经微信、直接验证解析结果：

   ```powershell
   npx tsx -e "import { resolveAgent } from './packages/wechat-daemon/src/brain-agents.ts'; console.log(resolveAgent())"
   ```

---

## 9. 适用范围与限制

- 本指南覆盖「**任意兼容 ACP 的 agent CLI**」。这是接入成本最低的一档——配置即用。
- **不支持 ACP 的对象**（如直接调 OpenAI / Anthropic / Ollama 等 LLM HTTP API）走不了本路，需要「第二档：API 适配器」——为 `Brain` 接口（`askBrain`/`newSession`/`restart`）另写一个基于 HTTP 的实现，并自行维护多轮对话历史、（如需）工具调用循环。纯对话容易，要复刻 kiro 那样的「会用工具的 agent」则相当于自造一个迷你 agent。该档尚未实现。
- 另：**MCP 服务模式**（`@wemind/wechat-mcp`）与本文无关且本就 agent 无关——任何支持 MCP 的客户端（Claude Desktop、Cursor、kiro IDE 等）都能直接驱动 WeMind 收发微信，不需要 daemon 这套大脑。

---

## 10. 速查

```text
最快接入（环境变量）：
  WEMIND_BRAIN_BIN=<二进制>
  WEMIND_BRAIN_ARGS=<进入 ACP 的参数，空格分隔>
  WEMIND_BRAIN_HOME_ENV=<配置目录环境变量名，没有则不设>

长期接入（加预设）：
  在 brain-agents.ts 的 ACP_AGENT_PRESETS 加一条 → npm run build → WEMIND_BRAIN=<键>

验证：
  看 daemon.log 的 [acp] spawn / prompt ok；或 node 跑 resolveAgent()
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
