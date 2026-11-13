# 接入 Cline CLI（原生 ACP 实测）

> **2026-11-12 口径**：默认 `homeMode=real`，Cline 没有 `homeEnvVar`，微信侧直接使用真实 `~/.cline`（`CLINE_DIR` 指向它），并与终端共享配置、技能、记忆与会话库；本文涉及 `brain-home` / `worker-home` 的描述仅适用于显式 `homeMode=sandbox`（此时配置落到 `<沙箱>/cline`）。

> **状态**：M0–M3 全部完成 ✅（`cline` 是内置预设；M2 协议层无改动）。
> **实测范围**：Cline CLI 3.0.74（M0 探针 + 微信真机 E2E，2026-10-31，见 §2 / §6）｜ **最后核对**：2026-11-12
> **实测环境**：Windows 11 / Node 24 / Cline CLI 3.0.74（npm 全局安装）。结论**仅适用于 cline 3.0.74**。
> **相关文档**：[接入其它-ACP-Agent.md](接入其它-ACP-Agent.md) · [ai/recipes/add-acp-agent.md](../ai/recipes/add-acp-agent.md) · [接入-Qoder.md](接入-Qoder.md)（同款「配置目录指到子目录」样板） · [接入-OpenCode.md](接入-OpenCode.md)（文件式 MCP 样板）

---

## 0. TL;DR

