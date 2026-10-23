# 配方：接入一个新的 ACP Agent

> **适用版本**：WeMind 1.0.1 ｜ **最后核对**：2026-10-24
>
> 目标：把一个新的 agent CLI 变成 daemon 的「大脑」（以及 worker）。本文是操作清单，不是架构说明；架构见 [`docs/repowiki/06-ACP-大脑与沙箱.md`](../../repowiki/06-ACP-大脑与沙箱.md)。

---

## 0. 先别改代码：跑一次能力探针

用 [`scripts/acp-probe.mjs`](../../../scripts/acp-probe.mjs) 真起一个进程，回答 6 个问题：

1. `initialize.agentCapabilities` 有什么？（`loadSession` / `sessionCapabilities.resume` / `image` / `mcp`）
2. `session/new` 能不能成功？返回哪些 `configOptions`？
3. `session/prompt` 首帧多久？`session/update` 出现哪些类型？正文分几个 chunk？
4. 有没有 `session/request_permission` 之类的**反向请求**？
5. kill 后 `session/load` / `session/resume` 能不能恢复？
6. 非空 `mcpServers` 能不能被接受？带图 prompt 能不能被接受？

示例（DSH）：

```powershell
$env:ACP_BIN = "D:\Users\imwan\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
$env:ACP_ARGS = '["--profile","acp"]'
$env:ACP_SHELL = "1"
$env:ACP_HOME_ENV = "DSH_HOME"
$env:ACP_HOME = "$env:TEMP\dsh-probe-home"   # 测试用；真实凭据见下
$env:ACP_MODEL = '["deepseek-account","deepseek-flash"]'  # DSH 必须；否则默认 official 路由要 API key
$env:ACP_PROMPT = "Reply with exactly: OK"
$env:ACP_HARD_KILL = "1"   # 模拟 WeMind 自愈：不 close，直接杀进程再 resume
node scripts/acp-probe.mjs
```

> 真实凭据：把 `~/.dsh/.credentials.yaml` 复制到 `ACP_HOME`（不要打印内容），或用 `DEEPSEEK_API_KEY`。

### 决策门

| 探针结果 | 结论 |
|---|---|
| 全部符合 WeMind 现有假设 | 加预设即可（kiro/opencode 路线） |
| 无 `session/load`，有 `resume` | 加 `restore: "resume"` + 客户端兜底 |
| 有反向请求 | 先做 M2 应答器，否则会挂到超时 |
| `image:false` | 在 `askBrain` 前拦截图片，或换支持图片的 agent |
| 正文非逐 token | 调 `firstFrameMs` + 心跳策略（见 M2） |
| `mcpServers` 被拒绝 | MCP 只能走该 agent 自己的配置文件，或先不做动态 MCP |
| 默认模型路由需要 API key / 桌面登录要切 account | 加 `model` 预设字段，并在 session 建立后 `session/set_config_option` |

---

## 1. 确认 4 件事

| # | 信息 | 说明 | 示例（DSH） |
|---|---|---|---|
| 1 | 二进制/路径 | PATH 名或绝对路径 | `dsh` / `dsh.cmd` |
| 2 | ACP 启动参数 | 进入 ACP server over stdio | `--profile acp` |
| 3 | 配置目录环境变量 | 该 agent 读取配置/数据目录的 env 名；WeMind 指向沙箱 | `DSH_HOME` |
| 4 | 配置目录布局 / MCP 格式 | `configSubdir`、`mcpFormat`、`mcpConfigFile`、`catalogFile` | 空 / ACP `mcpServers` |

> 如果第 4 项不是「某个 HOME + 文件式 MCP」，动态 MCP 注入需要单独适配；不要硬套 kiro 的 `settings/mcp.json`。

---

## 2. 加预设（`brain-agents.ts`）

```ts
acme: {
  name: "acme",
  bin: "acme-agent",
  binWin: "acme-agent.cmd",      // Windows 实际文件名；只有 .cmd 时必须写全
  args: ["serve", "--acp"],
  shell: true,                   // .cmd/.bat/npx 必须；.exe 可 false
  homeEnvVar: "ACME_HOME",       // 指向 BRAIN_HOME；没有就删掉
  realHome: path.join(os.homedir(), ".acme"),
  inheritDirs: ["skills"],       // 目录式记忆/技能
  inheritFiles: ["AGENTS.md"],   // 单文件记忆
  // 仅在探针证明需要时加：
  // restore: "resume",
  // firstFrameMs: 90_000,
  // heartbeatMs: 60_000,
  // mcpViaAcp: true,
},
```

