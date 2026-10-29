# 接入 Qoder CLI（设计文档）

> **状态**：M0 能力探针 **已完成 ✅** ｜ M1 agent + 沙箱隔离 **已完成 ✅** ｜ M2 按 M0 结果为空 ｜ M3 真机 E2E **已完成 ✅**（2026-10-27）。
> **实测环境**：Windows 11 / Node 24 / **Qoder CLI 1.1.78**（官方原生安装）/ WeMind 1.0.1。
> **最后核对**：2026-10-27 ｜ **分支**：`feat/qoder-brain` ｜ 结论**仅适用于 qodercli 1.1.78**。
> **相关文档**：[接入其它-ACP-Agent.md](接入其它-ACP-Agent.md) · [ai/recipes/add-acp-agent.md](ai/recipes/add-acp-agent.md) · [接入-OpenCode.md](接入-OpenCode.md)（文件式 MCP 样板）· [接入-DeepSeek.md](接入-DeepSeek.md)（凭据同步样板）

---

## 0. TL;DR

- 目标：daemon 形态②里把 **Qoder CLI** 作为常驻 ACP 大脑（brain）和任务 worker：`wemind brain set qoder`。
- **M0 实测：能力完整，协议层零改动。** `loadSession`、`resume`、图片、MCP（stdio/HTTP/SSE）都支持；`--yolo` 下调用工具**不发任何反向请求**；硬杀后 `session/load` 能恢复上下文；首字 1–3 s，带 thought/tool 帧。
- 需要做的只有**agent + 沙箱**：
  1. 直接起 `qodercli.exe --acp --yolo`，**不走 `qoder` 分发器**（它会多套一层 `cmd → powershell`）；
  2. `QODER_CONFIG_DIR` 指向沙箱（`~/.qoder` 与 Qoder Desktop 共用，绝不写真实目录）；
  3. **登录态要同步两个文件**：`.auth/user` + `.auth/machine_id`（缺一个就报 `Authentication required`）；
  4. 设置继承：复制 `~/.qoder/settings.json` 作为基底（去掉 MCP/插件/自定义供应商键），并强制关闭自动更新。
- 已定：用 `--yolo`；官方原生安装；**不复制 `providers`**（BYOK 含明文 `apiKey`，内置模型只需账号登录；`model` 一并剥离，避免指向已剥离的供应商）。
- M1 状态：agent + 沙箱已在 `feat/qoder-brain` 实现；typecheck / lint / format:check / 155 项单测全绿；`wemind brain check` 真机握手通过（约 2.4 s）。
- **M3 真机 E2E 全通过**：文字对话、发图识别、动态 `加载/卸载` MCP（真实调用并回环拒绝 `wechat`）、冷重启与换脑切换后 `session/load` 恢复、worker 派发 → 强杀中断 →「继续」续跑、`memory/` 继承生效；细节见 §2.1。

---

## 1. 安装形态（本机实测）

| 项 | 实测 |
|---|---|
| CLI 本体 | `~/.qoder/bin/qodercli/qodercli.exe`（约 210 MB 单文件，旁边还有 `qodercli-1.1.78.exe` 与 `version.txt`）；该目录已加入**用户 PATH** |
| `qoder` 命令 | `~/.qoder/entry/qoder.cmd` → `qoder-dispatcher.ps1`：参数以 `-` 开头转发给 `qodercli`，`qoder ide` / 路径参数转发给 IDE。**常驻 stdio 进程不要走它** |
| 配置目录 | `~/.qoder`（与 Qoder Desktop 共用：`settings.json`、`memory/`、`plugins/`、`.auth/` 都在这里） |
| 登录态 | `~/.qoder/.auth/user`（token）+ `~/.qoder/.auth/machine_id`（机器标识，token 与它绑定） |
| 初次运行副产物 | 在 `QODER_CONFIG_DIR` 下生成 `.auth/machine_id`（**新的**）、`.bin/umid-*`、`.cache/`、`logs/`、`security-resources/`、`tmp/`、`installation_id` |

---

## 2. M0 探针结果

探针：[`scripts/acp-probe.mjs`](../scripts/acp-probe.mjs)（修复了「`session/load` 成功后仍去调 `resume`，导致第二问不发」的缺陷——DSH 无 load，此前没暴露）。

