# 接入 OpenCode（设计与实测）

> **状态**：M1–M4 全部落地 ✅ —— `opencode` 是内置预设（见 §3.6）。**brain 通道的真机 E2E 已在 2026-10-29 通过**（微信发消息 → opencode acp → 自动回复，记录见 [CHANGELOG](../发布与变更记录/CHANGELOG.md)），M4 行与此一致。
> **实测范围**：OpenCode v2.0.29（M1 探针）；2026-10-29 在 2.0.32 上复测 `session/delete`、`load` 回放与并行任务（见 [run-e2e §7.3](../ai/recipes/run-e2e.md)）｜ **最后核对**：2026-11-05
> **实测环境**：Windows 11 / Node ≥20 / OpenCode v2.0.29。本文结论基于该版本；其它 agent 的能力（load/image/MCP）可能不同。
> **相关文档**：[接入其它-ACP-Agent.md](接入其它-ACP-Agent.md)（ACP 换大脑通用指南）· [repowiki/06-ACP-大脑与沙箱](../repowiki/06-ACP-大脑与沙箱.md)。

---

## 0. TL;DR

- WeMind 有**两种接入形态**：① `@wemind/wechat-mcp`（OpenCode 当 MCP 客户端消费微信工具）；② daemon（OpenCode 当**常驻 ACP 大脑**）。
- 本文重点做 **形态②**：用 `wemind brain set opencode`（或一次性 `WEMIND_BRAIN=opencode`）把 daemon 的大脑换成 `opencode acp`。
- **M1 已实测**：`initialize` / `session/new` / `session/prompt` / `session/load`（自愈）/ 工具调用全部可用，且 **OpenCode 全程不向客户端发反向请求**（无 `fs/*`、无 `session/request_permission`）——协议层（`acp-connection.ts`）**不需要改动**（帧/超时/模型与模式已统一到该模块，brain 与 worker 共用）。
- 剩余工作量集中在 **agent + 沙箱**：OpenCode 的配置目录环境变量、配置文件名与 **MCP 配置格式**都与 kiro 不同，需要按 agent 适配。
- 预计 M2（agent + brain 沙箱）为主工作量；M3（记忆继承 + worker）顺势复用。

---

## 1. 背景：WeMind 的两种接入形态

| | 形态①·MCP Server | 形态②·daemon |
|---|---|---|
| 谁长轮询 | MCP 客户端（OpenCode）自己 | daemon 自己 |
| 谁生成回复 | 客户端 agent | daemon 调常驻 ACP 大脑 |
| OpenCode 角色 | **MCP 客户端**（把微信当工具集） | **ACP agent**（当大脑） |
| 协议 | MCP（stdio） | ACP（JSON-RPC over stdio） |
| 改动量 | 配置级 | agent + 沙箱适配 |

两者可独立使用；**同一 bot token 不要同时跑形态①与形态②**（会抢消息，回环）。

---

## 2. 形态①：OpenCode 作为 MCP 客户端

