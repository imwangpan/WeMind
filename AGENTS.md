# AGENTS.md — WeMind 的 AI 协作者入口

> **最后核对**：2026-11-06 ｜ 本文档及全库文档描述当前分支的最新代码，不绑定已发布版本号 ｜ **维护约定**：改代码时同步本文件、全部相关文档与测试用例（硬性要求，见 §4.15）；不确定的结论标注「假设/待实测」。
>
> 这份文件写给 AI agent，也写给人。**首轮读 §0–§4**；已知坑、验收清单、单文件职责都按需查（链接在 §5）。不要一上来通读 `docs/repowiki/`。

---

## 0. 30 秒认识项目

WeMind 把**个人微信**变成 AI agent 的输入输出通道，对外有两种形态（**两个包都已发布到 npm**）：

| 形态         | 入口                                                                        | 谁长轮询                                                 | 谁生成回复                          | 协议           |
| ------------ | --------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------- | -------------- |
| ① MCP Server | `npx -y @wemind/wechat-mcp`（bin `wemind-mcp`）                             | MCP 客户端（Claude Desktop / Cursor / OpenCode / kiro…） | 客户端 agent                        | MCP over stdio |
| ② daemon     | `npm i -g @wemind/cli` → 命令 **`wemind`**（源码 `packages/wechat-daemon`） | daemon 自己                                              | daemon 调常驻 **ACP agent**（大脑） | ACP over stdio |

两种形态共享 `@wemind/wechat-ilink-core`（iLink 协议内核，`private`，构建时内联进两个发布包）。

> **硬约束（单实例收消息）**：同一个 bot token 同时只能有**一个程序收消息**（同一份登录凭证不能同时被两个程序长轮询）；形态①和②不能同时跑，否则互相抢消息/回环。
>
> **命名硬约束**：包名 `@wemind/cli` ≠ 命令名 `wemind`（`bin` 决定命令）。`npx` 按包名解析，只能 `npx -y @wemind/cli`，不能 `npx wemind`。

---

## 1. 阅读顺序

1. 本文 §0–§4。
2. [`docs/ai/README.md`](docs/ai/README.md) — 术语、数据流、事实状态表、**按任务的源码地图**。
3. [`docs/repowiki/02-系统架构.md`](docs/repowiki/02-系统架构.md) — 三包协作与进程模型。
4. 需要时：[`docs/ai/代码地图.md`](docs/ai/代码地图.md)（单文件职责）、[`已知坑`](docs/ai/已知坑.md)、[`验收清单`](docs/ai/验收清单.md)、[`recipes/`](docs/ai/recipes/)。

---

## 2. 仓库地图

```text
packages/
  wechat-ilink-core/    iLink HTTP 客户端、类型、错误码、会话守卫、账号/状态、收发图加解密（私有，不发布）
  wechat-mcp/           MCP server，6 个工具（已发布到 npm，bin: wemind-mcp）
  wechat-daemon/        常驻 daemon + ACP 大脑 + worker + CLI（发布包 @wemind/cli，命令 wemind）
docs/
  README.md             全库文档总索引（按读者与主题分组；新增/移动文档后必须同步）
  repowiki/             完整技术 wiki（人读；AI 可按需检索）
  ai/                   AI 上下文包 + 代码地图 + 任务配方 + 术语表（先读这里）
  接入方案/              9 篇各 agent 实测 + 1 篇通用接入指南（`接入其它-ACP-Agent.md`）
  使用指南/              新手教程、速查、远程任务使用指南
  部署与运维/            daemon 常驻原理、跨平台常驻 pm2
  设计文档/              历史：方案 C 总设计 / MVP / CLI 化设计；现行：文档守卫设计（已实施）
  机制与协议说明/        本地双入口文件桥（现行机制 + 2026-06/2026-10 演进记录，正文标注现行口径）
  待办与后续计划/        暂缓项（非历史：描述的是当前行为与未做的改进）
  审查与质量记录/        历史：2026-11-02 全局审查快照、2026-11-04 归档清单、2026-11-05 源码目录重构方案（设计稿，未实施）、2026-11-05 审计经验
  发布与变更记录/        发版手册、CHANGELOG
scripts/                常驻外壳（run-daemon.ps1 / pm2）、doctor、发布守卫（prepack-guard / check-version）、文档守卫（doc-impact / check-agent-docs / gen-docs-tables）
.worktrees/             git worktree 检出目录（每分支一个子目录；不入库；约定见 §4.16）
```