```powershell
$env:ACP_BIN = "$env:USERPROFILE\.qoder\bin\qodercli\qodercli.exe"
$env:ACP_ARGS = '["--acp","--yolo"]'
$env:ACP_HOME_ENV = "QODER_CONFIG_DIR"
$env:ACP_HOME = "$env:TEMP\qoder-probe"   # 预先放入 .auth/user 与 .auth/machine_id 的副本
$env:ACP_HARD_KILL = "1"
node scripts/acp-probe.mjs
```

| # | 问题 | 结果 |
|---|---|---|
| Q1 | 启动方式 / capabilities | `--acp` 可用。`loadSession:true`；`sessionCapabilities` 含 `resume/close/fork/list/delete/additionalDirectories`；`image:true`、`embeddedContext:true`；`mcpCapabilities: {http, sse}`；`authMethods: qodercli-login` |
| Q2 | 空沙箱能否用登录态 | **不能**（`-32000 Authentication required`）。复制 `.auth/user` + `.auth/machine_id` 后通过；**只复制 `user` 仍失败** |
| Q3 | 反向请求 | `--yolo` 下 prompt 触发 3 次工具调用，**0 个反向请求**（无 `request_permission`、无 `fs/*`、无 `terminal/*`） |
| Q4 | 首帧 / 帧类型 | 首帧 1.0–1.7 s，首字 1.4–2.8 s；`agent_thought_chunk`、`agent_message_chunk`、`tool_call`、`tool_call_update` → 默认 25 s 首帧 / 15 s 心跳均适用 |
| Q5 | 硬杀后恢复 | `taskkill /T /F` 后新进程 `session/load` 成功，追问答出 `PINEAPPLE` ✅ |
| Q6 | 模型 / 模式 | `session/new` 返回 `modes`（`default/acceptEdits/auto/dontAsk/yolo`，当前 `yolo`）、`models`（默认 `auto`，另有 `ultimate/fast/efficient` 等 15 个）与 `configOptions`（`mode`、`model` 两个 select）→ 可用现有 `model` agent 配置字段走 `session/set_config_option` |
| Q7 | 图片 | 1×1 PNG 的 prompt 返回 `end_turn` 无报错；真实图片识别留到 M3 真机验证 |
| — | stdout 杂质 | 无非 JSON 行 |

M1 期间补测（2026-10-26）：

| # | 问题 | 结果 |
|---|---|---|
| Q8 | 沙箱 `settings.json` 的 `mcpServers` 生效吗 | ✅ 用 canary MCP 实测生效；`--yolo` 下模型会真实调用 |
| Q9 | worker 的项目级 `.mcp.json` 会被自动加载吗 | **不会**（`--yolo` 也不加载）→ worker 不会被项目里的 `wechat` MCP 抢消息；仍建议项目侧不要放 `.qoder/` 配置（未单独实测） |
| Q10 | `--setting-sources user` 能否简化继承 | ❌ 会直接 `Authentication required`，放弃；改用复制 `settings.json` 做基底 |

### 2.1 M3 真机 E2E（2026-10-26 / 27）

环境：daemon 跑在真实微信账号上，`WEMIND_BRAIN=qoder` 临时覆盖（`brain.json` 保持 deepseek，用于顺带验证切换隔离）。

| # | 场景 | 结果 |
|---|---|---|
| M3-1 | 发图片（真实照片） | ✅ 回复准确描述画面（「大红苹果…巨型苹果雕塑」），`prompt ok 5650ms chunks=73`；`image:true` 落实到端到端 |
| M3-2 | 动态 MCP：`列出 MCP` → `加载 wemind-test` → 让 agent 调工具 → `卸载` | ✅ 目录列出临时 MCP；加载后沙箱 `settings.json.mcpServers` 写入、`brain-mcps.json` 记录、ACP 自动重启；agent 真实调用并回 `pong from wemind-mcp-test`（临时 server 日志可见握手）；`加载 wechat` 被拒（防它把消息发回自己）；卸载后清理；真实 `~/.qoder/settings.json` 已按备份还原 |
| M3-3 | worker：派发约 25 s 任务 → `taskkill /T /F` 强杀 worker → 微信「继续」 | ✅ 强杀后 `prompt FAIL → rebuild`，任务进入 waiting；「继续」触发重拉 + `session/load ok`，工具调用续跑，两步产物 `STEP-A-DONE` / `STEP-B-DONE` 齐全；`worker-sessions.json` 新增 `qoder:task` |
| M3-4 | 冷重启后追问 | ✅ daemon 重启后首轮 `session/load ok`，上下文保留（配合 M3-3 的硬杀恢复，覆盖两种重启路径） |
| M3-5 | 记忆/技能继承 | ✅ `memory/` junction 生效：大脑能读到日常 Qoder 写入的用户偏好（实测答出真实记忆里的内容）；`skills`/`agents`/`commands`/`AGENTS.md` 在 1.1.78 不存在，保持空操作 |
| — | 切换隔离（会话映射按 agent 分开存） | ✅ qoder 与 deepseek 各自 `session/load` 自己的 sessionId；来回切换不再出现 `-32602 INVALID_SESSION_IDENTIFIER`，切回时原上下文仍在 |
| — | 日常 Qoder 登录态 | ✅ E2E 全程未被登出（token 轮换暂未观察到，见 §6） |