- Cline CLI **原生支持 ACP**：`cline --acp`。社区适配器 [`cline-acp`](https://github.com/TonksThebear/cline-acp) 已在 2026-02 归档（作者原话：Cline now directly supports ACP），**不要再装适配器**。
- WeMind 预设：`cline` → `cline --acp --auto-approve true`，配置目录走 `CLINE_DIR`/`CLINE_DATA_DIR`/`CLINE_MCP_SETTINGS_PATH`；`real`（默认）下直接指向真实 `~/.cline`，`sandbox` 下才指向账号沙箱的 `cline/` 子目录。
- **认证是唯一硬前置**：ACP 只自动恢复 Cline 自己的 3 种登录（`cline` / `cline-pass` / `openai-codex`）；用**自定义/API-key provider**（如 `openai-compatible`）时，WeMind 会**自动从 `providers.json` 读取** `lastUsedProvider` + `settings.apiKey`，转成 Cline 官方 ACP 环境变量 `CLINE_PROVIDER` + `CLINE_API_KEY`（父进程显式设了这两个变量时完全不接管）。没有可用的 apiKey（如 OAuth 条目）时才需要手工设置，否则 `session/new` 直接：

  ```text
  -32000 Authentication required: Call authenticate before starting a session
  ```

- 协议能力（3.0.74）：`loadSession:true`、`agent_thought_chunk` / `agent_message_chunk` / `session_info_update`、**0 反向请求**、硬杀后 `session/load` 能接回上下文；`session/close` ❌（`-32601`，WeMind 不调用）。**图片 ❌**：`initialize` 虽然声明 `image:true`，但 ACP `prompt` 的 `de()` 只保留 `text` 块（图片被丢弃），所以预设显式 `images:false`。
- **MCP 只能走配置文件**：Cline 收到 `session/new.mcpServers` 只存不用；预设用 `CLINE_MCP_SETTINGS_PATH` 指到当前配置目录的 `cline/mcp.json`（`real` 为真实 `~/.cline/...` 但 WeMind 不写，`sandbox` 为 `<沙箱>/cline/mcp.json`；`{ "mcpServers": {…} }`，与 kiro 同格式）。

---

## 1. 安装与认证

```powershell
npm i -g cline
cline --version        # 期望 3.x（本项目实测 3.0.74）
```

- 需要 **Node.js 20+**（官方建议 22）。
- 微信大脑与 worker 都用同一份全局安装的 `cline`；不需要适配器。

### 1.1 三种「开箱可用」的登录

Cline 的 ACP 在 `session/new` 前检查登录态（`isSessionReady`）：只有下面三个 provider 会被 `tryRestoreAuth()` 自动恢复，凭据来自 `~/.cline/data/settings/providers.json`：

| authMethod id | 说明 |
|---|---|
| `cline` | Cline 账号 |
| `cline-pass` | ClinePass |
| `openai-codex` | ChatGPT 订阅 |

先在日常环境里跑 `cline auth` 完成登录；`real`（默认）下直接使用真实 `~/.cline`，`sandbox` 下 WeMind 会把 `providers.json` 同步进大脑/worker 沙箱。

### 1.2 自定义 / API-key provider（自动复用，可显式覆盖）

若你日常用的是 `openai-compatible`、OpenRouter、自建网关**等自定义 provider**：Cline 的 ACP **不会**读取 `providers.json` 里的 `lastUsedProvider`（`tryRestoreAuth()` 只认三种 OAuth 登录）。Cline 官方给 ACP 的逃生口是：

```text
CLINE_PROVIDER  +  CLINE_API_KEY
```

WeMind 在 spawn 前会自动做一层**只读桥接**（`clineCredentialEnv()`）：

1. 父进程**已经设了** `CLINE_PROVIDER` 或 `CLINE_API_KEY` → **完全不接管**（避免 provider 与 key 错配）；
2. 否则读 `~/.cline/data/settings/providers.json`；
3. 取 `lastUsedProvider` 对应条目的 `settings.apiKey`（非空字符串）；
4. 有就把 `CLINE_PROVIDER=lastUsedProvider`、`CLINE_API_KEY=<apiKey>` 注入子进程环境；
5. 没有 apiKey（OAuth 条目）、文件缺失/损坏 → 不注入，继续走 Cline 自己的认证逻辑。

所以正常情况**不需要手动设环境变量**：

```powershell
wemind brain set cline
wemind brain check        # 会读 ~/.cline/.../providers.json，自动带上自定义 provider 的 key
```

以下情况需要手工设置（显式值永远优先）：

- `lastUsedProvider` 指向的条目没有 `apiKey`（只有 `auth` 的 OAuth 条目）；
- `providers.json` 不存在、被改坏、或 `apiKey` 为空；
- 你想临时换 provider（例如 `$env:CLINE_PROVIDER="openrouter"`）。

```powershell
$env:CLINE_PROVIDER = "openai-compatible"
$env:CLINE_API_KEY  = "<你的 key>"
wemind stop <账号>; wemind start <账号>
```

注意：

- 自动读取发生在**每次 spawn**：改了 `cline auth` / `providers.json` 后，**重启 daemon**（`wemind stop <key> && wemind start <key>`）或切到**另一个** agent 再切回来，才会重新读取；正在运行的 ACP 子进程不会热更新。**`wemind brain switch cline` 在已经是 cline 时不会重启进程**——`preflightSwitch()` 的 `sameAgent()` 判 name/bin/args/model 全相同即返回 `already`，直接答复「已经是它，无需切换」，只把选择落实到磁盘（改过 `providers.json` 这种情况尤其容易踩：切换「成功」了但 key 仍是旧的）。要强制重读：`wemind stop <key> && wemind start <key>`，或先 `wemind brain switch <别的 agent>` 再切回 cline。
- 只读、不写、不打印 key；key 只进入子进程环境，不写进 `brain.json` 或源码（AGENTS §4.9）。
- `wemind brain check` 和微信里的失败回复仍会给出可执行提示（`authHint()`），不会再只说「重启一次 daemon」。

---

## 2. 启动与能力（M0 探针）

`scripts/acp-probe.mjs` 实测（沙箱 home 只放 `providers.json` + 一个自定义 provider 的 key）：

```powershell
$env:ACP_BIN='cline.cmd'; $env:ACP_ARGS='["--acp","--auto-approve","true"]'; $env:ACP_SHELL='1'
$env:ACP_HOME_ENV='CLINE_DIR'; $env:ACP_HOME="$env:TEMP\cline-probe"
$env:CLINE_PROVIDER='openai-compatible'; $env:CLINE_API_KEY='…'
node scripts/acp-probe.mjs
```

| # | 问题 | 结果（3.0.74） |
|---|---|---|
| Q1 | `initialize` 能力 | `loadSession:true`；`promptCapabilities.image:true`、`audio:false`、`embeddedContext:false`；`authMethods: cline / cline-pass / openai-codex` |
| Q2 | `session/new` | 需要先有登录态（见 §1）；返回 `modes`（`plan`/`act`）、`models`、`configOptions`：`model`（select）、`mode`（plan/act）、`auto_approve`（boolean） |
| Q3 | 首帧 / 更新类型 | prompt 首帧 **4.1s**、首字 **4.4s**；帧类型 `agent_thought_chunk` / `agent_message_chunk` / `session_info_update` |
| Q4 | 反向请求 | **0 个**（未触发 `session/request_permission` / `fs/*` / `terminal/*`） |
| Q5 | 硬杀后恢复 | `session/load` **成功**，`PINEAPPLE` 上下文保留（首字 2.1s）；`session/close` → `-32601` |
| Q6 | 图片 / MCP | **图片实际不可用**：`initialize` 声明 `image:true`，但 3.0.74 的 ACP `prompt` 里 `de(e.prompt)` 只 `filter(type==="text")`，image 块被直接丢弃（2026-10-31 真机：模型只看到「用户发来一张图片」文字，回复没收到图）→ 预设 `images:false`；`session/new` 的 `mcpServers` **不生效**（只存进 session 对象，`buildConfig` 不再使用），MCP 走配置文件 |

结论：**协议层零改动**——默认 `restore: "load"`、默认首帧/心跳都够用；只要 agent + 沙箱。图片例外：预设显式 `images:false`（见 Q6）。

---

## 3. 沙箱与预设

```ts
cline: {
  name: "cline",
  bin: "cline",
  binWin: "cline.cmd",              // npm 全局安装的 Windows shim；shell:true
  args: ["--acp", "--auto-approve", "true"],
  shell: true,
  images: false,                    // 3.0.74 实测：声明 image:true 但 ACP prompt 丢弃图片
  env: {
    CLINE_DIR: `%HOME%${path.sep}cline`,
    CLINE_DATA_DIR: `%HOME%${path.sep}cline${path.sep}data`,
    CLINE_MCP_SETTINGS_PATH: `%HOME%${path.sep}cline${path.sep}mcp.json`,
  },
  realHome: path.join(os.homedir(), ".cline"),
  inheritDirs: ["rules", "skills", "agents"],
  configSubdir: "cline",
  mcpFormat: "mcpServers",
  mcpConfigFile: "mcp.json",
  catalogFile: "data/settings/cline_mcp_settings.json",
  credentialFiles: ["data/settings/providers.json", "data/settings/models.json"],
  credentialEnv: clineCredentialEnv,   // 自定义 provider：从 providers.json 派生 CLINE_PROVIDER/KEY
}
```

要点：

- **配置目录**：`real` 模式下 `CLINE_DIR` 直接用真实 `~/.cline`（`realEnv` 修正）；`sandbox` 模式下指到 `<sandbox>/cline`，由 `configSubdir` 决定。brain 的 cwd 始终是 `<账号>/workspace/brain`，不是配置目录；三个 env 必须与 `configSubdir` 一致。
- `CLINE_DATA_DIR` 显式写成 `<CLINE_DIR>/data`（Cline 的默认值也是它），避免上游改默认值时沙箱漏到真实目录。
- **MCP 文件**：`CLINE_MCP_SETTINGS_PATH` 在 `sandbox` 下指到 `<sandbox>/cline/mcp.json`；`real` 下直接指到真实 `~/.cline/mcp.json`。Cline 没有 `homeEnvVar`，real/mirror 下没有独立视图：WeMind **不会写**真实 `~/.cline/mcp.json`，`加载`/`卸载` 只更新激活集并告警（普通配置也不受影响）；catalog 仍只读 `~/.cline/data/settings/cline_mcp_settings.json`。要 MCP 生效必须设 `homeMode=sandbox`，此时 `applySandbox()` 写 `<沙箱>/cline/mcp.json` 的 `{ "mcpServers": {…} }`。
  - 验证方式（不需要起 daemon）：`cline config mcp --json` 在设置 `CLINE_DIR`/`CLINE_DATA_DIR`/`CLINE_MCP_SETTINGS_PATH` 后能列出**当前配置目录**里的 server。`real`/`mirror` 下额外断言真实 `~/.cline/mcp.json` **字节不变**，日志含「real 模式不会改写真实配置（跳过MCP 激活集）」；`sandbox` 下 `<沙箱>/cline/mcp.json` 含所选 server。
  - `wechat` 永久禁止；brain 默认空、按需 `加载 <名>`；worker 继承全量但排除 `wechat` 与 `disabled:true`。
- **登录态与模型目录**：`data/settings/providers.json`（登录态/自定义 provider）与 `data/settings/models.json`（provider 的模型目录缓存）在 `sandbox` 下按「新者胜」同步（与 DSH `.credentials.yaml` 同策略）；`real` 下直接用真实文件。**`models.json` 不能漏**：缺它时 Cline 的 `session/new` 会回退到 `gpt-4o`，自定义 provider 下第一条 prompt 就报 `knows no model "gpt-4o"`（2026-10-31 真机踩到并修复）。自定义 provider 另由 `credentialEnv: clineCredentialEnv` 在 spawn 前从**真实** `~/.cline/data/settings/providers.json` 派生 `CLINE_PROVIDER`/`CLINE_API_KEY`（显式 env 优先）。**注意**：`sandbox` 里 OAuth token 刷新不会写回真实文件，长期两条登录态可能漂移；用 API-key provider 或定期在日常环境 `cline auth` 可以规避。
- **记忆/技能**：`real` / `mirror` 下 `rules/`、`skills/`、`agents/` 直接使用真实 `~/.cline`；`sandbox` 下才以 junction（Windows）/ symlink 链入沙箱。`hooks/`、`plugins/` **不继承**（插件可自带 MCP，微信侧只允许 curated MCP）。
- **免审批**：`--auto-approve true` 是 Cline 官方 ACP 文档给的启动开关（`auto_approve` config 的启动默认值）。这与其它预设一致——但 WeMind 侧权限应答器仍默认拒绝边缘权限请求，`WEMIND_ACP_AUTO_ALLOW=1` 才逐次放行。

### 3.1 模型

- `session/new` 的 `model` 来自 provider 设置（本机实测 `auto/dfmodel`）；也可显式覆盖：

  ```powershell
  wemind brain set cline --model "<你的模型 id>"
  wemind brain switch cline    # daemon 在跑时应用
  ```

  WeMind 在会话建立/恢复后发一次 `session/set_config_option { configId: "model", value }`（Cline 的 configOption id 就是 `model`）。

---

## 4. 使用

```powershell
wemind brain set cline
wemind brain                 # 应显示 agent=cline、args=[acp --auto-approve true]、model=…（**没有 configSubdir 字段**——它只在预设里，`wemind brain` 不显示）
wemind brain check           # 真握手；自定义 provider 会自动复用 providers.json 的 key
```

微信里：

```text
切换大脑 cline
任务 cline：把这个仓库的 README 里过期的版本号找出来
```

- **brain**：`real`（默认）下 `CLINE_DIR=~/.cline`；`sandbox` 下是 `<账号>/brain-home/cline`。默认 MCP 空；`sandbox` 下 `加载 <名>` 写 `<沙箱>/cline/mcp.json`，`real`/`mirror` 下只记录激活集、不写真实配置（告警）。**激活集真变了才重启 ACP 进程**（`daemon-control.ts` 只在 `changed` 时调 `restartForMcpChange()`；正在生成的回合会排到回合结束）。
- **worker**：`real`（默认）下 `CLINE_DIR=~/.cline`；`sandbox` 下是 `<账号>/worker-home/cline`。MCP 集 = 真实 catalog + overlay `mcp.extra` − `wechat` − `WEMIND_WORKER_MCP_EXCLUDE` − `disabled:true` − overlay `mcp.disable`；只有 `sandbox` 写 `<沙箱>/cline/mcp.json`。
- **热切换**：`wemind brain switch cline` 会启动新 ACP 进程并等 `session/new` 成功后才写 `brain.json`；失败退回旧大脑。

---

## 5. 已知限制

1. **认证**：Cline ACP 只自动恢复 3 种 OAuth 登录；自定义/API-key provider 由 WeMind 从 `providers.json` 自动派生 `CLINE_PROVIDER`/`CLINE_API_KEY`（显式 env 优先）；OAuth 条目或文件不可用时才需要手动设置（见 §1.2）。
2. **`session/close` 不存在**（`-32601`）：WeMind 目前不调用它，杀进程即可；若未来加「优雅关闭」，要对 Cline 跳过。
3. **MCP 走 ACP 不支持**：`mcpViaAcp` 必须保持 `false`；改用 `CLINE_MCP_SETTINGS_PATH`。
4. **OAuth token 单向同步**：沙箱内刷新不会回写真实 `providers.json`（见 §3）。API-key provider 不受影响。
5. **图片不支持（实测）**：`initialize` 声明 `image:true`，但 3.0.74 ACP `prompt` 的 `de()` 只保留 `text` 块，image 被丢弃；预设显式 `images:false`，daemon 收到纯图片消息会直接回「当前大脑暂不支持看图」，不再让模型猜；带文字的消息只按文字回答并注明图片被忽略。
6. **同 agent 并发**：`real` 下多个 worker 共用真实 `~/.cline`；`sandbox` 下共用 `<worker-home>/cline`。**假设/待实测**：Cline 的会话库据其源码是 SQLite，长期并发风险未验证（本轮只跑过单任务与双 agent 并发，没跑同 agent 双 worker 的长时间样本）。
7. **「新会话」不隔离文件系统（暂缓项）**：Cline 作为工具型 agent，会在任务 cwd 内看到并操作文件；旧 session transcript 在 `real` 下位于真实 `~/.cline/data/sessions/`，`sandbox` 下才位于 `<sandbox>/cline/data/sessions/`（**假设/待实测**：目录位置来自 Cline 的数据布局，本轮未逐个文件核实）。这是工具型 agent 的预期行为，WeMind 不额外改写 `.clineignore` 或搬移其数据目录；需要强隔离时请把任务 `--cwd` 指到独立目录。

---

## 6. 验证记录

- **M0 探针（3.0.74，2026-10-31，§2 Q1–Q6）**：`initialize` 返回 `loadSession:true`、`promptCapabilities.image:true`（`audio:false`、`embeddedContext:false`）、`authMethods: cline / cline-pass / openai-codex`；`session/new` 需先有登录态，返回 `modes`（`plan`/`act`）、`models` 与 `configOptions`（`model` / `mode` / `auto_approve`）；prompt 首帧 **4.1s**、首字 **4.4s**，帧类型 `agent_thought_chunk` / `agent_message_chunk` / `session_info_update`；**0 反向请求**；硬杀后 `session/load` 成功、`PINEAPPLE` 上下文保留（首字 2.1s），`session/close` 回 `-32601`。同批测出两个否定结论：图片在 ACP `prompt` 被丢弃（`images:false`）、`session/new.mcpServers` 不生效（MCP 走配置文件）。
- **微信真机 E2E（2026-10-31，已通过）**：文本消息/回复、多轮上下文、重启后 `session/load`（`PINEAPPLE`）、worker 任务均通过。状态行记 M0–M3 全部完成 ✅，M2 协议层无改动。
- **认证与模型（2026-10-31 真机）**：自定义 provider 由 `clineCredentialEnv()` 从 `providers.json` 派生 `CLINE_PROVIDER`/`CLINE_API_KEY`（显式 env 优先）；缺 `models.json` 时 `session/new` 回退 `gpt-4o`、第一条 prompt 报 `knows no model "gpt-4o"`，补齐 `models.json` 后修复（§3）。

---

## 7. 待实测

以下条目在本文中没有通过记录，来自状态行与 §5 中已明确标注的「假设 / 待实测」项：

- **同 agent 双 worker 的长时间并发样本**：本轮只跑过单任务与双 agent 并发，没跑同 agent 双 worker 的长时间样本；Cline 的会话库据其源码是 SQLite，长期并发风险**未验证**（§5 第 6 条）。
- **旧 session transcript 的实际落盘位置**：`real` 下是真实 `~/.cline/data/sessions/`，`sandbox` 下是 `<sandbox>/cline/data/sessions/`；来自 Cline 数据布局的**假设**，本轮未逐个文件核实（§5 第 7 条）。
- **升级 Cline 后重跑探针**：本文结论（含图片被丢弃、`session/new.mcpServers` 不生效、`session/close` 回 `-32601`）仅适用于 **3.0.74**（状态行），升级后需按 §2 重新验证。

---

## 8. 为什么不用 npx / 适配器？

- Cline **原生 ACP**，没有适配器需求；`cline-acp` 已归档，装它反而多一层 gRPC 桥。
- 对**必须用适配器**的 agent（claude-code / codex / pi），预设现在统一用**全局安装**的适配器二进制（`claude-agent-acp` / `codex-acp` / `pi-acp`），不再默认 `npx -y …`；但 daemon 是长期驻留进程，npx 的代价仍然是：
  - 每次 spawn 都可能访问 registry（离线/代理环境直接失败）；
  - 版本随上游漂移（同一个 `brain.json` 今天和明天跑的可能不是同一版）；
  - Windows 多一层 `npx.cmd` 包装，退出/信号传播更脆；
  - 冷启动更慢（`wemind brain check` 的 60s 更容易误报）。
- **推荐**：适配器类优先 `npm i -g <适配器包>`，让预设用全局二进制；npx 只作为「第一次试试」的路径。用 `wemind brain set <agent> --bin "<绝对路径>"` 固定下来。
