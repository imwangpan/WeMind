# 配方：接入一个新的 ACP Agent

> **最后核对**：2026-11-05
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
$env:ACP_MODEL = '["<provider>","<model>"]'  # 可选覆盖；DSH 的真实默认请用 profile 里的 - id: acp（rc.3 已无 deepseek-account）
$env:ACP_PROMPT = "Reply with exactly: OK"
$env:ACP_TEST_IMAGE = "1"   # 第 6 问（带图 prompt 能否接受）→ 决定预设 images
$env:ACP_TEST_MCP = '[{"name":"fake","command":"node","args":["-e","0"],"env":[]}]'  # 第 6 问（mcpServers 能否被接受）→ 决定 mcpViaAcp
$env:ACP_HARD_KILL = "1"   # 模拟 WeMind 自愈：不 close，直接杀进程再 resume
node scripts/acp-probe.mjs
```

> **第 6 问的两个开关必须显式打开**：不设 `ACP_TEST_IMAGE` / `ACP_TEST_MCP`，探针不会带图、也不会传 `mcpServers`，你就永远答不出「`images` 该不该关」「`mcpViaAcp` 该不该开」——而这两项正是接新 agent 时最容易踩的两个坑。

> 真实凭据：把 `~/.dsh/.credentials.yaml` 复制到 `ACP_HOME`（不要打印内容），或用 `DEEPSEEK_API_KEY`。

### 决策门

| 探针结果 | 结论 |
|---|---|
| 全部符合 WeMind 现有假设 | 加 agent 即可（kiro/opencode 路线） |
| 无 `session/load`，有 `resume` | 加 `restore: "resume"` + 客户端兜底 |
| 有反向请求 | 应答器已在 `acp-reverse.ts`（brain / worker / `brain check` 共用），**一般无需再写**；只有在需要放行某类请求时才改那一处 |
| `image:false`（探针带图 prompt 被拒） | 预设加 `images: false`：`planImageTurn()` 按「有文字只按文字答、无文字才拒绝」处理，不会拿空 prompt 白问；漏到 `askBrainTurn` 也只附一句提示、不带图 |
| 正文非逐 token / 无 activity 帧 | 预设加 `firstFrameMs`（首帧超时）与 `heartbeatMs`（静默期心跳），见 §4 |
| `session/new` 先要求 `authenticate`（`-32000 Authentication required`） | 先看能否靠**复制凭据**自动恢复（`credentialFiles`；Cline 只自动恢复它自己的 3 种 OAuth provider）；不能就**从 agent 自己的配置派生环境变量**（`credentialEnv`，参考 Cline 的 `clineCredentialEnv()`：只读、显式 env 优先），或要求部署方提供 agent 官方文档里的环境变量。**不要**在 daemon 里实现交互式 `authenticate`——无头环境会卡在浏览器/输入上；把可执行的提示写进 `brain check` 与失败回复（参考 `authHint()`） |
| 默认模型路由需要 API key / 桌面登录要切 account | 加 `model` agent 配置字段：会话建立后走 `session/set_config_option`（agent 自己的接口）；`--model auto`/`default` = 跟随真实 profile 的默认（见下一行）；用户可用 `wemind brain set <名> --model …` 覆盖 |
| 默认模型由该 agent 自己的用户层 profile 维护（DSH 的 `profiles/<名>/cordis.patch.yml`） | 加 `realProfile` 字段：沙箱**原样复制**那份用户层（否则沙箱是空壳 `[]`、路由都不存在），并从它读默认模型（`profile-model.ts`：优先用户写的 `- id: acp`，否则 `agent-default-model`）；插件 bundle patch 里写死的默认**由用户在自己的 profile 里覆盖**，WeMind 只提示（`wemind brain` 给可粘贴的片段）、不代改（§4.14）——用户改桌面端默认后，重启 daemon 或切一次这个 agent 时跟着改 |

---

## 0.5 产出物清单（闭集，缺一不可）

接一个新 agent 必须同时产出下表 10 项。第 4–7 项由 `node scripts/check-agent-docs.mjs` 断言，其余由单测与审校覆盖。

| # | 产出物 | 位置 | 由谁检查 |
|---|---|---|---|
| 1 | 预设 | `brain-presets.ts` 的 `ACP_AGENT_PRESETS` | 单测 |
| 2 | 预设单测 | `brain-agents.test.ts` | `npm test` |
| 3 | 沙箱单测（涉及沙箱时） | `sandbox-<name>.test.ts` | `npm test` |
| 4 | 接入文档 | `docs/接入方案/接入-<Name>.md`，含 §0.6 的五类小节 + `## 待实测` | `check-agent-docs.mjs` |
| 5 | 通用表加一行 | `docs/接入方案/接入其它-ACP-Agent.md` §5 | `check-agent-docs.mjs` |
| 6 | 已知坑加一条 | [`docs/ai/已知坑.md`](../已知坑.md) | `check-agent-docs.mjs` |
| 7 | 全库索引 | `docs/README.md`「各 agent 实测」行 + `llms.txt` | `check-agent-docs.mjs` |
| 8 | AI 事实表 | `docs/ai/README.md` 事实状态表 | 人工 |
| 9 | 安装提示（适配器类） | `brain-agents.ts` 的 `ADAPTER_INSTALL_HINT` | 单测 |
| 10 | 探针记录 | 文档「探针实测结论」小节，每条标来源档位 | 人工审校 |