---

## 3. agent（`brain-agents.ts`）

```ts
qoder: {
  name: "qoder",
  bin: "qodercli",
  binWin: "qodercli.exe",              // 直接起本体，不走 qoder.cmd 分发器；.exe → shell:false
  // 官方原生安装不在 PATH 时兜底（auto 探测仍只看 PATH）
  fallbackBinPaths: [path.join(os.homedir(), ".qoder", "bin", "qodercli", "qodercli.exe")],
  args: ["--acp", "--yolo"],
  env: { QODER_CONFIG_DIR: `%HOME%${path.sep}qoder` },  // 替换 global 配置目录 → 真正隔离
  configSubdir: "qoder",
  realHome: path.join(os.homedir(), ".qoder"),
  inheritDirs: ["memory", "skills", "agents", "commands"],
  inheritFiles: ["AGENTS.md"],
  mcpFormat: "kiro",                   // 键名同为 mcpServers
  mcpConfigFile: "settings.json",
  catalogFile: "settings.json",
  settingsBase: "settings.json",       // 新字段，见 §4.2
  credentialFiles: [".auth/user"],     // 新者胜，见 §4.3
  identityFiles: [".auth/machine_id"], // 内容不同即覆盖，见 §4.3
},
```

- **不用 `homeEnvVar`**：大脑 `cwd` 就是沙箱根（[acp-brain.ts:287](../packages/wechat-daemon/src/acp-brain.ts)）。若配置目录也是沙箱根，`<cwd>/AGENTS.md` 会被当作用户级和项目级各读一次；放到 `<沙箱>/qoder` 避开。`%HOME%` 替换在 brain / worker / brain check 三处都已支持。
- **不需要** `restore` / `firstFrameMs` / `heartbeatMs` / `images:false`——Q1/Q4/Q5 证明默认值适用。
- **记忆/技能继承（M3-5 已核对）**：Qoder 1.1.78 的用户级记忆落在 `~/.qoder/memory/`（agent 的用户画像/偏好），已加入 `inheritDirs` 并以 **junction 共享**——大脑与日常 Qoder 读写同一份记忆（写入会落到真实目录，与 kiro 的 `memories/` 一致）。`skills/agents/commands` 与 `AGENTS.md` 在本机不存在，当前是空操作，保留以便上游新增后自动生效。
- `AUTO_PROBE_ORDER` 末尾追加 `qoder`，不影响老用户。

---

## 4. 代码改动清单

### 4.1 `brain-agents.ts`

- 加 `qoder` agent，`AUTO_PROBE_ORDER` 末尾追加；
- `AcpAgentPreset` / `ResolvedAgent` 增加 `settingsBase?` / `identityFiles` / `fallbackBinPaths`；`credentialFile?: string` 改为 `credentialFiles?: string[]`（DSH agent 同步改成 `[".credentials.yaml"]`）；
- `fallbackBinPaths`：`onPath()` 找不到时按顺序试绝对路径（官方原生安装的 `~/.qoder/bin/qodercli/qodercli.exe` 常不在 PATH 上或 PATH 未刷新）。**auto 探测仍只看 PATH**，避免「装了 Qoder Desktop 但没登录 CLI」被误选；
- 修一个已有缺陷：`WEMIND_BRAIN=qoder` 这类**环境变量临时切换**时，`brain.json` 里另一 agent 的 `bin`/`args`/`homeEnvVar` 覆盖会串进来（例如残留 `bin=dsh.cmd`）。现在只有当 `cfg.agent` 与最终选中的 key 一致时才应用文件覆盖（`overrideCfg`）；
- `agentProblem()`：qoder 找不到时提示「官方安装到 `~/.qoder/bin/qodercli/`，确认它在 PATH 上，或 `wemind brain set qoder --bin <绝对路径>`」；找到但未登录时提示先 `qoder login`。

