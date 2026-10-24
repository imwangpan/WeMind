# AGENTS.md — WeMind 的 AI 协作者入口

> **适用版本**：WeMind 1.0.1 ｜ **最后核对**：2026-10-24 ｜ **维护约定**：改代码时同步本文件；不确定的结论标注「假设/待实测」。
>
> 这份文件写给 AI agent，也写给人。**先读这里，再按链接深入**；不要一上来通读整个 `docs/repowiki/`。

---

## 0. 30 秒认识项目

WeMind 把**个人微信**变成 AI agent 的输入输出通道，对外有两种形态：

| 形态 | 入口 | 谁长轮询 | 谁生成回复 | 协议 |
|---|---|---|---|---|
| ① MCP Server | `@wemind/wechat-mcp`（bin `wemind-mcp`） | MCP 客户端（Claude Desktop / Cursor / OpenCode / kiro…） | 客户端 agent | MCP over stdio |
| ② daemon | `wemind`（`packages/wechat-daemon`） | daemon 自己 | daemon 调常驻 **ACP agent**（大脑） | ACP over stdio |

两种形态共享 `@wemind/wechat-ilink-core`（iLink 协议内核）。

> **硬约束**：同一个 bot token **只能有一个消费者**。形态①和形态②不能同时跑，否则互相抢消息/回环。

---

## 1. 10 分钟阅读顺序

1. 本文。
2. [`docs/ai/README.md`](docs/ai/README.md) — 术语、数据流、事实状态表。
3. [`docs/repowiki/02-系统架构.md`](docs/repowiki/02-系统架构.md) — 三包协作与进程模型。
4. 按任务读代码：
   - 换/接 ACP 大脑 → `packages/wechat-daemon/src/brain-agents.ts` → `acp-brain.ts` → `mcp-sandbox.ts`；
   - 消息/回复/图片 → `packages/wechat-daemon/src/index.ts` → `md-reply.ts` / `image-reply.ts`；
   - 远程任务 → `task-manager.ts` → `worker-acp.ts` → `worker-sandbox.ts`；
   - CLI/账号 → `cli.ts` / `manage.ts` / `brain-config.ts`。
5. 任务配方：[`docs/ai/recipes/`](docs/ai/recipes/)。

---

## 2. 仓库地图

```text
packages/
  wechat-ilink-core/    iLink HTTP 客户端、类型、错误码、会话守卫、账号/状态、收发图加解密（私有，不发布）
  wechat-mcp/           MCP server，6 个工具（已发布到 npm，bin: wemind-mcp）
  wechat-daemon/        常驻 daemon + ACP 大脑 + worker + CLI（未发布，bin: wemind）
docs/
  repowiki/             完整技术 wiki（人读；AI 可按需检索）
  ai/                   AI 上下文包 + 任务配方（先读这里）
 接入-*.md              各 agent 的接入设计/实测
scripts/                daemon wrapper、pm2、doctor、冒烟脚本
```

关键文件：

| 文件 | 职责 |
|---|---|
| `packages/wechat-daemon/src/index.ts` | 消息路由、回合编排、进度节流、brain/worker 分流 |
| `packages/wechat-daemon/src/acp-brain.ts` | 常驻 ACP 客户端（对话大脑） |
| `packages/wechat-daemon/src/worker-acp.ts` | 常驻 ACP 客户端（任务 worker，独立进程） |
| `packages/wechat-daemon/src/brain-agents.ts` | `ACP_AGENT_PRESETS`、`resolveAgent()`、`agentProblem()` |
| `packages/wechat-daemon/src/mcp-sandbox.ts` | brain 沙箱、MCP 激活集、记忆/技能继承 |
| `packages/wechat-daemon/src/worker-sandbox.ts` | worker 沙箱（继承全量 MCP，排除 wechat） |
| `packages/wechat-daemon/src/spawn-agent.ts` | 统一 spawn（Windows `.cmd` 经 shell + 逐参数引号） |
| `packages/wechat-daemon/src/brain-check.ts` | `wemind brain check` 的真 ACP 握手 |
| `packages/wechat-daemon/src/manage.ts` | `wemind` 子命令实现 |
| `packages/wechat-mcp/src/tools/*` | 6 个 MCP 工具 |

---

## 3. 常用命令