## 0.6 填空：能力结论与来源档位

每条能力结论必须标注来源（三选一），并显式列出未验证项。**不能把三者都写成「实测」**：

- `loadSession`：____（探针观测 / 源码核实 / 文档转述）
- `image`：____
- `mcpViaAcp`：____
- `session/set_mode`：____
- `replayOnLoad`：____
- 会话恢复方式（load / resume / 无）：____
- 未验证项：____（没有写「无」）

> 三档能证明的东西不同：**探针观测**只证明「这条消息能跑通、回了什么」；**源码核实**才能回答「它内部怎么处理」；**文档转述**只是上游作者声称的行为。2026-11-05 审计里所有「探针看不到的语义」发现都来自源码核实，没有一条来自探针。

---

## 1. 确认 4 件事

| # | 信息 | 说明 | 示例（DSH） |
|---|---|---|---|
| 1 | 二进制/路径 | PATH 名或绝对路径 | `dsh` / `dsh.cmd` |
| 2 | ACP 启动参数 | 进入 ACP server over stdio | `--profile acp` |
| 3 | 配置目录环境变量 | 该 agent 读取配置/数据目录的 env 名；WeMind 指向配置视图（`real`/`mirror`）或沙箱（`sandbox`） | `DSH_HOME` |
| 4 | 配置目录布局 / MCP 格式 | `configSubdir`、`mcpFormat`、`mcpConfigFile`、`catalogFile` | 空 / ACP `mcpServers` |

> 如果第 4 项不是「某个 HOME + 文件式 MCP」，动态挂 MCP 需要单独适配；不要硬套 kiro 的 `settings/mcp.json`。
>
> **适配器类 agent（CLI 本身不实现 ACP）**：第 1 项填适配器的**全局安装**产物（`npm i -g <适配器包>`，如 `claude-agent-acp` / `codex-acp` / `pi-acp`），**不要**把 `npx -y <包>` 写进预设——daemon 常驻、每条 worker 任务都起进程，npx 每次要问 registry/冷缓存现下（离线不可用）、版本随 latest 漂移。同时把安装命令加进 `brain-agents.ts` 的 `ADAPTER_INSTALL_HINT`，让「找不到适配器」的报错直接给出可粘贴的命令。**适配器还依赖其它运行时**（如 `pi-acp` 内部 spawn `pi`）时，给预设加 `requiresBins: ["pi"]`——`agentProblem()` 会提前报「运行时缺失」，不要等 `session/new` 抛适配器内部错误。样板见 [`docs/接入方案/接入-ClaudeCode.md`](../../接入方案/接入-ClaudeCode.md) 与 [`docs/接入方案/接入-pi.md`](../../接入方案/接入-pi.md)。

---

## 2. 加 agent（`brain-presets.ts`）