### 4.2 沙箱设置继承（`mcp-sandbox.ts` + `worker-sandbox.ts` 两边同步）

现有 `syncKiroSettings()` 只复制 `realHome/settings/` 子目录，`syncOpencodeBase()` 只认 `opencode.json`。新增通用分支：

```text
syncSettings():
  mcpViaAcp            → 跳过（不变）
  settingsBase 有值     → syncSettingsBase()      ← 新增（不依赖 inherit）
  mcpFormat=opencode   → syncOpencodeBase()（不变）
  否则                  → syncKiroSettings()（不变）
```

`settingsBase()`：读 `realHome/<settingsBase>` → 删除 `mcpServers`、`enabledPlugins`（插件可自带 MCP，有 wechat 回环风险；沙箱也不继承 `plugins/`）、`providers` / `model`（§5 决定）→ **强制 `general.enableAutoUpdate = false`**（否则 CLI 可能把约 210 MB 的新版本下载进每个沙箱；`general` 的其它键保留）→ 写入沙箱。随后 `applySandbox()` / `applyWorkerSandbox()` 用已有的 `withMcpServers()` 把 curated `mcpServers` 合并回去，**MCP 写入逻辑不改**。

### 4.3 凭据同步（两边同步）

`syncCredentialFile(file, mode)` + `syncCredentials()`，按 agent 配置字段分两组：

| 字段 | 文件 | 规则 | 原因 |
|---|---|---|---|
| `credentialFiles` | `.auth/user` | 新者胜（现有逻辑） | 真实目录重新登录 → 覆盖沙箱；沙箱自己刷新过 → 保留 |
| `identityFiles` | `.auth/machine_id` | **内容不同就覆盖** | Qoder 在缺凭据时会**自己生成**新的 `machine_id`，它比真实文件新，「新者胜」会把错的留下 → 永久认证失败 |

`brain-check.ts` 也把这两类文件复制进临时沙箱，否则 `wemind brain check` 会误报「未登录」。

兜底：daemon 进程环境里设 `QODER_PERSONAL_ACCESS_TOKEN`（PAT）也能认证，不依赖文件同步；**不写进 agent / `brain.json`**（AGENTS.md 约束 9）。

### 4.4 协议层（`acp-brain.ts` + `worker-acp.ts`）

协议方法层**不改**：现有 load → resume → new 兜底、权限默认拒绝、未知方法回 `-32601`、图片透传都直接适用。

唯一落地改动是 **session 映射按 agent 分开存**（`brain-sessions.json` 的键 `userId` → `<agent>:<userId>`，`worker-sessions.json` 的键 `task` → `<agent>:task`）：

- 起因：E2E 时账号 `brain.json` 仍是 deepseek，靠 `WEMIND_BRAIN=qoder` 临时切换；旧映射里的 DSH sessionId 被拿去 `session/load`，Qoder 回 `-32602 INVALID_SESSION_IDENTIFIER`，连试 load/resume 失败后才 `session/new`。功能能自愈，但白丢一轮上下文且日志噪音。
- 现在：换大脑后各 agent 各自保留一条会话记录，切回去仍能 `load` 回原上下文；微信「新会话」只清当前 agent 的那条。
- 兼容：读到旧格式（裸 `userId` / `task`）时归给当前 agent 并立即回写，无需手工迁移。

### 4.5 测试与文档

- `brain-agents.test.ts`：qoder agent 配置字段、auto 顺序末尾、`settingsBase` / `credentialFiles` / `identityFiles` 透传、DSH 改 `credentialFiles` 后的回归、环境变量切 agent 时不被 `brain.json` 的 bin/args 污染；
- `sandbox-qoder.test.ts`（新增）：`settingsBase` 剥离 `mcpServers` / `enabledPlugins` / `providers` / `model`、关闭自动更新且保留 `general` 其它键、凭据复制、`machine_id` 被错误生成后纠正、`applySandbox` 拒绝 `wechat`、worker 继承 curated 集；
- 文档：本文回填 M1–M3、`接入其它-ACP-Agent.md` §5 agent 表、`AGENTS.md` §6、`docs/ai/README.md` 事实表、`速查-数据目录与环境变量.md`、`llms.txt`。