> 约 35 个关键文件的职责见 [`docs/ai/代码地图.md`](docs/ai/代码地图.md)；按任务找代码见 [`docs/ai/README.md`](docs/ai/README.md) §6。

---

## 3. 常用命令

```powershell
npm run build / typecheck / test / lint
npm run verify       # 提交前统一自检（CI 同口径：含三个文档守卫 + 相对链接）
npm run doc-impact / doc-impact:check / check:agent-docs / docs:tables / docs:tables:check   # 文档守卫
wemind login --label 名 --start / list / start|stop <key|label>
wemind brain / brain check / brain switch <agent> [--worker] / brain handoff
wemind brain set <agent> --extra-args "…"   # 只追加参数；--args 是整段替换，漏掉 ACP 模式参数会握手超时
wemind session list|new|resume|rename|delete / task-list|task-reply|task-stop
node packages/wechat-daemon/dist/cli.js brain   # 从源码跑等价命令
pwsh -NoProfile -File scripts/check-docs.ps1    # 检查 Markdown 相对链接
```

完整命令（自动生成：22 个 CLI 子命令 + 16 条微信指令）见 [`README.md`](README.md)「命令一览」；首次使用/环境不确定先跑 [`scripts/doctor.ps1`](scripts/doctor.ps1)。

---

## 4. 不可违背的约束（改代码前必读）

> 每条末尾的**守卫**标注：哪份测试/脚本能自动发现这条被违反。标「未覆盖」的只能靠评审。守卫文件都在 `packages/wechat-daemon/src/*.test.ts` 或 `scripts/`。

1. **单实例收消息**：同一个 bot token 同时只能有一个程序收消息；MCP 形态与 daemon 形态二选一；brain 的 MCP 沙箱永久禁止 `wechat`（防它把消息发回自己）；**按名字之外还按定义判**——改名条目只要 command/args/url 里跑 `wemind-mcp` 或 `@wemind/wechat-mcp` 同样被拒（`isWechatMcpServer()`，brain 与 worker 共用）。agent 自己配置文件里的微信 MCP 也在此约束内：DSH 的 `cordis.patch.yml` 复制进沙箱前剔除并告警（真实文件不动，`stripWechatMcpEntries`）。**守卫**：`agent-mcp.test.ts`、`sandbox-*.test.ts`。
2. **ACP 是最小方法集，不是「所有 agent 都一样」**：
   - `session/load` 不是通用能力；DSH 只有 `session/resume`，缺失时退化为 `session/new`。
   - **image / restore / mcpViaAcp 来自 `brain-agents.ts` 的配置字段，不来自 `initialize` 回包**（`acp-brain.ts` 从不解析 `agentCapabilities`）。接新 agent 必须人工跑一次 `scripts/acp-probe.mjs` 并把结论写进预设。
   - 反向请求统一走 `acp-reverse.ts`（brain / worker / `brain check` 三处共用）：权限默认拒绝，未知 method 回 `-32601`；可信部署设 `WEMIND_ACP_AUTO_ALLOW=1` 只放行一次性权限。三处必须共用同一实现，否则会「微信能跑、`brain check` 超时」。**守卫**：`acp-reverse.test.ts`、`brain-agents.test.ts`。