```ts
acme: {
  name: "acme",
  bin: "acme-agent",
  binWin: "acme-agent.cmd",      // Windows 实际文件名；只有 .cmd 时必须写全
  args: ["serve", "--acp"],
  shell: true,                   // .cmd/.bat/npx 必须；.exe 可 false
  // requiresBins: ["acme"],     // 适配器内部还要 spawn 的运行时（只装适配器不够）；缺失时 agentProblem() 提前报错
  homeEnvVar: "ACME_HOME",       // 指向 agent-view/<role>/<agent> 或 sandbox 根；没有就删掉
  realHome: path.join(os.homedir(), ".acme"),
  inheritDirs: ["skills"],       // 目录式记忆/技能
  inheritFiles: ["AGENTS.md"],   // 单文件记忆
  // 仅在探针证明需要时加：
  // restore: "resume",
  // images: false,                     // 图片输入不支持（DSH 靠它关掉）
  // firstFrameMs: 90_000,
  // heartbeatMs: 60_000,
  // mcpViaAcp: true,
  // modelArg: "--model",               // 不支持 session/set_config_option 时模型走启动参数（gemini）
  // replayOnLoad: true,                // load/resume 返回后仍异步回放历史：恢复后先等帧流安静，否则旧历史会拼进本轮答复（gemini）
  // sessionMode: "bypassPermissions",  // 会话建立/恢复后经 session/set_mode 切模式（claude-code / codex）
  // env: { CLAUDE_CONFIG_DIR: "%HOME%/claude" },                  // 强制注入（值里 %HOME% → 沙箱根）
  // envDefaults: { DSH_PERMISSION_MODE: "danger-full-access" }, // 审批类默认值：父进程已设同名变量时以父进程为准
  // credentialEnv: (realHome, parentEnv) => ({ ... }),            // 从 agent 凭据文件派生 env（仅父进程未提供时；Cline 的 CLINE_PROVIDER/CLINE_API_KEY）
  // isolateSessions: true,             // 会话持久化 root 用 agent 自己的 --patch 指到账号数据目录（DSH）
  // fallbackBinPaths: [path.join(os.homedir(), ".acme", "bin", "acme-agent")], // 官方安装不在 PATH
  // settingsBase: "settings.json",       // 以真实配置为基底（剥离 MCP/插件/providers/model、关自动更新）
  // settingsStrip: ["mcpServers"],       // settingsBase 里要删的键（默认 DEFAULT_SETTINGS_STRIP；gemini 只剥 mcpServers，保留 model/security）
  // settingsDefaults: { quietStartup: true }, // 沙箱 settings.json 缺省补键（用户显式设过则保留用户的值；只改沙箱副本）
  // credentialFiles: [".auth/user"],     // 登录态（新者胜）
  // identityFiles: [".auth/machine_id"], // 必须与真实目录一致（内容不同即覆盖）
  // realProfile: "acp",                  // 该 agent 的用户层 profile 名——原样复制真实 profiles/<名>/cordis.patch.yml 并从它读默认模型（DSH）
},
```

同时：

- **原生 ACP** 才按实测启动耗时把新原生 agent 插入 `AUTO_PROBE_ORDER` 的合适位置；**适配器类不要加**（各自独立安装、各有认证，装好不等于登录过，参与探测会让「装了但没登录」的机器静默换脑）——`claude-code` / `codex` / `pi` 都不在探测顺序里；
- `AcpAgentPreset` / `ResolvedAgent` 透传新字段；
- `brain-agents.test.ts` 加断言；
- `docs/接入方案/接入其它-ACP-Agent.md` §5 agent 表加一行。

> **1.2.0 起，加 agent 不必再"挑角色"**：同一个 agent 同时可用于对话大脑与任务 worker（`resolveAgentFor(cfg, role)`），加完立刻可以
> `wemind brain switch acme` 热切换、也可以在微信里 `任务 acme：…` 指定它干活——两者都不需要改代码、不需要重启。
> 启动覆盖（`--bin`/`--args`/`--shell`/`--model`）按**agent 名**存在 `brain.json` 的 `presets` 段（`wemind brain set acme --bin …`），
> 所以「切走再切回」不会丢；`--model auto` = 跟随真实 profile 的默认（agent 配了 `realProfile` 时；读不到就不下发）；默认任务大脑是 `worker.agent ?? agent`。

---

## 3. 配置视图 / MCP / 记忆