---

## 5. 已定：`providers` 不带进沙箱

`settings.json` 的 `providers` 是 Qoder 的**自定义模型供应商（BYOK / 本地端点）**配置，Qoder Desktop「个人模型」和 CLI `/model` 向导都会写它。每个供应商条目包含 `baseUrl`、**明文 `apiKey`**、协议适配器、模型列表。它与 Qoder 账号登录（`.auth/`）是两回事：内置模型（`auto`、`ultimate`、`fast`…）只靠账号登录，不需要 `providers`。

| | 带进沙箱 | 剔除（已选） |
|---|---|---|
| 大脑能否用你配的 BYOK 模型 | 能 | 不能（内置模型不受影响） |
| `apiKey` 明文副本 | 多出 2 份 × 账号数（brain-home、worker-home） | 不复制 |
| 一致性 | 与「大脑和日常使用同款配置」原则一致 | 若 `model.name` 指向某个 BYOK 模型，需同时剔除 `model`，否则大脑起不来或静默回退 |

本机现状：`providers: {}`、`model: {}`，选哪个当下都没有区别。**决策：剔除 `providers` 与 `model`**——减少密钥副本，身份验证仍走账号登录；要换模型用配置里的 `model` 字段（`session/set_config_option`，Q1 已证明可用）。

---

## 6. 风险

- **令牌轮换**：真实目录、brain 沙箱、worker 沙箱持有同一份 token。如果 Qoder 刷新时轮换 refresh token，某一份刷新后，另外几份可能失效（表现为日常 CLI/Desktop 或大脑被登出）。**M3 全程（含多次重启、换脑、worker 重建）未观察到登出**；仍建议在出现时改用 daemon 环境里的 `QODER_PERSONAL_ACCESS_TOKEN`。
- **共用 `~/.qoder`**：`memory/` 以 junction 链入沙箱，**大脑的写入会落到真实目录**（与 kiro `memories/` 现状一致，已按此预期验证）；其余目录一律只读复制，不会回流。若将来 `skills/agents/commands` 真的出现，也会沿用同一机制。
- **Qoder Desktop 的 MCP 可能不在 `settings.json`**：本机发现 `~/.qoder/mcp-router.json`（本地路由，端口由 Desktop 分配），Desktop 侧管理的 MCP 有机会只登记在路由里而不写 `mcpServers`。此时 `列出 MCP` 看不到它们——**这是预期行为**（沙箱只认 `settings.json`，也避免了 Desktop 配置被动继承）。
- **worker 的项目级 MCP**：worker `cwd` 是任务项目目录。Q9 实测项目根 `.mcp.json` **不会**被自动加载（`--yolo` 也不加载），回环风险大降；项目内 `.qoder/` 配置**仍未单独实测**（M3 worker 跑在无 `.qoder/` 的临时目录）。若将来发现问题，worker 追加 `--strict-mcp-config --mcp-config <worker 沙箱>/settings.json`。
- **CLI 升级**：结论只对 1.1.78 成立；沙箱关闭了自动更新，但真实目录的 CLI 会升级。升级后跑一次 `wemind brain check`。

---

## 7. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 ✅ | 安装 + 登录 + 探针 | 本文 §1/§2 |
| M1 ✅ | agent + `settingsBase` + `credentialFiles` / `identityFiles` + 单测 | `npm run typecheck && npm test && npm run lint && npm run format:check` 全绿；`wemind brain check` 真机握手通过（临时数据目录，未动正在运行的 daemon） |
| M2 ✅（空） | 协议适配 | 按 M0 结果为空，跳过 |
| M3 ✅ | 真机 E2E：对话、发图、`加载 <MCP>`、重启后追问、worker 派发 → 中断 →「继续」、记忆继承 | 全部通过，见 §2.1；`wechat` 始终未加载；日常 Qoder 未被登出 |
| M4 ✅ | 文档同步（§4.5）+ `check-docs.ps1` | 链接检查通过 |
