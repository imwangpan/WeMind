# AGENTS.md — WeMind 的 AI 协作者入口

> **最后核对**：2026-11-14 ｜ 本文档及全库文档描述当前分支的最新代码，不绑定已发布版本号 ｜ **维护约定**：改代码时同步本文件、全部相关文档与测试用例（硬性要求，见 §4.15）；不确定的结论标注「假设/待实测」。
>
> 这份文件写给 AI agent，也写给人。**首轮读 §0–§4**；已知坑、验收清单、单文件职责都按需查（链接在 §5）。不要一上来通读 `docs/repowiki/`。

---

## 0. 30 秒认识项目

WeMind 把**个人微信**变成 AI agent 的输入输出通道，对外有两种形态（**两个包都已发布到 npm**）：

| 形态         | 入口                                                                        | 谁长轮询                                                 | 谁生成回复                          | 协议           |
| ------------ | --------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------- | -------------- |
| ① MCP Server | `npx -y @wemind/wechat-mcp`（bin `wemind-mcp`）                             | MCP 客户端（Claude Desktop / Cursor / OpenCode / kiro…） | 客户端 agent                        | MCP over stdio |
| ② daemon     | `npm i -g @wemind/cli` → 命令 **`wemind`**（源码 `packages/wechat-daemon`） | daemon 自己                                              | daemon 调常驻 **ACP agent**（大脑） | ACP over stdio |

两种形态共享 `@wemind/wechat-ilink-core`（iLink 协议内核，`private`，**JIT 源码包**：入口直接指向 `src/*.ts`，工作区内无需预构建；发布时由 tsdown 内联进两个发布包）。

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
  wechat-ilink-core/    iLink HTTP 客户端、类型、错误码、会话守卫、账号/状态、收发图加解密（私有，JIT 源码包，无 dist；不发布）
  wechat-mcp/           MCP server，6 个工具（已发布到 npm，bin: wemind-mcp）
  wechat-daemon/        常驻 daemon + ACP 大脑 + worker + CLI（发布包 @wemind/cli，命令 wemind）
    src/                入口 cli.ts / index.ts + 8 个一级目录（按需再分二级）
      daemon/           消息路由、控制指令、收件箱；messaging/ 外发管线与回复
      acp/              常驻大脑、热切换、自检；protocol/ 连接层与反向请求
      agents/           预设/配置/状态/槽位；config/ 账号级 direct/sandbox、overlay/工作区；sandbox/ MCP 策略与沙箱
      tasks/            任务表、worker 客户端与进程池
      sessions/         会话指令、登记表（store/view）、交接
      cli/              参数解析/分派、账号与进程生命周期；subcommands/ 主题命令
      ipc/              控制桥、指令表与解析
      shared/           通用工具；process/ 进程身份与 spawn，io/ 原子写与日志
docs/
  README.md             全库文档总索引（按读者与主题分组；新增/移动文档后必须同步）
  repowiki/             完整技术 wiki（人读；AI 可按需检索）
  ai/                   AI 上下文包 + 代码地图 + 任务配方 + 术语表（先读这里）
  接入方案/              9 篇各 agent 实测 + 1 篇通用接入指南（`接入其它-ACP-Agent.md`）
  使用指南/              新手教程、速查、远程任务使用指南
  部署与运维/            daemon 常驻原理、开机自启（现行）、跨平台常驻 pm2
  设计文档/              历史：方案 C 总设计 / CLI 化设计；现行：文档守卫设计、源码目录分层设计、远程任务 human-in-the-loop 设计与实现、wemind 接入 Agent 工作模式设计与实现
  机制与协议说明/        本地双入口文件桥（现行机制 + 2026-06/2026-10 演进记录，正文标注现行口径）
  待办与后续计划/        暂缓项（非历史：描述的是当前行为与未做的改进）
  审查与质量记录/        历史：2026-11-02 全局审查快照、2026-11-04 归档清单、2026-11-05 审计经验
  发布与变更记录/        发版手册、CHANGELOG