```powershell
npm run build        # core → daemon/mcp
npm run typecheck
npm test             # vitest
npm run lint
npm run daemon       # 直接起 daemon（需已构建）
node packages/wechat-daemon/dist/cli.js brain        # 查看当前大脑
node packages/wechat-daemon/dist/cli.js brain check  # 真机 ACP 握手
pwsh -NoProfile -File scripts/check-docs.ps1         # 检查 Markdown 相对链接
```

> 首次使用/环境不确定：先跑 [`scripts/doctor.ps1`](scripts/doctor.ps1)。

---

## 4. 不可违背的约束（改代码前必读）

1. **一个 token 一个消费者**：MCP 形态与 daemon 形态二选一；brain 的 MCP 沙箱永久禁止 `wechat`（防回环）。
2. **ACP 是最小方法集，不是「所有 agent 都一样」**：
   - `session/load` 不是通用能力；DSH 只有 `session/resume`，缺失时会退化为 `session/new`；
   - `initialize.agentCapabilities` 决定 image / MCP / load / resume；不要假设；
   - agent 可能发反向请求（`session/request_permission`、`fs/*`、`terminal/*`）。`acp-brain.ts` / `worker-acp.ts` 已内置应答器：权限请求默认拒绝，未知 method 回 `-32601`；可信部署可设 `WEMIND_ACP_AUTO_ALLOW=1` 放行一次性权限。
3. **brain 与 worker 是两个独立 ACP 进程、两套 session**：协议改动要同步 `acp-brain.ts` 和 `worker-acp.ts`。
4. **MCP 按 agent 分派**：kiro 读 `settings/mcp.json`；opencode 读 `opencode.json` 的 `mcp.servers`；DSH 走 ACP `session/new` 的 `mcpServers`。**不要让 A 读 B 的配置文件**。
5. **微信有连发上限（约 10 条）**：进度消息会占额度；`index.ts` 的 15s 心跳在「无 activity 帧」时会持续发，接入 committed-only agent 要单独处理。
6. **Windows `.cmd`/`.bat` 必须经 shell**：统一用 `spawnAgent()`，不要直接 `spawn(bin,args,{shell:true})`（DEP0190 + 注入面）。
7. **数据按账号隔离**：默认 `~/.wemind/<账号>/`；不要跨账号共用 `brain-sessions.json` / `brain-home`。
8. **切换大脑落盘用 `wemind brain set`**；环境变量 `WEMIND_BRAIN*` 是一次性覆盖，不要写进 profile。
9. **不要把密钥写进预设/源码**；`DEEPSEEK_API_KEY` 等由 daemon 进程环境提供。

---

## 5. 「改哪里」速查

| 任务 | 从这里开始 |
|---|---|
| 新增 ACP agent 预设 | `brain-agents.ts` 的 `ACP_AGENT_PRESETS`；按 [`docs/ai/recipes/add-acp-agent.md`](docs/ai/recipes/add-acp-agent.md) |
| 改 ACP 协议/自愈/超时 | `acp-brain.ts` + `worker-acp.ts`（两边同步） |
| 加/改 MCP 注入 | `mcp-sandbox.ts` / `agent-mcp.ts` / `worker-sandbox.ts`；按 [`docs/ai/recipes/add-mcp.md`](docs/ai/recipes/add-mcp.md) |
| 改微信消息处理/回复 | `index.ts`、`md-reply.ts`、`image-reply.ts` |
| 加 CLI 子命令 | `cli.ts`（注册）+ `manage.ts`（实现） |
| 改数据目录/账号 | `wechat-ilink-core/src/store/*`、`brain-config.ts` |
| 排查 daemon 不回复 | [`docs/ai/recipes/debug-daemon.md`](docs/ai/recipes/debug-daemon.md) |
| 跑端到端验收 | [`docs/ai/recipes/run-e2e.md`](docs/ai/recipes/run-e2e.md) |

---

## 6. 已知坑 / 文档漂移（2026-10-24 已核对）