3. **brain 是一个 ACP 进程、worker 是 N 个（进程池）**：帧处理/超时/模型与模式等协议细节在 `acp-connection.ts`（两边共用，改一处两边生效）；生命周期与会话持久化各自实现（`acp-brain.ts` 常驻 + `brain-sessions.json`；`worker-acp.ts` 每连接实例 + `worker-sessions.json`），改这些要两边看。**守卫**：`acp-connection.test.ts`、`acp-switch.test.ts`、`worker-pool.test.ts`。
4. **MCP 按 agent 分派**：kiro 读 `settings/mcp.json`；opencode 读 `opencode.json` 的 `mcp.servers`；qoder 读 `settings.json` 的 `mcpServers`；gemini 读 `<沙箱>/.gemini/settings.json` 的 `mcpServers`；cline 读沙箱 `cline/mcp.json`；pi 读沙箱根 `mcp.json`（kiro 格式）；DSH 与 Claude Code 走 ACP `session/new` 的 `mcpServers`（Claude Code 的目录是真实 `~/.claude.json`；codex 的适配器不消费 stdio MCP）。**不要让 A 读 B 的配置文件**。**守卫**：`sandbox-*.test.ts`、`agent-mcp.test.ts`。
5. **微信连发上限约 10 条**，进度消息占额度，按最终答案到达时间分三档：`<5s` 只发答案、`5–15s` 第 5s 发「收到」、`≥15s` 第 5s「收到」+ 第 15s 第二条（正文已开始→「整理回复」，否则→「还在处理中」；之后不再补第三条固定提示）。工具/心跳/图片/重试提示算已有进度，顶替 5s 确认；第 15s 第二条要求距上一条非确认进度 ≥5s，否则跳过（不延后）；最终发送或失败时取消定时器。工具步骤优先用 agent 给的 purpose，否则从 `rawInput` 取 command/路径/query 截 60 字。`index.ts` 的 15s 心跳在无 activity 帧时持续发，接入 committed-only agent 要单独处理。**守卫**：`send-pipeline.test.ts`、`index.test.ts`、`daemon-routing.test.ts`。
6. **Windows `.cmd`/`.bat` 必须经 shell**：统一用 `spawnAgent()`，不要直接 `spawn(bin,args,{shell:true})`（DEP0190 + 注入面）。`spawnAgent` 在 Windows 上给子进程设 `NoDefaultCurrentDirectoryInExePath=1`，禁止从**任务 cwd** 解析裸命令名（防同名 `.cmd` 劫持）。**守卫**：`spawn-agent.test.ts`。
7. **数据按账号隔离**：默认 `~/.wemind/<账号>/`；不跨账号共用 `brain-sessions.json` / `brain-home`。**一个账号一个 daemon、各有自己的「登录者」**（扫码登录它的那个微信号；账号之间无隶属关系）：换大脑是账号级，微信侧只有登录者能切**它自己**那个 daemon，本机 CLI 可用 `key|label` 指定任意账号。**守卫**：`brain-config.test.ts`、`cli-context.test.ts`；跨账号共用靠评审。
8. **切换大脑写入磁盘用 `wemind brain set`**；`WEMIND_BRAIN*` 是一次性覆盖，不要写进 profile。**守卫**：`brain-config.test.ts`、`cli-dispatch.test.ts`。
9. **不要把密钥写进 agent/源码**；`DEEPSEEK_API_KEY` 等由 daemon 进程环境提供。**守卫**：未覆盖。
10. **注释按段落换行，不按行宽折行**：一段一行（多长都不手工断开），语义分段才另起一行；列表项/标题/代码围栏/分隔线/用法表/独立命令行各自成行，「标签：内容」行（`用法：`/`退出码：`/`注意：`）另起一行；缩进保留（它表达层级）。`oxfmt` 不重排注释，别把英文注释按 120 列折回来。**守卫**：未覆盖。
11. **控制桥只接受「agent 名 + 纯数据」**：`control-bridge.ts` 的请求字段只有 `target`（agent 名）/`ref`/`name`/`page`/`expiresAt`（CLI 等待截止，过期不执行），**没有也不可能有 `bin`/`args`/`shell`**——伪造请求最坏只能「选一个已装的 agent 或清掉自己的会话」。请求/应答 id 只允许 `[A-Za-z0-9._-]`（不含 `..`/盘符）：它直接拼成 `control-out/<id>.json`，不校验就能借 `../` 覆盖账号数据。`wemind brain set` 带 `--bin/--args/--extra-args/--shell/--model` 时**不走桥**（只写磁盘；其中 `--bin`/`--args`/`--extra-args`/`--model` 可用随后的 `wemind brain switch <同名 agent>` 当场应用——`sameAgent()` 按 name/bin/args/model 判，`--shell` 只能重启），这是刻意的边界，不要拆。**守卫**：`control-bridge.test.ts`。
12. **「当前是哪个会话」的唯一权威是 `brain-sessions.json`**；`session-registry.json` 只是派生元数据（名字/标题/轮次），写失败只记日志、**不得**抛出拖垮回合。`恢复会话` 是**严格恢复**：load/resume 都失败就如实报错、**不回退新建、不改当前会话记录**（宁可报错，不要「假恢复」）；恢复后的模型设置失败只记日志。**守卫**：`acp-switch.test.ts`、`session-manager.test.ts`、`session-map.test.ts`、`session-registry.test.ts`。
13. **任务侧的两条持久化纪律**：① 结束**在等你回复**的任务时进程**留着复用**（空闲回收交给池）；**正在跑**的那条被结束时只能力杀（ACP 回合无法优雅取消）；`wemind stop`/daemon 退出杀光整池。② `tasks.json` 只用于「重启后续跑」——**不自动 spawn**、**不做历史归档**（聊天记录本身就是归档）；未完成的标「已中断」，用户回「继续」才续跑。切换大脑时**持久化放最后**（成功才写 `brain.json`），失败退回无需撤销。**守卫**：`task-store.test.ts`、`task-manager.test.ts`、`worker-pool.test.ts`、`acp-switch.test.ts`。
14. **优先「用」agent，而不是「改造」它**：模型/MCP/权限/会话/技能优先用 agent 自己的配置与接口（`session/set_config_option`、`mcpServers`、CLI 参数），WeMind 只选择、传值与编排；没有开关才写适配层，并写清「补的是它的哪个缺口」。判断标准：**调用已有能力，还是替它发明？** 沙箱（`BRAIN_HOME`/`WORKER_HOME`）是隔离手段，镜像真实配置按原样复制；但 MCP 视图（brain 默认空 + 按需加载，worker 全量且**永远排除 `wechat`**）是安全边界，不因这条放松。**守卫**：未覆盖。
15. **改代码必须同一次改完三件套：代码 + 测试 + 文档**。任何行为/接口/命令/参数/环境变量/配置字段/数据文件结构/日志文案的变化都在**同一个提交**里补齐：
    - **测试**：正常路径 + 失败/边界路径；改既有语义就同步改断言；至少 `npm test` 全绿。
    - **文档**：用户向（`README.md`、`docs/使用指南/*`、`packages/*/README.md`——随包发布，改 CLI/环境变量必须同步）；技术向（`docs/repowiki/*`、`docs/接入方案/接入-*.md`）；AI 向（本文件、`docs/ai/README.md`、已知坑、验收清单、`recipes/`、术语表、`docs/README.md`、`llms.txt`）。命令/参数/环境变量/数据文件/目录结构/新增模块/新增文档的变化，**本文件与 `docs/ai/README.md` 必须同步**（两者标注的「最后核对」也要改）；新增/移动文档必须同步 `docs/README.md` 与 `llms.txt`。
    - **自检**：`npm run verify`（与 CI 同口径）。`npm install` 会启用 `.githooks/pre-commit`。
    - 反例（按缺陷处理）：改参数没更新 `--help`/README；新环境变量只写在代码注释；改了行为却没有覆盖它的测试；只跑 lint/test 漏 `format:check`。
    - **守卫**：`npm run doc-impact:check`、`scripts/check-agent-docs.mjs`、`scripts/gen-docs-tables.mjs --check`（自身用例在 `scripts/doc-guards.test.mjs`）；「有没有为这次行为写测试」没有自动检查，靠评审。
