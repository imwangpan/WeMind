# 配方：接入一个新的 ACP Agent

> **适用版本**：WeMind 1.2.0 ｜ **最后核对**：2026-10-28
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
$env:ACP_BIN = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"  # 按实际安装位置调整
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
| 全部符合 WeMind 现有假设 | 加 agent 即可（kiro/opencode 路线） |
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

> 如果第 4 项不是「某个 HOME + 文件式 MCP」，动态挂 MCP 需要单独适配；不要硬套 kiro 的 `settings/mcp.json`。

---

## 2. 加 agent（`brain-agents.ts`）

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
  // fallbackBinPaths: [path.join(os.homedir(), ".acme", "bin", "acme-agent")], // 官方安装不在 PATH
  // settingsBase: "settings.json",       // 以真实配置为基底（剥离 MCP/插件/providers/model、关自动更新）
  // credentialFiles: [".auth/user"],     // 登录态（新者胜）
  // identityFiles: [".auth/machine_id"], // 必须与真实目录一致（内容不同即覆盖）
},
```

同时：

- `AUTO_PROBE_ORDER` 末尾追加该 agent（不要插到 kiro/opencode 前面，避免老用户被动换大脑）；
- `AcpAgentPreset` / `ResolvedAgent` 透传新字段；
- `brain-agents.test.ts` 加断言；
- `docs/接入其它-ACP-Agent.md` §5 预设表加一行。

> **1.2.0 起，加 agent 不必再"挑角色"**：同一个 agent同时可用于对话大脑与任务 worker（`resolveAgentFor(cfg, role)`），加完立刻可以
> `wemind brain switch acme` 热切换、也可以在微信里 `任务 acme：…` 指定它干活——两者都不需要改代码、不需要重启。
> 启动覆盖（`--bin`/`--args`/`--shell`）按**agent 名**存在 `brain.json` 的 `presets` 段（`wemind brain set acme --bin …`），
> 所以「切走再切回」不会丢；默认任务大脑是 `worker.agent ?? agent`。

---

## 3. 沙箱 / MCP / 记忆

- `homeEnvVar` 指向 `BRAIN_HOME`；`configSubdir` 决定配置目录在沙箱内的位置。
- `mcpFormat`：`kiro`（`mcpServers`）或 `opencode`（`mcp.servers`）；DSH 这类走 ACP 的用 `mcpViaAcp`，不要写文件。
- 记忆继承：`realHome` + `inheritDirs` / `inheritFiles`；单文件记忆（`AGENTS.md`、`CLAUDE.md`）用 `inheritFiles`。
- 登录态：`credentialFiles`（新者胜）+ `identityFiles`（内容不同即覆盖）；`wemind brain check` 会自动复制进临时沙箱。
- 设置继承：`settingsBase` 会在 brain/worker 两个沙箱生成剥离后的基底（`mcpServers`/`enabledPlugins`/`providers`/`model` 全删，`general.enableAutoUpdate=false`）。
- 默认空 MCP；`wechat` 永久禁止（防它把消息发回自己）。
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
6. 两个账号 → 沙箱隔离；
7. **热切换**（1.2.0）：从别的预设 `wemind brain switch acme` → 答复两段、daemon pid 不变、下一条消息由 acme 答；再切回去，旧上下文能 load 回来；
8. **当 worker 用**（1.2.0）：`wemind task "…" --agent acme` → 任务跑通；跑完进程**留着复用**（`wemind list` 可见），5 分钟后回收。

---

## 6. 常见坑

- **`onPath()` 按精确文件名**：只有 `.cmd` 时，`binWin` 写 `dsh.cmd` 而不是 `dsh`。
- **不要用 `spawn(bin, args, { shell: true })`**：用 `spawnAgent()`（DEP0190 + 引号）。
- **`wemind brain check` 默认 60s**：冷启动慢的 agent 仍可能误报；先看日志再判定不可用。
- **`session/load` 不是通用能力**：没有就退 `resume`，再没有就 `new`，并在日志里说清楚。
- **反向请求不应答 = 挂起**：哪怕回 `-32601` 也比沉默好。
- **committed-only + 15s 心跳 = 烧连发额度**：先调心跳，再考虑首帧。
- **密钥不要写进预设**：daemon 进程环境提供。
- **能力字段是人工结论，不是自动适配**（1.2.0 仍未变）：`initialize` 的回包**不被解析**（只置 `initialized = true`），`image`/`restore`/`mcpViaAcp` 全部来自预设字段——所以探针必须看，看完必须写进 `brain-agents.ts`。
- **冷启动耗时待实测**：各 agent `initialize`/`session/new` 的真实耗时还没量（`docs/ai/recipes/run-e2e.md` §7.2 第 3 条）；若某 agent 超过 `REQ_TIMEOUT=30s`，需要在预设里加 `reqTimeoutMs`（**尚未实现**，先量再定）。
- **同 agent 并发 = 两个进程共用其配置目录**：多任务并行时会真实发生（不同 agent 各自 `configSubdir` 天然隔离）；新 agent 若把会话/缓存写在配置目录里，这条要实测。

---

## 7. 参考

- [`docs/接入-OpenCode.md`](../../接入-OpenCode.md) — 原生 ACP 的实测样板
- [`docs/接入-DeepSeek.md`](../../接入-DeepSeek.md) — 缺 load、`image:false`、committed-only 的反例
- [`docs/接入其它-ACP-Agent.md`](../../接入其它-ACP-Agent.md) — 通用 ACP 指南
- [`docs/repowiki/07-远程任务-Worker.md`](../../repowiki/07-远程任务-Worker.md) — worker 侧（进程池、任务表）对新 agent 的要求
- [`docs/ai/recipes/run-e2e.md`](run-e2e.md) — 验收分层与待实测清单
- [`scripts/acp-probe.mjs`](../../../scripts/acp-probe.mjs) — 能力探针