同时：

- `AUTO_PROBE_ORDER` 末尾追加该预设（不要插到 kiro/opencode 前面，避免老用户被动换大脑）；
- `AcpAgentPreset` / `ResolvedAgent` 透传新字段；
- `brain-agents.test.ts` 加断言；
- `docs/接入其它-ACP-Agent.md` §5 预设表加一行。

---

## 3. 沙箱 / MCP / 记忆

- `homeEnvVar` 指向 `BRAIN_HOME`；`configSubdir` 决定配置目录在沙箱内的位置。
- `mcpFormat`：`kiro`（`mcpServers`）或 `opencode`（`mcp.servers`）；DSH 这类走 ACP 的用 `mcpViaAcp`，不要写文件。
- 记忆继承：`realHome` + `inheritDirs` / `inheritFiles`；单文件记忆（`AGENTS.md`、`CLAUDE.md`）用 `inheritFiles`。
- 默认空 MCP；`wechat` 永久禁止（防回环）。
- **每个 agent 只读自己的 catalog**；不要把 kiro 的文件指给 DSH。

验证：

```powershell
wemind brain set acme --restart
wemind brain
wemind brain check
```

---

## 4. 客户端能力适配（按探针结果）

| 探针结果 | 要改 |
|---|---|
| 无 `session/load`，有 `resume` | `acp-brain.ts` + `worker-acp.ts` 的 `ensureSession`：load → resume → new 兜底 |
| 有反向请求 | `handleFrame` 应答 `session/request_permission`；未知 method 回 `-32601` |
| 首帧慢 / 无 activity 帧 | 预设 `firstFrameMs`；`index.ts` 心跳/`heartbeatMs` |
| `image:false` | `index.ts` 收到图片时友好拒绝；不要让它 `-32602` 重试 |
| MCP 走 ACP | `session/new` / `session/resume` 传 `mcpServers`；catalog 按 agent 自己的来源 |

> `acp-brain.ts` 与 `worker-acp.ts` 是两份独立实现；**协议改动必须两边同步**，否则 brain 能跑、worker 挂。

---

## 5. 验收

```powershell
npm run build
npm run typecheck
npm test
wemind brain set acme --restart
wemind brain check
```

真机：

1. 发一条消息 → `daemon.log`：`spawn acme ... → initialized → session/new|resume → prompt ok`；
2. 杀 daemon 再起，追问上一轮 → 上下文还在（load 或 resume）；
3. 长任务 >30s → 不因首帧误杀；进度不刷屏；
4. 发图 → 按 image 能力正确处理；
5. 越界写 → 有权限请求则应答，不卡死；
6. 两个账号 → 沙箱隔离。

---

## 6. 常见坑

- **`onPath()` 按精确文件名**：只有 `.cmd` 时，`binWin` 写 `dsh.cmd` 而不是 `dsh`。
- **不要用 `spawn(bin, args, { shell: true })`**：用 `spawnAgent()`（DEP0190 + 引号）。
- **`wemind brain check` 默认 20s**：冷启动慢的 agent 可能误报；先看日志再判定不可用。
- **`session/load` 不是通用能力**：没有就退 `resume`，再没有就 `new`，并在日志里说清楚。
- **反向请求不应答 = 挂起**：哪怕回 `-32601` 也比沉默好。
- **committed-only + 15s 心跳 = 烧连发额度**：先调心跳，再考虑首帧。
- **密钥不要写进预设**：daemon 进程环境提供。

---

## 7. 参考

- [`docs/接入-OpenCode.md`](../../接入-OpenCode.md) — 原生 ACP 的实测样板
- [`docs/接入-DeepSeek.md`](../../接入-DeepSeek.md) — 缺 load、`image:false`、committed-only 的反例
- [`docs/接入其它-ACP-Agent.md`](../../接入其它-ACP-Agent.md) — 通用 ACP 指南
- [`scripts/acp-probe.mjs`](../../../scripts/acp-probe.mjs) — 能力探针