在 OpenCode 配置里加一个 local MCP server：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "wemind": {
        "type": "local",
        "command": ["node", "<repo>/packages/wechat-mcp/dist/index.js"]
      }
    }
  }
}
```

或 CLI 添加并核对连接：

```sh
opencode mcp add wemind -- node <abs>/packages/wechat-mcp/dist/index.js
opencode mcp list
```

要点：
- 把示例里的 `<repo>` / `<abs>` 换成**你自己的 clone 绝对路径**（不要照抄别人的本机路径）。
- **V2 结构是 `mcp.servers`**（server 名不直接挂在 `mcp` 下）。README 的 OpenCode 片段已是 V2 `mcp.servers` 写法（2026-11-02 核对）。
- 工具名就是 MCP 工具名本身（`get_messages` / `send_text_message` / `send_typing` / `login_qrcode` / `check_qrcode_status` / `logout`），**没有** `wemind_` 前缀，也不是 `tools.wemind.*` 命名空间；OpenCode 会按 server 名 `wemind` 分组显示。
- 需 OpenCode 侧自行遵循 `get_messages(wait=true)`→`send_typing`→`send_text_message`→`send_typing(cancel)` 的工作流。

---

## 3. 形态②：OpenCode 作为 daemon 大脑（本文重点）

### 3.1 为什么可行

WeMind 的大脑通过**标准 ACP**驱动，与具体 agent 无关。项目文档已把 OpenCode 列入「原生支持 ACP」清单。M1 实测确认协议完全兼容（见 §3.3）。

### 3.2 与 kiro agent 的关键差异

| 维度 | kiro（现状） | OpenCode（需适配） |
|---|---|---|
| ACP 启动 | `kiro-cli acp --trust-all-tools` | `opencode acp` |
| 二进制（Windows） | `kiro-cli.exe`（PATH 上有 `.exe`） | PATH 上只有 `opencode.cmd`（npm shim）→ **必须经 shell 启动** |
| 配置目录变量 | `KIRO_HOME` = 沙箱，配置在 `<沙箱>/settings/` | `XDG_CONFIG_HOME` = 沙箱，配置在 **`<沙箱>/opencode/`**（换 `OPENCODE_CONFIG_DIR` 只能"追加"、不能替换 global，无法真正隔离） |
| MCP 配置文件 | `<沙箱>/settings/mcp.json` | `<沙箱>/opencode/opencode.json` 的 `mcp.servers` |
| MCP 配置格式 | `{ "mcpServers": { 名: {command, args, env} } }` | `{ "mcp": { "servers": { 名: {type:"local", command:[...], environment:{...}} } } }` |
| 模型选择 | `settings/cli.json` 的 `chat.defaultModel` | `opencode.json` 的 `model` 字段 |
| 记忆/技能 | 目录式 `steering/ memories/ skills/ …` | 目录式 `skills/ agents/ commands/`；另有单文件 `AGENTS.md` |
| 权限 | `--trust-all-tools` | `opencode acp` **不接受** `--auto`（官方 issue #52216）；WeMind 在沙箱 `opencode.json` 写 `"permission": "allow"`（用户自己配了 permission 则保留用户的）；ACP 仍可能发 `session/request_permission`，宿主默认拒绝、`WEMIND_ACP_AUTO_ALLOW=1` 放行 |
| 凭证/数据 | `KIRO_HOME` 移动 = 同目录规则 | 数据在 `~/.local/share/opencode`（**与配置分离**）→ 隔离配置不丢登录态；**代价是数据目录本身没有按账号隔离**：同一台机器上多个 WeMind 账号共用同一份登录态与后台服务（与 AGENTS.md §4.7「数据按账号隔离」的口径有出入，已知边界） |

### 3.3 M1 实测结果（已验证事实）

用**完全复刻 `acp-brain.ts` 组帧方式**的最小客户端（换行分隔 JSON-RPC、`clientCapabilities:{}`）驱动 `opencode acp`：

| 验证项 | 结果 | 意义 |
|---|---|---|
| `initialize` | ✅ `protocolVersion:1`；`loadSession:true`、`promptCapabilities.image:true`、`mcpCapabilities.http:true` | 握手兼容；支持发图 |
| `session/new` | ✅ 返回 `sessionId`，附 `configOptions`（`model`/`effort`/`mode`） | 会话建立正常 |
| `session/prompt` | ✅ `stopReason:end_turn`，`agent_message_chunk` 流式拼出 `"OK"` | 回复拼接正常 |
| `session/load` + 追问 | ✅ 答出 `"PINEAPPLE"` | **自愈路径可用**（崩溃重建后 `session/load` 恢复上下文） |
| 工具调用 | ✅ 出现 `tool_call` / `tool_call_update`，任务正确完成 | 微信"步骤 N"进度可用 |
| **反向请求** | ✅ **全程无**（无 `fs/*`、无 `session/request_permission`） | **最高风险排除**，`acp-brain.ts` 现状即够用 |

其他实测事实：
- `initialize` 还带 `sessionCapabilities.{additionalDirectories,close,delete,fork,list,resume}` 与 `_meta["opencode/child-session-updates"]`——WeMind 不理会，无副作用。
- `session/update` 会出现 `available_commands_update`、`usage_update`、`user_message_chunk`；WeMind 现有逻辑把它们当"活动"或忽略，**不报错**。
- 未登录任何 provider 时 OpenCode 仍可用其**自带免费模型**（`session/new` 默认 `opencode/nemotron-3.5-super-vl-free`）完成对话。
- **模型默认由 OpenCode 自己决定**：预设不带 `model`，WeMind 默认不下发；会话用它自己配置里的 `model`（沙箱 `opencode.json` 由你真实的 `~/.config/opencode/opencode.json` 作基底生成，手改沙箱那份会在下次启动被覆盖——要改就改真实那份）。也可以 `wemind brain set opencode --model '…'`（写入 `brain.json`，会话建立/恢复后经 `session/set_config_option` 下发，daemon 在跑时接着 `wemind brain switch opencode` 当场应用）——但 **OpenCode 是否接受这个 `configId` 尚未实测**（DSH/Qoder 已实测可用），下发失败会让该回合报错；稳妥做法仍是改真实 `opencode.json` 的 `model`。

**隔离与 MCP 挂载（M2 实现前另做的决定性验证）**：
- `OPENCODE_CONFIG_DIR` 只"追加"、**不能**替换默认 global，无法隔离 → 改用 **`XDG_CONFIG_HOME`**。
- 实测 `XDG_CONFIG_HOME=<dir>` 后：`opencode debug paths config` → `<dir>/opencode`；ACP 的 `session/new` 采用该目录 `opencode.json` 的 `model`；放入 `mcp.servers` 的假 MCP **被实际拉起**（标记文件被创建）→ **`opencode acp` 完整读取 `<XDG>/opencode/opencode.json`**。
- 结论：`XDG_CONFIG_HOME` 指向沙箱 = 配置隔离 + MCP 挂载**端到端成立**。（注：`opencode mcp list` 连的是共享后台服务，不代表 ACP 进程行为。）

### 3.4 实施方案

> 以下为**已实现**的实现说明（M2 已落地）；代码路径对应现仓库结构。

#### Step 1 · 新增 `opencode` agent（`packages/wechat-daemon/src/brain-agents.ts`）

```ts
opencode: {
  name: "opencode",
  bin: "opencode",
  binWin: "opencode",            // 经 shell 启动：裸名让 cmd.exe 解析 opencode.cmd / .exe 均可
  args: ["acp"],
  shell: true,                   // Windows 必需（PATH 上是 opencode.cmd shim）
  homeEnvVar: "XDG_CONFIG_HOME", // 指向沙箱 → 配置落在 <沙箱>/opencode/，真正替换 global
  realHome: path.join(os.homedir(), ".config", "opencode"),
  inheritDirs: ["skills", "agents", "commands"],
  inheritFiles: ["AGENTS.md"],
  configSubdir: "opencode",      // agent 配置目录相对沙箱的子路径（kiro 为空）
  mcpFormat: "opencode",         // opencode.json 的 mcp.servers
  mcpConfigFile: "opencode.json",
  catalogFile: "opencode.json",
  env: { OPENCODE_DISABLE_PROJECT_CONFIG: "1" }, // 不从 cwd 祖先目录发现用户 opencode.json
},
```

新增字段（`AcpAgentPreset`）：
- `configSubdir?: string` —— agent 配置目录相对沙箱根的子路径（kiro `""`；opencode `"opencode"`）。
- `mcpFormat` / `mcpConfigFile` / `catalogFile` —— MCP 格式与文件名（见 Step 3）。
- `inheritFiles` —— 单文件继承（`AGENTS.md`）。
- `env?: Record<string, string>` —— 额外注入的环境变量，值里 `%HOME%` 占位为沙箱根（见 Step 2）。

#### Step 2 · 环境变量注入（`brain-agents.ts` 的 `agentEnv()`）

现状只注入一个 `homeEnvVar`；实际实现把三处合成一个函数（brain 与 worker 共用，不再各自写一遍）：

```ts
export function agentEnv(ag: ResolvedAgent, home: string, skipped: string[] = []) {
  const env = { ...process.env };
  if (ag.homeEnvVar) env[ag.homeEnvVar] = home;                      // 沙箱目录
  for (const [k, v] of Object.entries(ag.credentialEnv?.(...) ?? {})) … // 凭据派生
  for (const [k, v] of Object.entries(ag.env ?? {})) env[k] = v.replaceAll("%HOME%", home);
  for (const [k, v] of Object.entries(ag.envDefaults ?? {})) …       // 父进程已设则保留父进程
  return env;
}
```

opencode agent 附带 `OPENCODE_DISABLE_PROJECT_CONFIG: "1"`（防御性：不从 cwd 祖先目录发现用户 opencode.json）。

#### Step 3 · MCP 沙箱按 agent 分派（`mcp-sandbox.ts`）

现状曾硬编码 kiro 约定：`BRAIN_MCP_JSON = <沙箱>/settings/mcp.json`、读写 `{mcpServers}`、CATALOG 默认 `<realHome>/settings/mcp.json`。

现已引入 **配置目录**（`path.join(BRAIN_HOME, preset.configSubdir ?? "")`）与按 agent 的 **`mcpFormat`**（纯函数在 `agent-mcp.ts`：`readMcpServers` / `withMcpServers` / `parseJsonc`）：

| 能力 | kiro | opencode |
|---|---|---|
| 配置目录 | `<沙箱>` | `<沙箱>/opencode` |
| 写 MCP | `<cfg>/settings/mcp.json` = `{mcpServers}` | `<cfg>/opencode.json` 的 `mcp.servers` |
| 读目录(CATALOG) | `<realHome>/settings/mcp.json` 的 `mcpServers` | `<realHome>/opencode.json` 的 `mcp.servers` |
| 隔离项 | 保持 `wechat` 在 `FORBIDDEN` | 同左 |

要点：
- brain 仍**默认空 MCP**；微信指令 `加载/卸载` 后写激活集 → 重启 ACP 生效。
- opencode 的 `mcp.servers` 对象**原样透传**（CATALOG 若来自用户 OpenCode 配置，格式已正确）。
- CATALOG 默认路径按 agent 的 `catalogFile` 取**单一文件名**（opencode 预设是 `<realHome>/opencode.json`；**不**自动回退到 `opencode.jsonc`——你的真实配置若只有 `.jsonc`，需要 `WEMIND_MCP_CATALOG` 显式指过去）。

#### Step 4 · 记忆/技能继承

- 目录式：`mirrorRealKiro()` 目标改为 `<BRAIN_CONFIG_DIR>/<dir>`（opencode 即 `<沙箱>/opencode/{skills,agents,commands}`），源为 `~/.config/opencode/{...}`。
- 单文件 `AGENTS.md`：目录 junction 机制不适用，需**额外拷贝** `~/.config/opencode/AGENTS.md` → 沙箱（或文档声明"不继承"）。

#### Step 5 · worker 沙箱同步（`worker-sandbox.ts`）

worker 策略相反（**继承全量 MCP，仅排除 wechat**），但同样要：写 `mcp.servers` 格式、路径切到 `<WORKER_CONFIG_DIR>/opencode.json`、继承 `<...>/opencode/{skills,agents}`。建议与 Step 3 复用同一份 strategy。

#### Step 6 · 模型注入（可选但推荐）

`syncSettings` 对 opencode 的行为应是：把用户全局 `opencode.json`（**移除 `mcp` 段**）作为"基底"拷入沙箱，再由 Step 3 覆盖 curated `mcp`。这样：
- 模型/其它设置跟用户日常一致（对应 kiro 的 `cli.json` 继承）；
- `mcp` 仍由沙箱权威，杜绝 `wechat` 回环。

#### Step 7 · Windows / 跨平台

- **必须 `shell:true`**（PATH 上是 `opencode.cmd`；`onPath("opencode.exe")` 找不到）。经 shell 时用裸名 `opencode`。
- 装了原生 `opencode.exe` 想跳过 shell 时，设 `WEMIND_BRAIN_SHELL=0` **并**用 `WEMIND_BRAIN_BIN=<绝对路径>` 指定可执行文件——只设 `WEMIND_BRAIN_BIN` 不会关掉预设的 `shell: true`。

#### Step 8 · 验证

```powershell
wemind brain set opencode --restart   # 写入磁盘持久（推荐）；一次性覆盖：$env:WEMIND_BRAIN = "opencode"
wemind brain check                    # 真起一个进程跑 ACP 握手（initialize + session/new）
```
启动 daemon 后微信发消息，`~/.wemind/<acct>/daemon.log` 应出现：
`[wemind/wechat-daemon/acp] spawn opencode acp … → initialized → session/new|session/load → prompt ok`。

**最快冒烟（不改代码，纯环境变量）**：
```powershell
$env:WEMIND_BRAIN_BIN     = "opencode"
$env:WEMIND_BRAIN_ARGS    = "acp"
$env:WEMIND_BRAIN_SHELL   = "1"
$env:WEMIND_BRAIN_INHERIT = "0"
npm run build; npm run daemon
```
> 注意：此步 `global` 配置仍会合并，仅供打通链路；隔离在 M2 完成后才生效。

### 3.5 风险与未决项

| # | 风险/待确认 | 影响 | 处置 |
|---|---|---|---|
| 1 | ACP 反向请求 | 可能卡死 | ✅ 已排除（M1 实测无） |
| 2 | 配置隔离彻底性 | global/system MCP 串入大脑 | ✅ 已用 `XDG_CONFIG_HOME` 实测隔离并成功读取沙箱 `mcp.servers`；agent 已注入 `OPENCODE_DISABLE_PROJECT_CONFIG=1` |
| 3 | 模型不继承 | 大脑用 OpenCode 默认（或免费模型） | ✅ 已实现：`syncOpencodeBase` 把用户 `opencode.json`（去 `mcp`）作基底写入沙箱 `model` |
| 4 | 权限语义 | OpenCode 自动批准 ≈ `--trust-all-tools` | 保留 daemon 的 `allowFrom` 登录者白名单（兜底校验，默认只放行登录者，勿关） |
| 5 | 共享后台服务 | 多实例/生命周期 | 观察 `opencode acp` 是否复用全局 background server；必要时评估 `--standalone` |
| 6 | 冷启动时延 | 首帧超时 | OpenCode 冷启动可能偏慢，按需放宽 `WECHAT_BRAIN_FIRST_FRAME_MS` |
| 7 | Code Mode 工具命名 | 微信"步骤 N"文案 | 实测 `tool_call.title` 文案，必要时在 `toolSummary()` / `zhTool()` 增加 OpenCode 风格映射 |

### 3.6 里程碑与工作量

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | 冒烟：`opencode acp` 可被现有 ACP 客户端驱动，确认无反向请求 | ✅ 完成 |
| M2 | Step 1–3：agent + 多 env 注入 + 沙箱 strategy（brain 默认空、动态 MCP） | ✅ 完成 |
| M3 | Step 4–6：记忆/技能继承 + worker 改造 + 模型注入 | ✅ 完成 |
| M4 | Step 7–8 + 文档：Windows 兼容、验证脚本、更新 [接入其它-ACP-Agent.md](接入其它-ACP-Agent.md) 与 README 的 OpenCode 片段 | ✅ 文档/脚本就绪；**worker 侧**任务结果推送与**对话大脑**的微信端到端均已于 2026-10-29 实测通过（见 [run-e2e §7.3](../ai/recipes/run-e2e.md)） |

**实现清单（本次改动）**：

| 文件 | 改动 |
|---|---|
| `packages/wechat-daemon/src/brain-agents.ts` | 新增 `opencode` agent；`AcpAgentPreset`/`ResolvedAgent` 增加 `configSubdir`/`mcpFormat`/`mcpConfigFile`/`catalogFile`/`env`/`inheritFiles` |
| `packages/wechat-daemon/src/agent-mcp.ts`（新） | MCP 格式纯函数：`readMcpServers`/`withMcpServers`/`parseJsonc` |
| `packages/wechat-daemon/src/mcp-sandbox.ts` | 按 agent 分派配置目录与 MCP 格式；opencode 继承 `model` 基底；`inheritFiles` 支持 |
| `packages/wechat-daemon/src/worker-sandbox.ts` | 同上（worker 策略：继承全量 MCP 除 wechat） |
| `packages/wechat-daemon/src/acp-brain.ts` / `worker-acp.ts` | 注入配置里的 `env`（`%HOME%` → 沙箱） |
| `packages/wechat-daemon/src/agent-mcp.test.ts` / `brain-agents.test.ts`（新） | 单测 |
| `scripts/acp-probe.mjs` | M1 回归 harness（当时的 `acp-smoke.mjs`/`acp-smoke2.mjs` 只硬编码 `opencode acp`，已并入通用探针后删除） |
| `README.md` / `docs/接入方案/接入其它-ACP-Agent.md` | 文档更新 |

---

## 4. 安装与准备

> 本节把散落在 §3.2、§3.4 Step 7、附录 A / 附录 B 的前置条件归拢到一处，事实与结论不变。

- **实测环境**：Windows 11 / Node ≥20 / OpenCode v2.0.29（M1）；2026-10-29 在 v2.0.32 上复测 `session/delete`、`load` 回放与并行任务（见 [run-e2e §7.3](../ai/recipes/run-e2e.md)）。
- **ACP 入口**：`opencode acp`；`opencode acp --login` 可跑登录。
- **Windows 可执行文件**：PATH 上是 npm shim `opencode.cmd`，没有无扩展名的 `opencode`，`onPath("opencode.exe")` 也找不到；预设因此 `shell: true`，以裸名 `opencode` 交给 shell 解析。
- **版本/目录核对**：`& $exe --version` 记录版本；`& $exe debug paths` 确认 config（`~/.config/opencode`）与 data（`~/.local/share/opencode`）分离。
- **登录不是硬前置**：未登录任何 provider 时，仍可用 OpenCode 自带免费模型（`session/new` 默认 `opencode/nemotron-3.5-super-vl-free`）完成对话。
- **设为大脑**：`wemind brain set opencode --restart`（写入磁盘持久）；一次性覆盖用 `$env:WEMIND_BRAIN = "opencode"`。
- **握手自检**：`wemind brain check` 会真起进程跑 `initialize + session/new`；启动 daemon 后微信发消息，`~/.wemind/<acct>/daemon.log` 应出现 `[wemind/wechat-daemon/acp] spawn opencode acp … → initialized → session/new|session/load → prompt ok`。
- **最快冒烟（不改代码，纯环境变量）**：

```powershell
$env:WEMIND_BRAIN_BIN     = "opencode"
$env:WEMIND_BRAIN_ARGS    = "acp"
$env:WEMIND_BRAIN_SHELL   = "1"
$env:WEMIND_BRAIN_INHERIT = "0"
npm run build; npm run daemon
```

> 此步 global 配置仍会合并，仅供打通链路；隔离要在 M2（沙箱）之后才生效。

- **原生 `opencode.exe` 想跳过 shell**：须同时设 `WEMIND_BRAIN_SHELL=0` 与 `WEMIND_BRAIN_BIN=<绝对路径>`；只设 `WEMIND_BRAIN_BIN` 不会关掉预设的 `shell: true`。

---

## 5. 预设与沙箱

`opencode` 是内置预设（`ACP_AGENT_PRESETS`），字段定义见 §3.4 Step 1；落地结果如下：

| 项目 | 落地结果 | 依据 |
|---|---|---|
| 启动 | `opencode acp`；`shell: true`、`binWin: "opencode"` | §3.4 Step 1 / Step 7 |
| 沙箱配置目录 | `XDG_CONFIG_HOME=<沙箱>` → 配置实到 `<沙箱>/opencode/`；`OPENCODE_CONFIG_DIR` 只「追加」、不替换 global，无法隔离，故不用 | §3.2、§3.3 |
| MCP 文件 | `<沙箱>/opencode/opencode.json` 的 `mcp.servers`（`mcpFormat: "opencode"`） | §3.4 Step 3 |
| MCP 激活 | brain 默认空 MCP；微信 `加载/卸载` 后写激活集，重启 ACP 生效；`mcp.servers` 条目原样透传 | §3.4 Step 3 |
| MCP 目录（CATALOG） | 默认 `<realHome>/opencode.json`；**不**回退 `opencode.jsonc`——真实配置只有 `.jsonc` 时用 `WEMIND_MCP_CATALOG` 显式指过去 | §3.4 Step 3 |
| worker | 继承全量 MCP、仅排除 `wechat`；路径同为 `<WORKER_CONFIG_DIR>/opencode.json` | §3.4 Step 5 |
| 记忆/技能 | `skills` / `agents` / `commands` 目录 junction；`AGENTS.md` 单文件额外拷贝 | §3.4 Step 4 |
| 模型基底 | 用户真实 `opencode.json`（去掉 `mcp` 段）作基底写入沙箱，继承 `model` 等设置；MCP 仍由沙箱权威 | §3.4 Step 6、§3.5 #3 |
| 项目配置发现 | `OPENCODE_DISABLE_PROJECT_CONFIG=1`，不从 cwd 祖先目录发现用户 `opencode.json` | §3.4 Step 2 |
| 数据/凭证 | `~/.local/share/opencode`，与配置分离；隔离配置不丢登录态，但该目录不按账号隔离 | §3.2 |

补充：

- **隔离与 MCP 端到端已实测**：`XDG_CONFIG_HOME=<dir>` 后 `opencode debug paths config` 输出 `<dir>/opencode`；ACP 的 `session/new` 采用该目录 `opencode.json` 的 `model`；放进 `mcp.servers` 的假 MCP 被实际拉起（标记文件被创建）→ `opencode acp` 完整读取 `<XDG>/opencode/opencode.json`。
- **沙箱配置是生成物**：沙箱 `opencode.json` 每次启动由真实配置重新生成，手改沙箱那份下次启动即失效——改模型/设置请改真实那份。
- **`opencode mcp list` 不代表 ACP 行为**：它连的是共享后台服务，不能用来判断 ACP 进程读了哪个配置目录。

---

## 6. 探针与实测

### 6.1 探针入口

复现步骤与 harness 见附录 A（§8）。通用探针 `scripts/acp-probe.mjs` 用 `ACP_BIN` / `ACP_ARGS` 指定 agent（`ACP_ARGS='["acp"]'`）；`ACP_TEST_IMAGE=1`、`ACP_TEST_MCP=…`、`ACP_HARD_KILL=1` 分别测图片、ACP MCP、强杀后 resume。早期只硬编码 `opencode acp` 的 `acp-smoke.mjs` / `acp-smoke2.mjs` 已删除。

### 6.2 M1 结论（v2.0.29）

用完全复刻 `acp-brain.ts` 组帧方式的最小客户端（换行分隔 JSON-RPC、`clientCapabilities:{}`）驱动 `opencode acp`，逐项结果见 §3.3，摘要：

- `initialize` 返回 `protocolVersion:1`，`loadSession:true`、`promptCapabilities.image:true`、`mcpCapabilities.http:true` → 握手兼容、支持发图。
- `session/new` 返回 `sessionId` 与 `configOptions`（`model` / `effort` / `mode`）。
- `session/prompt` 以 `stopReason:end_turn` 结束，`agent_message_chunk` 流式拼出 `"OK"`。
- `session/load` + 追问答出 `"PINEAPPLE"` → 崩溃重建后能恢复上下文。
- 工具调用出现 `tool_call` / `tool_call_update`，任务正确完成 → 微信「步骤 N」进度可用。
- **反向请求全程无**（无 `fs/*`、无 `session/request_permission`）→ 协议层无需为 OpenCode 改动。

### 6.3 其他实测事实

- `initialize` 还带 `sessionCapabilities.{additionalDirectories,close,delete,fork,list,resume}` 与 `_meta["opencode/child-session-updates"]`；WeMind 不理会，无副作用。
- `session/update` 会出现 `available_commands_update`、`usage_update`、`user_message_chunk`；现有逻辑把它们当「活动」或忽略，不报错。
- 2026-10-29（v2.0.32，run-e2e §7.3）：`session/delete` 可用；`session/load` 回放 2 帧 / 857ms；opencode + qoder 两条任务并行结果均送达、未见限流型 `ret=-2`；强杀后 `session/load` 能接回原任务会话。
- 同轮记录冷启动 `initialize` 约 650ms、`session/new` 约 800ms（[`docs/ai/已知坑.md`](../ai/已知坑.md)），远小于 30s 请求超时。
- brain 通道真机 E2E 已于 2026-10-29 通过（微信发消息 → `opencode acp` → 自动回复，见 [CHANGELOG](../发布与变更记录/CHANGELOG.md)）；worker 侧任务结果推送同轮通过。
- 工具标题实测到 `call-4516d245-…` 这类形态（M1 输出）。

---

## 7. 限制

- **配置隔离只走 `XDG_CONFIG_HOME`**：`OPENCODE_CONFIG_DIR` 是「追加」语义，单独设置不能替换默认 global，无法隔离；`OPENCODE_CONFIG` 只指定单文件；历史 issue 提示 `OPENCODE_CONFIG_DIR` 单独设置可能不加载其内 `opencode.json`。
- **数据目录不按账号隔离**：登录态与后台服务都在 `~/.local/share/opencode`，同机多个 WeMind 账号共用；与 AGENTS.md §4.7「数据按账号隔离」的口径有出入（已知边界）。
- **沙箱配置是生成物**：手改沙箱 `opencode.json` 会在下次启动被真实配置覆盖。
- **CATALOG 只认单一文件名**：默认 `<realHome>/opencode.json`，不自动回退 `.jsonc`；真实配置只有 `opencode.jsonc` 时必须用 `WEMIND_MCP_CATALOG` 显式指定。
- **模型由 OpenCode 决定**：预设不带 `model`，WeMind 默认不下发；`wemind brain set opencode --model …` 的 `configId` 是否被接受尚未实测（见「待实测」），下发失败会让该回合报错，稳妥做法是改真实 `opencode.json` 的 `model`。
- **权限**：`opencode acp` 不接受 `--auto`（官方 issue #52216）；WeMind 在沙箱 `opencode.json` 写 `"permission": "allow"`（用户自己配了 permission 则保留用户的）。ACP 仍可能发 `session/request_permission`：宿主默认拒绝，`WEMIND_ACP_AUTO_ALLOW=1` 才逐次放行；daemon 的 `allowFrom` 登录者白名单是兜底校验，勿关。
- **共享后台服务**：`opencode acp` 是否复用全局 background server 未确认；多实例/生命周期需观察，必要时评估 `--standalone`。
- **冷启动时延**：首帧阈值是否够用取决于机器（本机记录见 §6.3），按需放宽 `WECHAT_BRAIN_FIRST_FRAME_MS`。
- **Code Mode 工具命名**：`tool_call.title` 文案可能影响微信「步骤 N」，必要时在 `toolSummary()` / `zhTool()` 增加 OpenCode 风格映射。
- **同 agent 并发共用配置目录**：同一 agent 的两个 worker 进程共用一个配置目录；opencode 两条并发一轮样本未见互踩，长期风险仍在。
- **形态①与形态②互斥**：同一 bot token 不要同时跑 MCP 形态与 daemon 形态（会抢消息、回环）。

---

## 待实测

- **`session/set_config_option` 的 `model` 接受度**：`wemind brain set opencode --model '…'` 下发的 `configId` OpenCode 是否接受尚未实测（DSH/Qoder 已实测可用）；下发失败会让该回合报错。
- **共享后台服务**：`opencode acp` 是否复用全局 background server 尚未确认，是否需要 `--standalone` 尚未评估。
- **冷启动首帧阈值**：本机 2026-10-29 记录 `initialize` 约 650ms、`session/new` 约 800ms，但未覆盖慢机器；`WECHAT_BRAIN_FIRST_FRAME_MS` 是否需要放宽未验证。
- **Code Mode 工具标题映射**：尚未逐类实测 `tool_call.title` 的 OpenCode 风格文案，`toolSummary()` / `zhTool()` 是否需要映射未验证（M1 只记录到 `call-4516d245-…` 形态）。
- **同 agent 并发长期风险**：仅 2026-10-29 一轮样本（opencode 两条并发未见互踩），长期是否互踩仍待观察。

---

## 8. 附录 A · M1 复现步骤与 harness

**复现**（Windows，PowerShell）：

```powershell
# 1) 找到真正的可执行文件（npm shim 指向它）
$exe = "<...>\node_modules\@opencode\cli\bin\opencode.exe"   # 或让 shell 解析 `opencode`
& $exe --version          # 记录版本（实测 v2.0.29）
& $exe debug paths        # 确认 config/data 目录分离

# 2) 运行通用探针（见下），逐帧观察 ACP 交互与反向请求
$env:ACP_BIN = $exe
$env:ACP_ARGS = '["acp"]'
node scripts/acp-probe.mjs
```

> 早期 M1 用的 `acp-smoke.mjs` / `acp-smoke2.mjs` 只硬编码 `opencode acp`、与 `acp-probe.mjs` 重叠，已删除；`acp-probe.mjs` 用 `ACP_BIN`/`ACP_ARGS` 指定 agent，覆盖同样的检查项（`ACP_TEST_IMAGE=1`、`ACP_TEST_MCP=…`、`ACP_HARD_KILL=1` 分别测图片、ACP MCP、强杀后 resume）。

**harness 要点**：
- 用 `spawn(exe, ["acp"], { stdio: ["pipe","pipe","pipe"] })`，按 `\n` 切帧解析 JSON。
- 发 `initialize {protocolVersion:1, clientCapabilities:{}}` → `session/new {cwd, mcpServers:[]}` → `session/prompt`。
- 对「有 `method` 且有 `id` 但不在 pending」的帧判定为**反向请求**并记录（这是本方案最关键的可观测点）。
- 汇总 `session/update` 的 `sessionUpdate` 类型与 `agent_message_chunk` 拼接文本。

**M1 关键输出（节选）**：

```
initialize : {"protocolVersion":1,"agentCapabilities":{"loadSession":true,
             "mcpCapabilities":{"http":true,"sse":false},
             "promptCapabilities":{"embeddedContext":true,"image":true}, ...}}
session/new: {"sessionId":"ses_...","configOptions":[{"id":"model", ...}]}
prompt     : {"stopReason":"end_turn","usage":{"outputTokens":3,...}}
answerText : "OK"
REVERSE REQUESTS: (none)
```

```
# smoke2：工具 + load
tool answer  : "The secret word is **PINEAPPLE**."
tool titles  : call-4516d245-...
session/load : {"configOptions":[...]}          # 成功
recall answer: "PINEAPPLE"                       # 上下文恢复成功
REVERSE REQS : (none)
```

---

## 9. 附录 B · OpenCode 相关事实速查

| 项 | 值（实测 v2.0.29） |
|---|---|
| ACP 入口 | `opencode acp`（`--login` 可跑登录） |
| 协议 | JSON-RPC 2.0 over stdio，换行分隔，ACP v1 |
| 配置目录 | `~/.config/opencode`（`debug paths config`） |
| 数据/凭证 | `~/.local/share/opencode`（与配置分离） |
| 配置目录 env | `XDG_CONFIG_HOME`（**替换** `~/.config`）、`OPENCODE_CONFIG_DIR`（**追加**）、`OPENCODE_CONFIG`（指定文件）、`OPENCODE_DISABLE_PROJECT_CONFIG` |
| MCP 配置 | `{ "mcp": { "servers": { 名: { type:"local", command:[...], environment:{...} } } } }` |
| 记忆/技能 | `AGENTS.md`（单文件）+ `skills/`、`agents/`、`commands/`（目录式，全局在配置目录下） |
| IaC 注意 | `OPENCODE_CONFIG_DIR` 单独设置可能不加载其内 `opencode.json`（历史 issue），稳妥用 `XDG_CONFIG_HOME` 或同时设 `OPENCODE_CONFIG` |

**参考**：OpenCode ACP <https://opencode.ai/v2/docs/cli/acp/> · 配置 <https://opencode.ai/v2/docs/config> · MCP <https://opencode.ai/v2/docs/mcp-servers> · ACP 生态 <https://agentclientprotocol.com/get-started/agents>。