- `homeEnvVar` 指向 `agent-view/<role>/<agent>`（`real`/`mirror`）或 `BRAIN_HOME`/`WORKER_HOME`（`sandbox`）；`configSubdir` 决定配置目录在其中的位置。
- `mcpFormat`：`kiro`（`mcpServers`）或 `opencode`（`mcp.servers`）；DSH 这类走 ACP 的用 `mcpViaAcp`，不要写文件。
- 记忆/技能：`real`/`mirror` 由 config view 直接链接 `realHome` 的未覆盖目录/文件；`sandbox` 才按 `inheritDirs` / `inheritFiles` 选择性复制。单文件记忆（`AGENTS.md`、`CLAUDE.md`）用 `inheritFiles`。
- 登录态：`credentialFiles`（新者胜）+ `identityFiles`（内容不同即覆盖）；`wemind brain check` 会自动复制进临时视图/沙箱。
- 设置继承：`settingsBase` 会在 brain/worker 两个角色的视图（`sandbox` 模式是沙箱）生成剥离后的基底（`mcpServers`/`enabledPlugins`/`providers`/`model` 全删，`general.enableAutoUpdate=false`）；`settingsStrip` 可改剥离键（gemini 只剥 `mcpServers`，保留用户的 `model`/`security`），`settingsDefaults` 只补**缺失**键（用户显式设过就保留，真实配置不动）。
- **profile**（`realProfile`，可选）：`real`/`mirror` 下整个 `profiles/` 链接真实 home；`sandbox` 模式把真实 `<realHome>/profiles/<名>/cordis.patch.yml` **原样复制**进沙箱——agent 自己首次启动生成的那份常是空壳 `[]`，不同步就连它的 provider 路由都不存在。默认模型从真实 profile 读（`profile-model.ts`：DSH 优先用户写的 `- id: acp`，否则 `agent-default-model`）。**不追加/合成任何条目**：DSH 的 `- id: acp` 由用户自己在真实 profile 里写（缺时 `wemind brain` 给可粘贴的片段），这正是「终端 dsh 与微信大脑同一个模型」的前提（§4.14）。
- brain 默认空 MCP、按 agent 持久激活；worker 真实全量。两者都永久禁止 `wechat`（防它把消息发回自己）。
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
| 有反向请求 | 已由 `acp-reverse.ts` 统一应答（brain / worker / `brain check` 共用）：`session/request_permission` 默认拒绝、未知 method 回 `-32601`；改语义只改这一处 |
| 首帧慢 / 无 activity 帧 | 配置里的 `firstFrameMs`；`index.ts` 心跳/`heartbeatMs` |
| `image:false` | 预设加 `images: false`（`planImageTurn()` / `askBrainTurn` 据此友好拒绝，不会 `-32602` 重试）；**别只改 daemon 侧的拦截**——能力来自预设字段 |
| `session/set_config_option` 不支持（`-32601`） | 预设加 `modelArg`（如 gemini 的 `"--model"`）：模型改为拼到启动参数，不再走 ACP 下发；`wemind brain set <名> --model …` 仍是入口 |
| `session/load\|resume` 返回后仍异步回放历史 | 预设加 `replayOnLoad: true`：恢复后先等帧流安静（`acp-quiet.ts`，200ms 静默窗口、最多 3s）再提问，否则旧历史会被拼进本轮答复 |
| MCP 走 ACP | `session/new` / `session/resume` 传 `mcpServers`（`mcpViaAcp`）；catalog 按 agent 自己的来源 |

> `acp-brain.ts` 与 `worker-acp.ts` 的协议层统一在 `acp-connection.ts`，改一处 brain 与 worker 两边生效；进程生命周期与会话持久化仍各自实现。

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
7. **热切换**（1.2.0）：从别的配置里的 `wemind brain switch acme` → 答复两段、daemon pid 不变、下一条消息由 acme 答；再切回去，旧上下文能 load 回来；
8. **当 worker 用**（1.2.0）：`wemind task "…" --agent acme` → 任务跑通；跑完进程**留着复用**（`wemind list` 可见），5 分钟后回收。

---

## 6. 常见坑