16. **worktree 一律放仓库根 `.worktrees/`**：每个分支一个子目录（如 `.worktrees/gemini`），不要建在其它位置；合并或放弃后 `git worktree remove <路径>` + `git branch -d <分支>`，不留残留。**守卫**：未覆盖。

---

## 5. 文档索引

- **全库总索引**：[`docs/README.md`](docs/README.md)（找不着某篇先看这里）
- **AI 上下文**：[`docs/ai/README.md`](docs/ai/README.md) · [`代码地图`](docs/ai/代码地图.md) · [`已知坑`](docs/ai/已知坑.md) · [`验收清单`](docs/ai/验收清单.md) · [`术语表`](docs/ai/术语表.md) · [`recipes/`](docs/ai/recipes/)
- **维护与发布**：[`如何发布新版本`](docs/发布与变更记录/如何发布新版本.md)（两个包，唯一发版手册）
- **用户文档**：[新手教程](docs/使用指南/新手教程.md) · [数据目录与环境变量速查](docs/使用指南/速查-数据目录与环境变量.md)
- **架构与接入**：[系统架构](docs/repowiki/02-系统架构.md) · [ACP 大脑与沙箱](docs/repowiki/06-ACP-大脑与沙箱.md) · [接入其它 ACP Agent](docs/接入方案/接入其它-ACP-Agent.md) · [文档守卫设计](docs/设计文档/文档守卫设计.md)
- **机器可读索引**：[`llms.txt`](llms.txt)

---

> **给 AI 的最后一句**：本仓库的文档总体质量高，但「通用 ACP 说法」不等于「当前 agent 的事实」。改 ACP 相关代码前，先用 `initialize` 看 capabilities，再用一次真实 prompt 验证，不要只信文档。