- **默认大脑不是 kiro**：未配置时是 `auto`，按 `kiro → opencode → gemini → deepseek` 探测；落盘配置在 `<数据目录>/brain.json`。
- **DeepSeek 已内置预设**：官方 DSH `dsh --profile acp`；桌面端通常要用 `wemind brain set deepseek --bin "<...>\dsh.cmd"` 落绝对路径，并依赖 `DSH_HOME` 沙箱里的 `.credentials.yaml`（从 `~/.dsh` 同步）。微信 E2E 已通过。详见 [`docs/接入-DeepSeek.md`](docs/接入-DeepSeek.md)。
- **「无需改代码」有边界**：只对满足「有 `session/load`、不发反向请求、首帧快、MCP 走配置文件」的 agent 成立。DSH 不满足，但已用预设字段 + M2 适配补齐。
- **仓库没有 `Brain` 接口（刻意）**：ACP agent 本身就是大脑边界；目前只有 ACP 一种实现，抽接口只会增加间接层。等真的要做「裸 API 大脑」时再抽 `ask/newSession/restart` 契约，并同步 `index.ts` 调用方。
- **`wemind brain check` 默认 60s**：冷启动慢的 agent 仍可能误报；这是已知项，不要把它当「agent 不可用」的唯一证据。
- **`onPath()` 按精确文件名**：只有 `dsh.cmd` 没有无扩展名 `dsh` 时，`binWin` 必须写 `dsh.cmd`。
- **DSH 0.2.1-rc.2 实测**：无 `session/load`（`-32601`）、`image:false`（带图 `-32602`）、有 `session/resume`；**resume 后多轮上下文保留**（PINEAPPLE，含 `taskkill /T /F` 强杀）；stdio/HTTP MCP 可用；会发 `agent_thought_chunk`/`tool_call`/`usage_update`；stdout 会混入非 JSON 日志行（解析器要容错）。
- **DSH 模型路由是坑**：`session/new` 默认 `deepseek-official`（需 `DEEPSEEK_API_KEY`）；桌面登录态对应 `deepseek-account`，必须用 `session/set_config_option { configId:"model", value:'["deepseek-account","deepseek-flash"]' }` 显式切换，否则报 `no API key`。
- **节点版本**：仓库声明 Node ≥20；DSH CLI 需要 ≥22（本机 Node 24 可用）。

---

## 7. 验证标准（别只看「代码写完」）

| 改动 | 最低验证 |
|---|---|
| 纯逻辑 | `npm run typecheck` + `npm test` |
| 预设/沙箱 | `wemind brain` + `wemind brain check` + 单测 |
| ACP 协议 | 冒烟：`initialize → session/new → prompt → update`；重建后 `load/resume`；无未应答反向请求 |
| 消息/回复 | 真机微信一条消息 → `daemon.log` 出现 `prompt ok` → 收到回复 |
| MCP | `加载 <名>` → 下条消息生效；`wechat` 仍被禁止 |
| worker | 派发任务 → 中断 → 回「继续」→ 能续上 |

日志前缀：`[wemind/wechat-daemon]`、`.../acp`、`.../worker`、`.../task`、`.../watchdog`、`.../wrapper`。

---

## 8. 文档索引

- AI 上下文包：[`docs/ai/README.md`](docs/ai/README.md)
- 任务配方：[`docs/ai/recipes/`](docs/ai/recipes/)
- 项目概览：[`docs/repowiki/01-项目概览.md`](docs/repowiki/01-项目概览.md)
- 系统架构：[`docs/repowiki/02-系统架构.md`](docs/repowiki/02-系统架构.md)
- ACP 大脑与沙箱：[`docs/repowiki/06-ACP-大脑与沙箱.md`](docs/repowiki/06-ACP-大脑与沙箱.md)
- 接入其它 agent：[`docs/接入其它-ACP-Agent.md`](docs/接入其它-ACP-Agent.md)
- OpenCode 接入实测：[`docs/接入-OpenCode.md`](docs/接入-OpenCode.md)
- DeepSeek 评估与实测：[`docs/接入-DeepSeek.md`](docs/接入-DeepSeek.md)
- DeepSeek 后续待办（M3–M5）：[`docs/待办-DeepSeek-M3-M5.md`](docs/待办-DeepSeek-M3-M5.md)
- 机器可读索引：[`llms.txt`](llms.txt)

---

> **给 AI 的最后一句**：本仓库的文档总体质量高，但「通用 ACP 说法」不等于「当前 agent 的事实」。改 ACP 相关代码前，先用 `initialize` 看 capabilities，再用一次真实 prompt 验证，不要只信文档。
