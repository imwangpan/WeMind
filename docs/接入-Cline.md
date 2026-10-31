# 接入 Cline CLI（原生 ACP 实测）

> **状态**：M0 能力探针 **已完成 ✅** ｜ M1 agent + 沙箱 **已完成 ✅** ｜ M2 协议层 **无改动** ｜ M3 真机 E2E **部分完成**（ACP 侧已验；微信收发待真机）。
> **实测环境**：Windows 11 / Node 24 / **Cline CLI 3.0.74（npm 全局安装）** / WeMind 1.2.0。
> **最后核对**：2026-10-30 ｜ **分支**：`feat/cline-acp` ｜ 结论**仅适用于 cline 3.0.74**。
> **相关文档**：[接入其它-ACP-Agent.md](接入其它-ACP-Agent.md) · [ai/recipes/add-acp-agent.md](ai/recipes/add-acp-agent.md) · [接入-Qoder.md](接入-Qoder.md)（同款「配置目录指到子目录」样板） · [接入-OpenCode.md](接入-OpenCode.md)（文件式 MCP 样板）

---

## 0. TL;DR

- Cline CLI **原生支持 ACP**：`cline --acp`。社区适配器 [`cline-acp`](https://github.com/TonksThebear/cline-acp) 已在 2026-02 归档（作者原话：Cline now directly supports ACP），**不要再装适配器**。
- WeMind 预设：`cline` → `cline --acp --auto-approve true`，配置目录走 `CLINE_DIR`/`CLINE_DATA_DIR`/`CLINE_MCP_SETTINGS_PATH`，都指向沙箱的 `cline/` 子目录。
- **认证是唯一硬前置**：ACP 只自动恢复 Cline 自己的 3 种登录（`cline` / `cline-pass` / `openai-codex`）；用**自定义/API-key provider**（如 `openai-compatible`）时，WeMind 会**自动从 `providers.json` 读取** `lastUsedProvider` + `settings.apiKey`，转成 Cline 官方 ACP 环境变量 `CLINE_PROVIDER` + `CLINE_API_KEY`（父进程显式设了这两个变量时完全不接管）。没有可用的 apiKey（如 OAuth 条目）时才需要手工设置，否则 `session/new` 直接：

  ```text
  -32000 Authentication required: Call authenticate before starting a session
  ```

- 协议能力（3.0.74）：`loadSession:true`、`image:true`、`agent_thought_chunk` / `agent_message_chunk` / `session_info_update`、**0 反向请求**、硬杀后 `session/load` 能接回上下文；`session/close` ❌（`-32601`，WeMind 不调用）。
- **MCP 只能走配置文件**：Cline 收到 `session/new.mcpServers` 只存不用；预设用 `CLINE_MCP_SETTINGS_PATH` 指到 `<沙箱>/cline/mcp.json`（`{ "mcpServers": {…} }`，与 kiro 同格式）。

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

先在日常环境里跑 `cline auth` 完成登录；WeMind 会把 `providers.json` 同步进大脑/worker 沙箱。

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

- 自动读取发生在**每次 spawn**：改了 `cline auth` / `providers.json` 后，重启 daemon 或 `wemind brain switch cline` 会重新读取；正在运行的 ACP 子进程不会热更新。
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
| Q6 | 图片 / MCP | 带图 prompt 被接受（~10s，取决于模型）；`session/new` 的 `mcpServers` **不生效**（代码里只存进 session 对象，`buildConfig` 不再使用），MCP 走配置文件 |

结论：**协议层零改动**——默认 `restore: "load"`、`images: true`、默认首帧/心跳都够用；只要 agent + 沙箱。

---

## 3. 沙箱与预设

```ts
cline: {
  name: "cline",
  bin: "cline",
  binWin: "cline.cmd",              // npm 全局安装的 Windows shim；shell:true
  args: ["--acp", "--auto-approve", "true"],
  shell: true,
  env: {
    CLINE_DIR: `%HOME%/cline`,
    CLINE_DATA_DIR: `%HOME%/cline/data`,
    CLINE_MCP_SETTINGS_PATH: `%HOME%/cline/mcp.json`,
  },
  realHome: path.join(os.homedir(), ".cline"),
  inheritDirs: ["rules", "skills", "agents"],
  configSubdir: "cline",
  mcpFormat: "kiro",
  mcpConfigFile: "mcp.json",
  catalogFile: "data/settings/cline_mcp_settings.json",
  credentialFiles: ["data/settings/providers.json"],
  credentialEnv: clineCredentialEnv,   // 自定义 provider：从 providers.json 派生 CLINE_PROVIDER/KEY
}
```

要点：

- **配置目录指到 `<沙箱>/cline`，不用沙箱根**（与 Qoder 同理）：大脑的 `cwd` 就是 `BRAIN_HOME`，若 `CLINE_DIR` 也等于它，agent 自己的配置目录会和工作区重叠。`configSubdir: "cline"` 与三个 env 必须一致。
- `CLINE_DATA_DIR` 显式写成 `<CLINE_DIR>/data`（Cline 的默认值也是它），避免上游改默认值时沙箱漏到真实目录。
- **MCP 文件**：`CLINE_MCP_SETTINGS_PATH` 指到 `<沙箱>/cline/mcp.json`，WeMind 的 `applySandbox()` 写 `{ "mcpServers": {…} }`；目录来源读真实的 `~/.cline/data/settings/cline_mcp_settings.json`。**真实文件不被改动**。
  - 验证方式（不需要起 daemon）：`cline config mcp --json` 在设置 `CLINE_DIR`/`CLINE_DATA_DIR`/`CLINE_MCP_SETTINGS_PATH` 后能列出沙箱里的 server。
  - `wechat` 永久禁止；brain 默认空、按需 `加载 <名>`；worker 继承全量但排除 `wechat` 与 `disabled:true`。
- **登录态**：`data/settings/providers.json` 按「新者胜」同步（与 DSH `.credentials.yaml` 同策略）；自定义 provider 另由 `credentialEnv: clineCredentialEnv` 在 spawn 前从**真实** `~/.cline/data/settings/providers.json` 派生 `CLINE_PROVIDER`/`CLINE_API_KEY`（显式 env 优先）。**注意**：沙箱里 OAuth token 刷新不会写回真实文件，长期两条登录态可能漂移；用 API-key provider 或定期在日常环境 `cline auth` 可以规避。
- **记忆/技能**：`rules/`、`skills/`、`agents/` 以 junction（Windows）/ symlink 进沙箱，与日常 Cline 共用；`hooks/`、`plugins/` **不继承**（插件可自带 MCP，沙箱只允许 curated MCP）。
- **免审批**：`--auto-approve true` 是 Cline 官方 ACP 文档给的启动开关（`auto_approve` config 的启动默认值）。这与其它预设一致——但宿主应答器仍默认拒绝边缘权限请求，`WEMIND_ACP_AUTO_ALLOW=1` 才逐次放行。

### 3.1 模型

- `session/new` 的 `model` 来自 provider 设置（本机实测 `auto/dfmodel`）；也可显式覆盖：

  ```powershell
  wemind brain set cline --model "auto/deepseek-v4.1-flash"
  wemind brain switch cline    # daemon 在跑时应用
  ```

  WeMind 在会话建立/恢复后发一次 `session/set_config_option { configId: "model", value }`（Cline 的 configOption id 就是 `model`）。

---

## 4. 使用

```powershell
wemind brain set cline
wemind brain                 # 应显示 agent=cline、configSubdir=cline、model=…
wemind brain check           # 真握手；自定义 provider 会自动复用 providers.json 的 key
```

微信里：

```text
切换大脑 cline
任务 cline：把这个仓库的 README 里过期的版本号找出来
```

- **brain**：`CLINE_DIR=<账号>/brain-home/cline`，默认 MCP 空，`加载 <名>` 后写 `cline/mcp.json` 并重启 ACP 进程。
- **worker**：`CLINE_DIR=<账号>/worker-home/cline`，全量 MCP（除 `wechat`/`disabled`），同样走 `mcp.json`。
- **热切换**：`wemind brain switch cline` 会启动新 ACP 进程并等 `session/new` 成功后才写 `brain.json`；失败退回旧大脑。

---

## 5. 已知限制 / 待实测

1. **认证**：Cline ACP 只自动恢复 3 种 OAuth 登录；自定义/API-key provider 由 WeMind 从 `providers.json` 自动派生 `CLINE_PROVIDER`/`CLINE_API_KEY`（显式 env 优先）；OAuth 条目或文件不可用时才需要手动设置（见 §1.2）。
2. **`session/close` 不存在**（`-32601`）：WeMind 目前不调用它，杀进程即可；若未来加「优雅关闭」，要对 Cline 跳过。
3. **MCP 走 ACP 不支持**：`mcpViaAcp` 必须保持 `false`；改用 `CLINE_MCP_SETTINGS_PATH`。
4. **OAuth token 单向同步**：沙箱内刷新不会回写真实 `providers.json`（见 §3）。API-key provider 不受影响。
5. **微信真机 E2E 未做**：ACP 探针、沙箱单测、`cline config mcp` 已验证；「扫码登录 → 微信消息 → 回复」按 [run-e2e.md](ai/recipes/run-e2e.md) §2 补测。
6. **同 agent 并发**：两个 worker 共用 `<worker-home>/cline`（与其它 agent 相同）；Cline 的会话库是 SQLite，长期并发风险要观察。

---

## 6. 为什么不用 npx / 适配器？

- Cline **原生 ACP**，没有适配器需求；`cline-acp` 已归档，装它反而多一层 gRPC 桥。
- 对**必须用适配器**的 agent（claude-code / codex），WeMind 目前的 claude-code 预设用 `npx -y …` 图省事；但 daemon 是长期驻留进程，npx 的代价是：
  - 每次 spawn 都可能访问 registry（离线/代理环境直接失败）；
  - 版本随上游漂移（同一个 `brain.json` 今天和明天跑的可能不是同一版）；
  - Windows 多一层 `npx.cmd` 包装，退出/信号传播更脆；
  - 冷启动更慢（`wemind brain check` 的 60s 更容易误报）。
- **推荐**：适配器类优先 `npm i -g <适配器包>`，让预设用全局二进制；npx 只作为「第一次试试」的路径。用 `wemind brain set <agent> --bin "<绝对路径>"` 固定下来。