- **`onPath()` 按精确文件名**：只有 `.cmd` 时，`binWin` 写 `dsh.cmd` 而不是 `dsh`。
- **不要用 `spawn(bin, args, { shell: true })`**：用 `spawnAgent()`（DEP0190 + 引号）；Windows 上它还会设 `NoDefaultCurrentDirectoryInExePath=1`，禁止从任务 cwd 解析裸命令名（防同名 `.cmd` 劫持）。
- **`wemind brain check` 默认 60s**：冷启动慢的 agent 仍可能误报；先看日志再判定不可用。
- **`session/load` 不是通用能力**：没有就退 `resume`，再没有就 `new`，并在日志里说清楚。
- **反向请求不应答 = 挂起**：哪怕回 `-32601` 也比沉默好。三处入口（brain / worker / `brain check`）共用 `acp-reverse.ts`，别在某一处另写一份。
- **committed-only + 15s 心跳 = 烧连发额度**：先调心跳，再考虑首帧。
- **密钥不要写进 agent**：daemon 进程环境提供。
- **能力字段是人工结论，不是自动适配**（1.2.0 仍未变）：`initialize` 的回包**不被解析**（只置 `initialized = true`），`image`/`restore`/`mcpViaAcp` 全部来自 agent 配置字段——所以探针必须看，看完必须写进 `brain-presets.ts`。
- **冷启动耗时（2026-10-29 已量）**：DSH `initialize` **5.8s** / `session/new` 50ms；opencode ~650ms / ~800ms；qoder 1.7s / 1.5s——均远小于 `REQ_TIMEOUT=30s`，**暂不需要** `reqTimeoutMs`（见 `run-e2e.md` §7.3）。新接入的 agent 仍要先量；若超过 30s，再在 agent 里加 `reqTimeoutMs`（**尚未实现**，先量再定）。
- **适配器不要用 npx 当默认**：全局安装后 `bin` 写 `claude-agent-acp`（Windows `claude-agent-acp.cmd`）+ `shell: true`；npx 只做兜底。没装时用 `ADAPTER_INSTALL_HINT` 给提示，别只回一句「找不到」。适配器另有运行时依赖（`pi-acp` → `pi`）时用 `requiresBins`；`onPathAny()` 会补试 `.cmd`/`.exe`。
- **「免审批」要用漂移检测兜住**：`ACP_TEST_TOOL=1` 跑探针——强制一次工具调用（写标记文件），断言「0 个 `session/request_permission` + 文件真的落盘」。只看 stopReason 分不出「被拒绝」和「没执行」；上游改成逐次审批时探针会先红，而不是微信第一条消息卡 30s 超时。
- **同 agent 并发 = 两个进程共用其配置目录**：多任务并行时会真实发生（不同 agent 各自 `configSubdir` 天然隔离）；新 agent 若把会话/缓存写在配置目录里，这条要实测。Claude Code 的 `CLAUDE_CONFIG_DIR` 会连 `~/.claude.json` 一起隔离。

---

## 7. 参考

- [`docs/接入方案/接入-OpenCode.md`](../../接入方案/接入-OpenCode.md) — 原生 ACP 的实测样板
- [`docs/接入方案/接入-DeepSeek.md`](../../接入方案/接入-DeepSeek.md) — 缺 load、`image:false`、committed-only 的反例
- [`docs/接入方案/接入-ClaudeCode.md`](../../接入方案/接入-ClaudeCode.md) — 需适配器的样板（全局安装、`CLAUDE_CONFIG_DIR` 沙箱、`mcpViaAcp`、`sessionMode`）
- [`docs/接入方案/接入-pi.md`](../../接入方案/接入-pi.md) — 适配器 + 运行时依赖（`requiresBins`）、文件式 MCP（`mcp.json`）、无审批开关的样板
- [`docs/接入方案/接入其它-ACP-Agent.md`](../../接入方案/接入其它-ACP-Agent.md) — 通用 ACP 指南
- [`docs/repowiki/07-远程任务-Worker.md`](../../repowiki/07-远程任务-Worker.md) — worker 侧（进程池、任务表）对新 agent 的要求
- [`docs/ai/recipes/run-e2e.md`](run-e2e.md) — 验收分层与待实测清单
- [`scripts/acp-probe.mjs`](../../../scripts/acp-probe.mjs) — 能力探针