scripts/                常驻外壳（run-daemon.ps1 默认薄壳 / -Mode shell 旧循环）、pm2、doctor、发布守卫（prepack-guard / check-version）、文档守卫（doc-impact / check-agent-docs / gen-docs-tables）
.worktrees/             git worktree 检出目录（每分支一个子目录；不入库；约定见 §4.16）
```

> 约 35 个关键文件的职责见 [`docs/ai/代码地图.md`](docs/ai/代码地图.md)；按任务找代码见 [`docs/ai/README.md`](docs/ai/README.md) §6。

---

## 3. 常用命令

```powershell
npm run build / typecheck / test / lint   # build 只打两个发布包（先 typecheck core）；core 无 build/dist
npm run verify       # 提交前统一自检（CI 同口径：含三个文档守卫 + 相对链接）
npm run doc-impact / doc-impact:check / check:agent-docs / docs:tables / docs:tables:check   # 文档守卫
wemind login --label 名 --start / list / start|stop <key|label>
wemind log [key|label] [--lines N] [--errors] [--file N]   # daemon.log 尾部（全量日志；--errors 筛错误+前后 2 行上下文、--file 看轮转）
wemind start --all | <key1> <key2>…      # 启动所有 / 指定的多个账号（原生自启触发时用 --all）
wemind autostart install|status|uninstall [--key <key>|--label 名]   # 开机自启：装/看/卸
pwsh -File scripts/run-daemon.ps1 [-All | -Account <key>] [-Mode shell] [-DryRun]   # 源码外壳：默认转 wemind start；-Mode shell 为旧循环
wemind brain / brain check / brain switch <agent> [--worker] / brain handoff
wemind brain set <agent> --extra-args "…"   # 只追加参数；--args 是整段替换，漏掉 ACP 模式参数会握手超时
wemind config show / home-mode / reload / agent / wechat   # 模式、真实配置、微信独享 overlay
wemind mcp list|enable|disable|add|remove   # 仅 sandbox 的 brain 激活集；direct 下聊天指令转给 Agent（CLI 只提示改 Agent 配置）
wemind workspace show|set|reset [--role brain|worker]   # 默认工作区；新会话生效
wemind env capture|show|clear   # 非敏感环境快照（PATH/代理/locale）
wemind session list|new|resume|rename|delete / task-list|task-reply|task-stop
node packages/wechat-daemon/dist/cli.js brain   # 从源码跑等价命令
pwsh -NoProfile -File scripts/check-docs.ps1    # 检查 Markdown 相对链接
```

完整命令（自动生成：28 个 CLI 子命令 + 21 条微信指令）见 [`README.md`](README.md)「命令一览」；首次使用/环境不确定先跑 [`scripts/doctor.ps1`](scripts/doctor.ps1)。

---

## 4. 不可违背的约束（改代码前必读）

> 每条末尾的**守卫**标注：哪份测试/脚本能自动发现这条被违反。标「未覆盖」的只能靠评审。守卫文件都在 `packages/wechat-daemon/src/**/*.test.ts` 或 `scripts/`。

1. **单实例收消息**：同一个 bot token 同时只能有一个程序收消息；MCP 形态与 daemon 形态二选一；**WeMind 自己生成的 brain / worker MCP 集（`sandbox`）**永久禁止 `wechat`（防它把消息发回自己）；**按名字之外还按定义判**——改名条目只要 command/args/url 里跑 `wemind-mcp` 或 `@wemind/wechat-mcp` 同样被拒（`isWechatMcpServer()`，brain 与 worker 共用）。DSH 的 `cordis.patch.yml` 复制进沙箱前按投递方式处理：`mcpDelivery: "acp"` 时剥离**全部** MCP 条目，否则只剔除微信条目并告警（真实文件不动，`stripAllDshMcpEntries` / `stripWechatMcpEntries`）。`direct` 完全按 Agent 真实配置运行，发现微信 MCP 时**只告警、不阻止启动**（`warnForbiddenNativeMcp`）；用户需自行移除，否则可能形成第二个 poller/回环。**守卫**：`agent-mcp.test.ts`、`sandbox-*.test.ts`、`config.test.ts`。
2. **ACP 是最小方法集，不是「所有 agent 都一样」**：
   - `session/load` 不是通用能力；DSH 只有 `session/resume`，缺失时退化为 `session/new`。
   - **image / restore / `acpMcpServers` / `mcpDelivery` 来自 `agents/brain-presets.ts` 的配置字段，不来自 `initialize` 回包**（`acp-brain.ts` 从不解析 `agentCapabilities`）。接新 agent 必须人工跑一次 `scripts/acp-probe.mjs` 并把结论写进预设。
   - Copilot CLI 原生 ACP 但不参与 `AUTO_PROBE_ORDER`（安装不代表已登录）；其 stdio MCP 探针实测可用，即使 `initialize` 只声明 HTTP/SSE；图片能力仍依赖模型实测。
   - 反向请求统一走 `acp-reverse.ts`（brain / worker / `brain check` 三处共用）：权限**默认 yolo**（无人值守，自动选 `allow_once` / `allow_always`，不放宽 Agent 自己的沙箱）；要恢复逐次拒绝设 `WEMIND_ACP_AUTO_ALLOW=0`；未知 method 回 `-32601`。三处必须共用同一实现，否则会「微信能跑、`brain check` 超时」。**守卫**：`acp-reverse.test.ts`、`brain-agents.test.ts`。
3. **brain 是一个 ACP 进程、worker 是 N 个（进程池）**：帧处理/超时/模型与模式等协议细节在 `acp-connection.ts`（两边共用，改一处两边生效）；生命周期与会话持久化各自实现（`acp-brain.ts` 常驻 + `brain-sessions.json`；`worker-acp.ts` 每连接实例 + `worker-sessions.json`），`session-cwd.json` 另记 `<agent>:<sessionId> → cwd`，恢复旧会话时优先使用。默认 `direct` 下 Agent 的真实会话库由 Agent 自己管理、与终端共用；`sandbox` 才按账号隔离。WeMind 只维护“微信当前用哪条 session”的指针。改这些要两边看。**守卫**：`acp-connection.test.ts`、`brain-switch.test.ts`、`worker-pool.test.ts`、`config.test.ts`。
4. **MCP 按 agent 分派**：kiro 读配置根的 `settings/mcp.json`；opencode 读 `opencode.json` 的 `mcp.servers`；qoder 读 `settings.json` 的 `mcpServers`；gemini 读 `<配置根>/.gemini/settings.json` 的 `mcpServers`；cline 读配置根的 `cline/mcp.json`；pi 读配置根 `mcp.json`（kiro 格式）；DSH 读 `profiles/<profile>/cordis.patch.yml` 的 `@deepseek-ai/dsh-mcp-client` 条目；Claude Code / Copilot / Codex 分别由自己读 `~/.claude.json` / `~/.copilot/mcp-config.json` / `~/.codex/config.toml`。**这些都是 Agent 的原生来源，`direct` 下 WeMind 不再经 ACP 重发 catalog**，只在用户显式配置 `overlay.mcp.extra` 时补微信独享项。`acpMcpServers` 只声明「接受 ACP mcpServers」的能力；`mcpDelivery: "acp"` 只在 `sandbox` 托管 MCP 时使用（`brain` 按激活集、`worker` 按全量集，均排除 `wechat`）。DSH profile YAML 与 Codex TOML 都**只读**解析（`agents/sandbox/dsh-mcp.ts` / `toml-mcp.ts`）用于列出/指标/微信检测，绝不写回；原生配置里的 `wechat` 只告警（`warnForbiddenNativeMcp`），不阻止启动。**格式知识集中在 `agents/sandbox/mcp-adapters.ts` 的 `McpAdapter`**（路径/读/写/剥离/ACP 转换/原生只读/设置继承）；新增 agent 先复用或新增 adapter，不要在 `mcp-sandbox.ts` / `worker-sandbox.ts` 里按 agent 名或格式加分支。`direct` 不注入 `homeEnvVar`、daemon 启动/运行期不自动写配置（用户显式 `wemind config agent ...` 时写并备份），配置根就是 Agent 真实 home（Codex 始终 `~/.codex`）；`sandbox` 下配置根是 `brain-home`/`worker-home/<configSubdir>`。**不要让 A 读 B 的配置文件**。`direct` 下 WeMind **只读真实配置**（`canWriteAgentConfig()` 恒 false；`加载/卸载` 不拦截、原样转给 Agent 处理）；要 WeMind 托管 MCP 用 `sandbox`。**守卫**：`sandbox-*.test.ts`、`parity-direct.test.ts`、`mcp-adapters.test.ts`、`agent-mcp.test.ts`、`config.test.ts`、`toml-mcp.test.ts`、`dsh-mcp.test.ts`。
5. **微信连发上限约 10 条**，文本进度/图片/文件/视频占额度（**结构化工具 item 不占**：它们不是用户可见消息，计入会让可见消息没发几条就误报「接近上限」），按最终答案到达时间分三档：`<5s` 只发答案、`5–15s` 第 5s 发「收到」、`≥15s` 第 5s「收到」+ 第 15s 第二条（正文已开始→「整理回复」，否则→「还在处理中」；之后不再补第三条固定提示）。工具/心跳/图片/重试提示算已有进度，顶替 5s 确认；第 15s 第二条要求距上一条非确认进度 ≥5s，否则跳过（不延后）；最终发送或失败时取消定时器。工具步骤优先用 agent 给的 purpose，否则从 `rawInput` 取 command/路径/query 截 60 字；开始时发 `🔧 步骤 N 开始：…`，**工具耗时 ≥10s 才补发 `✅ 步骤 N 完成：…`**（短工具只留开始一条，避免刷屏/占额度）；**默认发文本「步骤 N」**，设 `WECHAT_TOOL_PROGRESS_ITEMS=1` 才发结构化 item（`TOOL_CALL_START=11` / `TOOL_CALL_RESULT=12`，用 `FINISH` + 本回合 `run_id`，对齐官方 2.4.10；**微信客户端目前不渲染，故默认关闭**），item 发送失败回退文本（**回退文本按可见消息计一条额度**：`sendItemOrdered` 的 `onFallback` 在文本确实发出后才补记账；不可见 item 不顶替 5s 确认/15s 第二条、不刷新其基线，额度到 `limit-2` 时干脆不发 item，免得回退文本挤占留给最终答案的最后一条；决策在纯函数 `planProgressEmission`）。**每张图片、每个文件/视频也各占一条连发额度**。`index.ts` 的 15s 心跳在无 activity 帧时持续发，接入 committed-only agent 要单独处理。**守卫**：`send-pipeline.test.ts`、`send-item.test.ts`、`index.test.ts`、`daemon-routing.test.ts`、`acp-connection.test.ts`。
6. **Windows `.cmd`/`.bat` 必须经 shell**：统一用 `spawnAgent()`，不要直接 `spawn(bin,args,{shell:true})`（DEP0190 + 注入面）。`spawnAgent` 在 Windows 上给子进程设 `NoDefaultCurrentDirectoryInExePath=1`，禁止从**任务 cwd** 解析裸命令名（防同名 `.cmd` 劫持）。**守卫**：`spawn-agent.test.ts`。
7. **数据按账号隔离，Agent 真实配置按单机共享**：默认 `~/.wemind/<账号>/`，不跨账号共用 `brain-sessions.json`、`worker-sessions.json`、`agent-overrides/`、`workspace.json`、`brain-mcps.json`、`media/` 与任务/控制桥。`direct` 下 Agent 的真实配置、技能、记忆、会话库是**同一 OS 用户的共享基线**；`sandbox` 模式的 `brain-home` / `worker-home` 才按账号隔离。**一个账号一个 daemon、各有自己的「登录者」**（扫码登录它的那个微信号；账号之间无隶属关系）：换大脑是账号级，微信侧只有登录者能切**它自己**那个 daemon，本机 CLI 可用 `key|label` 指定任意账号。**守卫**：`brain-config.test.ts`、`cli-context.test.ts`、`config.test.ts`；跨账号共用靠评审。
8. **切换大脑写入磁盘用 `wemind brain set`**；`WEMIND_BRAIN*` 是一次性覆盖，不要写进 profile。**守卫**：`brain-config.test.ts`、`cli-dispatch.test.ts`。
9. **不要把密钥写进 agent/源码**；`DEEPSEEK_API_KEY` 等由 daemon 进程环境提供。**守卫**：未覆盖。
10. **注释按段落换行，不按行宽折行**：一段一行（多长都不手工断开），语义分段才另起一行；列表项/标题/代码围栏/分隔线/用法表/独立命令行各自成行，「标签：内容」行（`用法：`/`退出码：`/`注意：`）另起一行；缩进保留（它表达层级）。`oxfmt` 不重排注释，别把英文注释按 120 列折回来。**守卫**：未覆盖。
11. **控制桥只接受「agent 名 + 纯数据」**：`control-bridge.ts` 的请求字段只有 `target`（agent 名）/`ref`/`name`/`page`/`expiresAt`（CLI 等待截止，过期不执行），**没有也不可能有 `bin`/`args`/`shell`**——伪造请求最坏只能「选一个已装的 agent 或清掉自己的会话」。请求/应答 id 只允许 `[A-Za-z0-9._-]`（不含 `..`/盘符）：它直接拼成 `control-out/<id>.json`，不校验就能借 `../` 覆盖账号数据。`wemind brain set` 带 `--bin/--args/--extra-args/--shell/--model` 时**不走桥**（只写磁盘；其中 `--bin`/`--args`/`--extra-args`/`--model` 可用随后的 `wemind brain switch <同名 agent>` 当场应用——`sameAgent()` 按 name/bin/args/model 判，`--shell` 只能重启），这是刻意的边界，不要拆。**守卫**：`control-bridge.test.ts`。
12. **「当前是哪个会话」的唯一权威是 `brain-sessions.json`**；`session-registry.json` 只是派生元数据（名字/标题/轮次），写失败只记日志、**不得**抛出拖垮回合。`恢复会话` 是**严格恢复**：load/resume 都失败就如实报错、**不回退新建、不改当前会话记录**（宁可报错，不要「假恢复」）；恢复后的模型设置失败只记日志。恢复时使用 `session-cwd.json` 里记录的 cwd，找不到才回落到当前默认工作区；不把旧会话静默搬到新工作区。**守卫**：`brain-switch.test.ts`、`session-manager.test.ts`、`session-map.test.ts`、`session-registry.test.ts`、`config.test.ts`。
13. **任务侧的两条持久化纪律**：① 结束**在等你回复**的任务时进程**留着复用**（空闲回收交给池）；**正在跑**的那条被结束时只能力杀（ACP 回合无法优雅取消）；`wemind stop`/daemon 退出杀光整池。② `tasks.json` 只用于「重启后续跑」——**不自动 spawn**、**不做历史归档**（聊天记录本身就是归档）；未完成的标「已中断」，用户回「继续」才续跑。切换大脑时**持久化放最后**（成功才写 `brain.json`），失败退回无需撤销。**守卫**：`task-store.test.ts`、`task-manager.test.ts`、`worker-pool.test.ts`、`brain-switch.test.ts`。
14. **优先「用」agent，而不是「改造」它**：模型/MCP/权限/会话/技能优先用 agent 自己的配置与接口（`session/set_config_option`、`mcpServers`、CLI 参数），WeMind 只选择、传值与编排；没有开关才写适配层，并写清「补的是它的哪个缺口」。判断标准：**调用已有能力，还是替它发明？** 默认 `homeMode=direct`：完全按 Agent 真实配置运行，daemon 启动/运行期不自动写 Agent 文件（用户显式 `wemind config agent ...` 时写并备份）；`sandbox`（`BRAIN_HOME`/`WORKER_HOME`）是显式隔离选项，由 WeMind 维护 curated MCP 激活集（brain 默认空 + 按 agent 持久激活；worker 真实全量且**永远排除 `wechat`**）。**守卫**：未覆盖。
15. **改代码必须同一次改完三件套：代码 + 测试 + 文档**。任何行为/接口/命令/参数/环境变量/配置字段/数据文件结构/日志文案的变化都在**同一个提交**里补齐：
    - **测试**：正常路径 + 失败/边界路径；改既有语义就同步改断言；至少 `npm test` 全绿。
    - **文档**：用户向（`README.md`、`docs/使用指南/*`、`packages/*/README.md`——随包发布，改 CLI/环境变量必须同步）；技术向（`docs/repowiki/*`、`docs/接入方案/接入-*.md`）；AI 向（本文件、`docs/ai/README.md`、已知坑、验收清单、`recipes/`、术语表、`docs/README.md`、`llms.txt`）。命令/参数/环境变量/数据文件/目录结构/新增模块/新增文档的变化，**本文件与 `docs/ai/README.md` 必须同步**（两者标注的「最后核对」也要改）；新增/移动文档必须同步 `docs/README.md` 与 `llms.txt`。
    - **自检**：`npm run verify`（与 CI 同口径）。`npm install` 会启用 `.githooks/pre-commit`。
    - 反例（按缺陷处理）：改参数没更新 `--help`/README；新环境变量只写在代码注释；改了行为却没有覆盖它的测试；只跑 lint/test 漏 `format:check`。
    - **守卫**：`npm run doc-impact:check`、`scripts/check-agent-docs.mjs`、`scripts/gen-docs-tables.mjs --check`（自身用例在 `scripts/doc-guards.test.mjs`）；「有没有为这次行为写测试」没有自动检查，靠评审。
16. **worktree 一律放仓库根 `.worktrees/`**：每个分支一个子目录（如 `.worktrees/gemini`），不要建在其它位置；合并或放弃后 `git worktree remove <路径>` + `git branch -d <分支>`，不留残留。**守卫**：未覆盖。
17. **开机自启（`wemind autostart`）的三条边界**：① 系统触发器只执行 `start` / `daemon`，**绝不执行 `autostart install`**（登录时再跑一遍安装会递归）；② Windows 触发器跑 `wemind start --all`，重拉交给内置 watchdog；Linux systemd / macOS launchd **本身就是 supervisor**，单元必须跑 `wemind daemon`（前台常驻）——跑 `start` 会被判「服务已退出」并无限重拉；③ 启动器（`start` / `login --start` / pm2 / watchdog）一律经 `launcherEnv()` 构造子进程环境：**丢弃 `WECHAT_DATA_DIR`**、强制 `WECHAT_ACCOUNT`；`wemind daemon` 直跑保留该变量的一次性覆盖语义。源码外壳 `scripts/run-daemon.ps1` 默认是 cli 薄壳（转 `wemind start`，因此同样丢弃该变量）；只有 `-Mode shell` 直接跑 `cli.js daemon`，保留覆盖语义。检测到 PM2 时优先用 PM2（实例名 `wemind-<key>`；Windows 另装登录任务 `wemind-autostart-pm2` 跑 `start --all --runner pm2`），没有才装系统触发器；两套并存时必须人工确认后只留一套。**Windows 的 PowerShell 解析走共享 `resolvePowerShell()`**（`shared/process/powershell.ts`）：优先系统自带的 Windows PowerShell 5.1（固定路径，不依赖 PATH），缺失时回退 PATH 上的 `pwsh`，两者都没有才降级 Run 键。进程身份查询共用它，Windows 输出按 `WEMIND|<pid>|<base64(UTF-8)>` 编码（绕开 PS 5.1 控制台代码页）；身份判定是三态 `ours/other/unknown`：查询失败不当成「没有别的实例」——`start` 与 watchdog 单实例守卫 fail-closed（拒绝启动），`stop` 不杀且保留 pid 文件，`wemind list` 显示「无法确认」。**守卫**：`launcher-env.test.ts`、`autostart.test.ts`、`windows-autostart.test.ts`、`pm2-detector.test.ts`、`run-daemon-script.test.ts`、`powershell.test.ts`、`proc-identity.test.ts`。
18. **消息 ID 是 uint64，全程按字符串处理**：`message_id` / `msg_id` / `svr_id` 超过 JS 安全整数（如 `7525055299038555000`），直接 `JSON.parse` / `Number()` / `>` 比较会丢精度、把相邻消息当成同一条。core 的 `parseJsonWithLosslessIds` 在解析前给这些字段加引号；游标与去重只用 `compareMessageIds` / `maxMessageId` / `rememberMessageId`。`ServerState.lastMessageId` 是字符串，`seenMessageIds` 是最近 200 条的去重环；读旧版数字游标时要 `normalizeMessageId`；MCP `get_messages` 与 daemon 两侧都用同一套 `seenMessageIds` 去重环（防同批/服务端重放）。**守卫**：`message-id.test.ts`、`client.test.ts`、`account.test.ts`、`messages.test.ts`。
19. **入站媒体的落盘与出站附件边界**：图片走 ACP image block；文件/视频/无转写语音下载解密后：`direct` 存 `<账号>/media/inbound`，`sandbox` 存 `<sandbox>/media/inbound`（默认保留 30 天、总量 1GB；启动时清理，之后每次写入入站媒体时检查、至少间隔 1 小时才真正清理，目录 0700 / 文件 0600），prompt 里给绝对路径；有微信转写的语音直接当文本、不再下载，**也不进 `attachments`**（否则语音里的「结束任务」「继续」会被挡在快车道/任务续跑外）。出站文件/视频只认 brain 显式写出的 `[附件](file:///绝对路径)` / `[文件](...)` / `[视频](...)`（路径含 `)` 用 `<...>`），读取前必须过 realpath、敏感文件 denylist（`account.json`/`state.json`/`.env`/密钥/控制桥与任务目录，以及各 agent 的登录态：`.credentials.json/.yaml`、`.auth/`、`oauth_creds.json`、`providers.json`，以及 `media/`、`brain-home`/`worker-home` **和各 preset `realHome`** 下的 `settings.json`/`models*.json` 等）和单文件大小上限（默认 25MB）；**拒绝 UNC/网络路径**（`\\server\share`、`file://host/...`，包括软链接/junction 解析后的目标）与 **Windows NTFS 数据流后缀**（`account.json::$DATA` 会让 basename 规则失效），**不要**改成扫描普通链接；没有附件链接时正文必须原样返回（不 trim、不压缩空行，避免改动 Markdown 代码块），普通形式遇到 `(` 或 `<` 整段保留为正文。需要临时外发敏感文件时，登录者发微信指令 `允许敏感文件 [分钟]`（默认 2 分钟、上限 30，仅本 daemon 进程内生效，重启即失效）：**先开窗再让大脑发，或附件被拦下后回这条指令直接补发**都行（被拦下的路径在内存里保留 30 分钟）。窗口内只跳过敏感名单，UNC/数据流/大小上限照旧，放行会在日志里注明。硬链接无法从路径区分（realpath 指向同一 inode），属于已接受的风险。带附件的消息一律进大脑队列，快车道（控制/任务指令）不处理附件。**守卫**：`attachments.test.ts`（含与 `brain-presets` 的 `credentialFiles` 对齐检查）、`sensitive-allow.test.ts`、`media-store.test.ts`、`voice.test.ts`、`index.test.ts`。
20. **core 是 JIT 源码包（source-first），不要给它加回构建步骤**：`packages/wechat-ilink-core/package.json` 的 `main`/`types`/`exports` 全部指向 `./src/index.ts`，没有 `build` 脚本、没有 `dist/`；workspace 内 tsc / Vitest / tsdown / tsx 直接使用源码，clone 后 `npm test`、`npm run typecheck` 不需要先构建任何包。两个发布包的 `tsconfig.json` 必须保持 `noEmit: true`（`tsc -p` 若 emit，会产出按包名 import core 的文件，在 JIT 下加载不到源码）；产物只由 tsdown 生成，`deps.alwaysBundle` 必须包含 core，且 `failOnWarn: true` 把「core 被 external」从 warning 升级为失败；`scripts/prepack-guard.mjs` 会扫描 `files` 覆盖的 `.js/.mjs/.cjs`，发现 `@wemind/*` 裸 import 就拒绝发布。两个 bin 包目前都 `dts: false`（没有包 import 它的类型）；若将来要开 dts，JIT 下不能用默认 tsconfig——tsdown 的 tsgo 生成器要求显式 `tsconfig`，且需把 `core/src` 纳入 `include` 并把 `rootDir` 指到 `packages/`，否则报 `tsgo did not generate dts file`。纯 Node 不能直接跑 `src/*.ts`（Node 不做 `.js` → `.ts` 映射）：源码运行用 `tsx`（`npx tsx packages/wechat-daemon/src/cli.ts …`），或先 `npm run build` 再 `node dist/cli.js`。**两个发布包都开 `sourcemap: true`**，`dist/*.js.map` 随包，`prepack` 守卫检查 `.map` 存在且被 `files` 覆盖。**Node 默认不应用 sourcemap，且实测在模块加载后调 `process.setSourceMapsEnabled(true)` / `module.setSourceMapsSupport(true)` 对已加载模块无效**（同步与异步错误的 stack 都不映射），所以不靠 Node 的运行时开关：由 core 的 `stack-map.ts` 在错误出口自己读同目录的 `.map`（`node:module` 的 `SourceMap`，零依赖），把堆栈里的 `cli.js:NNNN` 改写成 `src/xxx.ts:NN`。接入点固定为 CLI 三个 fatal 出口、daemon 的 `uncaughtException`/`unhandledRejection` 与业务循环四处（`poller error` / `fast command error` / `handleMessage error` / `save state failed`）、MCP 的 `main().catch` 加 `unhandledRejection`/`uncaughtException` 两个只记日志不退出的钩子，统一走 `describeError(err, import.meta.url)`；map 与产物同一次构建、同一目录，版本天然配对，用户零配置且所有启动方式（watchdog / pm2 / 开机自启 / 前台直跑）通用。map 缺失、解析失败或查不到一律原样返回，绝不影响主流程；想让 Node 连我们没打印的栈也映射，可另加 `NODE_OPTIONS=--enable-source-maps`（可选，非必需）。管理命令的 fatal 输出用 `log.child("cli")` 打印 `[wemind/wechat-daemon/cli][ERROR] Error: …`（级别已标在 `[ERROR]`，调用点不要再带 `error:` 字面量造成 `[ERROR] error:` 重复；与 daemon 本体 / `…/watchdog` 同构，标明同一产物里的第三个入口分支；打到用户终端，**不进 daemon.log**），也不要在调用点自己拼 `[wemind/...]` 前缀。**守卫**：`stack-map.test.ts`（正常/失败/边界）、`scripts/core-entry.test.mjs`（两包都开 map + 错误出口都接了 describeError + cli 前缀）、`scripts/prepack-guard.test.mjs`（`.map` 缺失拒绝）。**两个输出出口（2026-11-11 收敛）**：运行日志一律走 core 的 `createLogger(scope).info/warn/error/debug`，格式 `[wemind/<scope>][INFO|WARN|ERROR|DEBUG] …`、全部 stderr（WARN 用 `console.warn`，其余 `console.error`），**前缀与级别全部由 logger 生成，调用点一律不自带 `[wemind/...]`**（watchdog 直接写 `RotatingLog` 的几行经 `wrapperLine()` 走同一格式）。注意 Node 的 `console.log/info/debug` 都走 stdout、只有 `warn/error` 走 stderr，所以 `console.error` 在这里只是「写到 stderr」的出口、不代表内容是错误；级别是写进文本的语义，不是分流 stdout/stderr——watchdog 会把两条管道合并进同一个 `daemon.log`，分流后信息落盘即丢还会乱序；MCP 的 stdout 是 JSON-RPC 帧通道不能写日志。`debug` 为预留级别（当前无调用点），`WEMIND_LOG_LEVEL=debug` 才输出。CLI 用户输出（命令结果/二维码/交互问答）走 stdout 的 `print()`，**纯文本、零前缀零级别**，CI 装包冒烟与 readline 都依赖它，不要改成 logger。`wemind log --errors` 精确认 `[ERROR]/[WARN]` 标记，升级前的旧日志按关键词兼容。守卫：`logging.test.ts`、`cli-log.test.ts`。

> **日志与错误定位的三个边界（2026-11-11 审查修复）**：① `stack-map.ts` 按**完整路径**认自己的产物——npm 全局安装 / npx 的路径含 `node_modules` 同样映射，同名的第三方文件不误伤；不要再用目录名启发式。② `run-daemon.ps1 -Mode shell` 直接写 `daemon.log` 的包装行也必须带 `[INFO]/[WARN]/[ERROR]`（否则 `--errors` 认不出「大脑配置错误」「连续崩溃」）。③ 回调式组件（`SendPipeline` / task 与 control 收件箱 / `AcpHost`）的日志第一参数是级别，不要整块绑成 `log.info`。守卫：`stack-map.test.ts`、`run-daemon-script.test.ts`、`leveled-log.test.ts`。

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
