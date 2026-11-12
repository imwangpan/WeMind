# WeMind 接入本机 Agent：终端等效工作模式设计与实现

> **状态**：Phase 1 已实现（2026-11-12）｜**分支**：`feat/agent-parity-mode`｜**最后核对**：2026-11-12
>
> 本文描述如何让 daemon / worker 直接调用本机已安装并配置好的 Agent CLI，使微信侧的行为尽量等同于在终端直接使用同一个 Agent；同时保留微信侧独立覆盖、账号级会话与任务隔离。未实测的结论标注「假设 / 待实测」，不以本文替代各 Agent 的接入实测记录。

---

## 1. 背景与目标

### 1.1 用户目标

- daemon 与 worker 调用**本机已安装的 Agent CLI**，不额外安装第二套 Agent。
- 本机 Agent 已经在终端配置好模型、供应商、技能、记忆、规则、插件与 MCP；**微信侧应尽量得到同样的能力与效果**。
- 微信侧默认使用 **yolo / 免审批**模式，避免频繁允许工具操作。
- 单机单人使用；同一台机器可以连接多个微信账号，WeMind 的账号数据继续隔离。
- 全部 10 个内置 Agent 预设都要覆盖。
- 默认直接修改真实 Agent 配置；只有用户明确说“微信侧 / 仅微信”时，才写微信独享覆盖。
- 微信产生的会话应能在终端 Agent 的会话列表中看到。

### 1.2 设计目标

1. **配置同源**：模型、供应商、技能、记忆、规则、插件、MCP 等以本机 Agent 的真实配置为唯一基线。
2. **终端等效**：同一个 Agent、同一份配置、同一套技能/记忆、尽量相同的工作目录与环境变量。
3. **微信可覆盖**：账号级 overlay 可以只影响微信侧，不污染真实配置。
4. **可观测、可回滚**：能看出当前用的是哪份配置、哪个工作区、哪些 MCP、是否已 reload；迁移失败可回滚。
5. **不破坏既有硬约束**：同一 bot token 只能有一个收消息实例；`wechat` MCP 永远不能被 Agent 加载。

### 1.3 已确认决策（2026-11-12）

| 决策 | 取值 |
|---|---|
| 使用场景 | 单机单人；支持同机多微信账号 |
| 默认配置模式 | `real`；接受 yolo + 真实 HOME 的完整权限代价 |
| Agent 覆盖 | 10 个内置预设全部覆盖 |
| 配置修改 | 默认改真实 Agent 配置；明确说“微信侧/仅微信”时改 overlay |
| brain MCP | 默认空；显式加载后持久到所有由 WeMind 新建的 brain 会话，直到显式卸载 / 禁用 |
| worker MCP | 默认加载真实全量 MCP，永久排除 `wechat` |
| 启动变慢 | 只警告，不自动禁用成功的 MCP |
| 工作区 | brain / worker 各一个默认工作区；可指定外部项目目录 |
| 环境 | 默认继承；可选非敏感快照（覆盖版本管理器/PATH/代理），API key 不落盘 |
| 会话 | 共享 Agent 会话库；终端能看到微信会话 |
| 并发 | 按 Agent 支持并发设计，后续用测试矩阵验证 |
| 迁移 | 老账号尽力迁移，失败可接受数据丢失，必须保留备份与回滚 |
| 安全护栏 | 危险路径确认、`wechat` 排除、出站敏感文件 denylist 保留 |

### 1.4 非目标

- **不是多用户隔离方案**。同一 OS 用户下的多个微信账号共享真实 Agent 配置、技能与记忆；不同人使用同一台机器时，应使用不同 OS 用户或虚拟机。
- **不是安全沙箱**。`real + yolo` 下，微信侧 Agent 拥有当前 OS 用户的完整权限。
- **不追求微信会话与终端当前会话是同一条 session**。默认共享 Agent 会话库、但微信使用独立 session ID；终端能看到微信会话，不会把两边正在进行的上下文混在一起。
- **不保证所有 Agent 的“终端等效”完全一致**。各 Agent 的 ACP 能力、配置布局、MCP 传输方式不同；差异会在能力矩阵中明确标注。

### 1.5 安全前提

本设计默认接受以下代价：

- 微信侧 Agent 可以读写当前用户能访问的任何文件。
- 提示注入可能诱导 Agent 修改真实配置、项目文件、凭据或执行命令。
- yolo 意味着大多数工具调用不会逐次询问。

因此，`real + yolo` 只适合可信的单机单人环境。需要更强隔离时，使用 `sandbox` 模式、独立 OS 用户或虚拟机；不能把本设计的“工作区”或“overlay”当成安全边界。

---

## 2. 术语与模式

| 术语 | 含义 |
|---|---|
| **real home** | 本机 Agent 在终端使用的真实配置目录，如 `~/.kiro`、`~/.claude`、`~/.pi/agent` |
| **config view** | WeMind 为某个账号/角色准备的配置视图；大部分条目指向 real home，少数文件由 WeMind 生成 |
| **effective config** | `real base → 微信 overlay → 角色策略（MCP / yolo / 路径）` 合并后的最终配置 |
| **overlay** | 微信独享覆盖，存放在账号目录，永不自动写回真实配置 |
| **workspace** | Agent 的 `cwd`，影响项目级规则、技能发现、相对路径与 git 上下文 |
| **homeMode** | `real` / `mirror` / `sandbox` 三种配置来源模式 |
| **mcpMode** | `brain-curated`（默认空、显式加载）或 `worker-real`（真实全量减 `wechat`） |

### 2.1 三种 homeMode

| 模式 | 行为 | 适用场景 |
|---|---|---|
| `real` | real home 是配置/会话/记忆的唯一来源；只对必须覆盖的单个文件（MCP/权限）生成最小视图，其余用目录 junction / 符号链接保持双向 | 默认；单机单人；追求终端等效 |
| `mirror` | 整个 home 建立视图，对混有 MCP/权限等必须覆盖内容的文件生成副本，并做三路合并 | Agent 不支持直接覆盖单个配置段，或 Windows 文件链接不可用 |
| `sandbox` | 完整复制到账号目录，Agent 与真实配置隔离 | 多账号不同人、不可信任务、Agent 不支持共享 home、需要回滚 |

**默认：`real`。** 现有账号迁移后也进入 `real`；`sandbox` 保留为显式选项。

### 2.2 沙箱隔离的取舍

旧实现把 brain / worker 放进 `brain-home` / `worker-home`，本质是「用隔离换可控」。这个取舍需要明确记录，避免后续又把两种目标混在一起。

| 维度 | 沙箱（现状） | 终端等效（本设计默认 `real`） |
|---|---|---|
| 配置一致性 | 启动时复制，长跑期间真实配置变化不生效 | 真实配置是唯一基线，改完即用 |
| 技能 / 记忆 | 只继承预设列出的目录，容易漏 | 天然共享，终端新增即可用 |
| 会话可见性 | 会话在沙箱，终端看不到 | 共享 Agent 会话库，终端可见 |
| 微信独享 | 整份配置天然独享，但会逐渐漂移 | 用 overlay 做「薄覆盖」，默认不漂移 |
| 安全性 | 能限制写入范围，降低提示注入影响面 | 微信侧拥有当前 OS 用户完整权限 |
| 可回滚 | 删沙箱即可 | 依赖备份、冲突文件与 overlay 审计 |
| 适用场景 | 多账号不同人、不可信任务、Agent 不支持共享 home | 单机单人、可信环境、追求「终端什么效果，微信就什么效果」 |

结论：默认 `real` 不是否定沙箱，而是把沙箱降级为**显式选项**。安全边界仍然只能靠独立 OS 用户、容器或虚拟机，不能靠工作区或 overlay。

---

## 3. 现状与差距

### 3.1 现状摘要

Phase 1 已落地（本分支）：

- 账号默认 `homeMode = real`（`agents/config/home-mode.ts`），读取 `<账号>/runtime.json`；缺失/损坏回落 `real`，`WEMIND_HOME_MODE` 只做一次性覆盖。
- `real` / `mirror` 使用 `<账号>/agent-view/<role>/<agent>/` 最小配置视图（`agents/config/config-view.ts`）：未被覆盖的目录/文件优先 junction/symlink 指向真实 home；MCP、`settingsBase`、kiro v3 权限文件和 overlay 目标生成副本。`sandbox` 仍使用 `brain-home` / `worker-home`。
- 没有 `homeEnvVar` 的 Agent（`claude-code` / `cline` / `qoder`）在 real 模式直接用真实 home；预设新增 `realEnv` 修正 `env` 模板多拼一层的问题（`%HOME%` 按真实 home 展开），否则会指到 `~/.claude/claude` 这类不存在的目录。
- brain 与 worker 的启动/会话 `cwd` 改为账号级默认工作区（`<账号>/workspace/brain`、`<账号>/workspace/worker`，`agents/config/workspace.ts`）；`session-cwd.json` 记录 `<agent>:<sessionId> → cwd`，恢复旧会话时优先使用它。`WEMIND_WORKER_CWD` 与 `task --cwd` 仍是一次性覆盖。
- brain 默认空 MCP；激活集按 agent 分键持久化在 `<账号>/brain-mcps.json`（`version: 2`）。worker 默认真实全量减 `wechat`。两者都支持 overlay 的 `mcp.disable` 与 `mcp.extra`。
- MCP/首帧指标已落到日志：`session/new|load|resume ok … mcpCount= sessionNewMs= mcpStartupMs=`、`prompt ok … firstFrameMs=`（`agents/config/mcp-perf.ts`）；`scripts/doctor.ps1` 读最近 `daemon.log`，数量/耗时超阈值只提示，**不自动禁用**。Agent 自己配置文件里的 MCP 单独记 `nativeMcpCount`（目前只有 Codex 的 `config.toml`）。
- Codex 的 `~/.codex/config.toml` 已做**只读**解析（`agents/sandbox/toml-mcp.ts`）：`[mcp_servers.*]` 的名字/`command`/`args`/`env`/`url` 会进 `列出` 与指标；WeMind 仍不写 TOML、也无法替 Codex unload 原生项。原生配置里若有 `wechat`（或任何会跑 `wemind-mcp` 的定义），brain/worker 直接拒绝启动，避免第二个 poller。
- 微信 overlay 位于 `<账号>/agent-overrides/<agent>.json`；CLI 为 `wemind config wechat ...`，微信侧为 `微信配置 ...` 确定性指令。
- 真实配置写入走 `agents/config/agent-config-writer.ts`：备份、mtime + size + sha256 并发校验、同目录原子写；含注释 JSONC、YAML/TOML 第一期拒绝写入。
- 入站媒体在 `real` / `mirror` 下写到 `<账号>/media/inbound`；`sandbox` 仍是 `<sandbox>/media/inbound`。
- 配置变化通过 `configFingerprint()` 在每轮开始前检测并重建；`wemind config reload` 经控制桥在空闲时重建视图并重启常驻 brain。worker 在每次 `acquire` 时按该任务 agent 重新准备。
- 技能/记忆的双向共享由 **WeMind 自己**的 config view + `sandbox-inherit.ts` 实现，不是 Agent 或操作系统自动提供。`real` 模式下未被覆盖的目录直接链接；`sandbox` 模式仍只继承预设列出的 `inheritDirs` / `inheritFiles`。
- 会话指针仍在 `brain-sessions.json` / `worker-sessions.json`；Agent 的真实会话库由各 Agent 自己管理，`real` 模式下与终端共用同一个库。

改造前的“沙箱优先”行为仅在显式 `sandbox` 模式保留，用于回滚、不可信任务或 Agent 不支持共享 home 的场景。

### 3.2 与目标的差距

| 维度 | 现状 | 目标差距 |
|---|---|---|
| 配置 | 已改为 real 基线；改真实配置后下一条新会话生效 | 仍需各 Agent 实测“哪些热设置无需新会话”，Phase 2 补矩阵 |
| 配置回写 | 默认改真实配置；overlay 只写微信侧 | 已实现；JSONC 注释/YAML/TOML 的保留格式编辑留到 Phase 2 |
| 技能/记忆 | real 模式共享真实目录；复制回退不保证双向 | 需要在无 symlink 权限的平台记录“副本漂移”告警 |
| MCP | brain 默认空、按 agent 持久；worker 全量减 `wechat`；日志有 `mcpCount/sessionNewMs/firstFrameMs`，doctor 超阈值只警告；Codex 原生 TOML 只读可见、含 `wechat` 拒绝启动 | 已实现；各 Agent 的耗时基线数值仍要在真机上收集后写进接入文档 |
| cwd | brain/worker 各有账号级默认工作区；旧会话按 `session-cwd.json` 恢复 | 已实现；各 Agent 对“恢复时改 cwd”的接受度待逐家实测 |
| 环境 | 默认继承 daemon；可选非敏感快照 | 已实现；不绑定 fnm/nvm/Volta/asdf/mise |
| 权限 | 预设 yolo + 宿主 `WEMIND_ACP_AUTO_ALLOW` 可选放行 | 已保留；真正隔离仍需独立 OS 用户/VM |
| 会话 | real 模式共享 Agent 会话库，终端能看到微信会话 | 各 Agent 的会话列表呈现/并发写锁待逐家验收 |
| 多账号 | WeMind 数据隔离；Agent 配置共享；overlay/workspace 按账号 | 已实现；不同人共用一台机器仍需不同 OS 用户 |

---

## 4. 设计原则

1. **单一真实来源**：非微信独享的配置、技能、记忆、会话以本机 Agent 的 real home 为准。
2. **薄隔离**：只隔离必须由 WeMind 控制的部分：`wechat` MCP 排除、账号级 overlay、会话指针、任务/控制桥、workspace 默认值。
3. **显式覆盖**：微信独享配置必须写入 overlay；默认不复制整份配置。
4. **回环硬约束**：`wechat` MCP 永远不加载；按名字和定义双重判断。
5. **会话绑定 cwd**：工作区变化只影响新会话；已有会话不自动搬家。
6. **显式 reload**：配置变化在空闲时应用；不在一轮对话中途换模型/权限/MCP。
7. **失败要响**：外部工作区不存在、Agent 不可用、配置解析失败要明确报错，不静默回退。
8. **账号数据隔离**：token、会话指针、任务、overlay、workspace 配置按账号隔离；真实 Agent 配置是共享基线。

---

## 5. 目标架构

```text
微信消息
   │
   ▼
daemon（账号级 DATA_DIR）
   │  sessionId / cwd / taskId / overlay / workspace
   ▼
AgentHomeResolver ──► ConfigViewBuilder ──► Agent 进程
   │                       │
   │                       ├── real home（配置/技能/记忆/会话）
   │                       ├── generated MCP / yolo 覆盖文件
   │                       └── overlay（微信独享）
   │
   ├── McpPolicy（brain 默认空 / worker 全量）
   ├── WorkspaceManager（brain / worker 默认工作区）
   ├── EnvProvider（继承或非敏感快照）
   ├── SessionBinder（sessionId ↔ cwd）
   └── ReloadCoordinator（空闲 reload / 新会话生效）
```

### 5.1 核心组件

| 组件 | 职责 |
|---|---|
| `AgentHomeResolver`（`agents/config/runtime.ts`） | 根据 Agent 预设、账号配置与角色（brain/worker）决定 `homeMode`、视图/沙箱根、`cwd`、媒体目录 |
| `ConfigViewBuilder`（`agents/config/config-view.ts`） | 构建 config view：链接/复制 real home，生成必须覆盖的文件（MCP、yolo、overlay） |
| `OverlayStore`（`agents/config/overlay.ts`） | 读写 `<账号>/agent-overrides/<agent>.json`，做路径级 patch |
| `McpPolicy`（`agents/sandbox/mcp-sandbox.ts`、`worker-sandbox.ts`） | 计算 brain / worker 的有效 MCP 集；排除 `wechat`；处理 disable/extra |
| `WorkspaceManager`（`agents/config/workspace.ts`） | 校验、创建、读取 brain/worker 默认工作区；区分 managed/external |
| `EnvProvider`（`agents/config/env-snapshot.ts` + `brain-agents.ts`） | 继承 daemon 环境，或加载非敏感快照（PATH/代理/locale）；解析顺序不绑定某个版本管理器 |
| `SessionBinder`（`agents/config/session-cwd.ts`） | 保存 `<agent>:<sessionId> → cwd`；恢复时使用并校验 cwd |
| `ReloadCoordinator`（`config-fingerprint.ts` + `config.reload` 控制桥） | 检测真实配置变化；手动 reload 在空闲时重建视图并重启 brain |
| `AgentCapabilityMatrix`（`brain-presets.ts`） | 每个 Agent 的 homeMode、MCP 传输、会话布局、yolo 方式、并发注意事项 |

### 5.2 brain 与 worker 的差异

| 维度 | brain | worker |
|---|---|---|
| 配置来源 | real / mirror / sandbox；常因 MCP 空集需要最小视图 | 通常可直接 `real`（MCP 全量，仅剥离 `wechat`） |
| 默认工作区 | `<账号>/workspace/brain` | `<账号>/workspace/worker` |
| MCP 默认 | **空**；显式加载后持久到所有新会话 | 真实全量减 `wechat` |
| 会话 | 每个用户一条当前 session | 每个任务一条 session |
| 进程 | 1 个常驻 ACP 进程 | N 个进程池 |
| 重载 | 空闲时 reload / 新会话 | 每次 `acquire` 刷新 config view；任务中不热切换 |

---

## 6. Agent 能力矩阵

> 表中 `~` 表示当前 OS 用户的主目录；Windows 的 `%USERPROFILE%`、macOS/Linux 的 `$HOME` 都等价。路径分隔符、权限位与链接能力按平台处理，不把某一种平台的文件布局当成通用事实。`homeMode` 为建议默认，最终以实测为准。

| Agent | 配置入口 | real home | 配置目录 | MCP 传输 | 会话库 | yolo 方式 | 建议 homeMode / MCP 视图 | 主要风险 |
|---|---|---|---|---|---|---|---|---|
| `kiro` | `KIRO_HOME` | `~/.kiro` | 根 | `settings/mcp.json` | `sessions/` | v2 `--trust-all-tools`；v3 `settings/permissions.yaml` | `real + mcp.json 视图`（v3 权限文件也可能需要视图） | v3 权限文件不能改真实配置时需生成视图 |
| `gemini` | `GEMINI_CLI_HOME` | `~`（它是“家目录”根，配置在其下的 `.gemini`） | `~/.gemini` | `.gemini/settings.json` | `.gemini/` | `--approval-mode yolo --skip-trust` | `mirror` | `settings.json` 混有 MCP，需生成视图 |
| `copilot` | `COPILOT_HOME` | `~/.copilot` | 根 | ACP `mcpServers` | COPILOT_HOME 内 | `--allow-all-tools` | `real` | 不启用 `--allow-all` 的路径/URL 放宽；图片能力待实测 |
| `opencode` | `XDG_CONFIG_HOME` | `~/.config/opencode` | `opencode/` | `opencode.json` 的 `mcp.servers` | 真实 `~/.local/share/opencode` | `opencode.json` 的 `permission: "allow"` | `mirror` | 数据目录不在账号内（real 模式正是目标；sandbox 模式会跨账号共享）；MCP/权限同文件 |
| `deepseek` / DSH | `DSH_HOME` | `~/.dsh` | 根 | ACP `mcpServers` | 真实 `~/.dsh`（real 模式） | `DSH_PERMISSION_MODE=danger-full-access` | `real` | 坏 MCP 可能导致 `session/new` 回滚；当前 `isolateSessions` 需在 real 模式关闭 |
| `qoder` | `QODER_CONFIG_DIR` | `~/.qoder` | `qoder/` | `settings.json` 的 `mcpServers` | `qoder/` | `--yolo` | `mirror` | `providers`/`model` 同文件；sandbox 模式下 memory 是真实目录 junction，real 模式天然共享 |
| `cline` | `CLINE_DIR` / `CLINE_DATA_DIR` / `CLINE_MCP_SETTINGS_PATH` | `~/.cline` | `cline/` | `mcp.json`（`CLINE_MCP_SETTINGS_PATH`） | `cline/data/`（SQLite，假设/待实测） | `--auto-approve true` | `real + mcp.json 视图` | sandbox 模式下会话库并发风险；providers/models 需真实登录态 |
| `pi` | `PI_CODING_AGENT_DIR` | `~/.pi/agent` | 根 | `mcp.json` | `sessions/` | 无（默认不逐次审批） | `real + mcp.json 视图` | sandbox 模式下 `pi-acp` 仍读真实 `~/.pi/pi-acp/session-map.json`、`~/.agents/skills`；real 模式正是目标 |
| `claude-code` | `CLAUDE_CONFIG_DIR` | `~/.claude` | `claude/` | ACP `mcpServers` | `claude/` | `session/set_mode bypassPermissions` | `real` | `~/.claude.json` 混状态；sandbox 模式下 `settings.json` 常含网关 token；real 模式直接使用真实配置 |
| `codex` | 无 home env | `~/.codex` | 真实 `~/.codex` | **stdio MCP 支持**（2026-11-12 复测；`mcpCapabilities.acp=false` 只指 MCP-over-ACP） | `~/.codex` | `INITIAL_AGENT_MODE=agent-full-access` + `set_mode` | `real` | 无独立配置目录；原生 `config.toml` 由 Codex 自己加载 |

**结论**：`real` 是目标默认，但“MCP 必须由 WeMind 控制”意味着即使 `real` 也需要对 MCP 段生成 config view。表中的 `real + mcp.json 视图` 指“home / 会话 / 技能仍是真实目录，只把 MCP 文件换成生成视图”；混合文件（opencode / gemini / qoder）直接 `mirror`，把生成范围限制在单个文件。`claude-code` 的 MCP 走 ACP，因此可以保持 `real`，不要为了 MCP 去复制它的 `settings.json`。

---

## 7. 配置同源设计

### 7.1 effective config 的构建顺序

```text
1. real base          真实 Agent 配置（模型/供应商/技能/记忆/设置）
2. overlay            微信独享覆盖（只影响微信侧）
3. MCP policy         brain 默认空 / worker 全量减 wechat；disable/extra
4. role policy        yolo、路径、环境变量、会话目录
5. validation         解析、必填项、wechat 排除、危险路径
6. materialize        real 直接用 / mirror 生成必要文件 / sandbox 复制
```

任何一步失败都要记录原因；不能让 Agent 带着半份配置启动。

### 7.2 real 模式

- 通过 Agent 自己的 `homeEnvVar` 指向 real home，或在必须覆盖单个文件时指向“除该文件外全部链接到 real home”的最小视图；例如 `KIRO_HOME=~/.kiro`、`CLAUDE_CONFIG_DIR=~/.claude`、`PI_CODING_AGENT_DIR=~/.pi/agent`。
- 技能、记忆、会话、插件直接落在真实目录；微信侧写入会立即被终端看到。
- **`real` 不等于把 real 文件原样交给 Agent。** 以下情况必须有覆盖，覆盖方式是“Agent 原生参数 > 独立视图 > 拒绝启动”，绝不在 real home 里原地改写：
  - brain 的 MCP 段（默认空 / 显式激活集）；
  - `wechat` 排除（硬约束：real 配置里含 `wechat` 时，必须生成剔除后的视图；生成不了就拒绝加载，不能“先跑起来再说”）；
  - yolo 只能通过配置文件开启的 Agent（如 opencode `permission`、kiro v3 `permissions.yaml`）；
  - overlay 涉及的键。
- 如果 Agent 支持 ACP `mcpServers` 或命令行参数，优先用原生入口覆盖 MCP / 权限，这样 real 文件可以保持原样。
- 如果 Agent 只从配置读 MCP，且配置不可拆分，则该 Agent 退回 `mirror`；`real` 只适用于“无需覆盖，或 Agent 原生支持分段覆盖”的情况。
- 写 real 配置（包括 `promote`）前必须重新读取并校验 mtime/hash，发现终端侧刚改过就备份并拒绝覆盖，避免“微信侧用旧内容盖掉终端的新内容”。

### 7.3 mirror 模式

用于“配置文件中混有共享设置与必须覆盖的 MCP/权限”的 Agent：

1. 在 `<账号>/agent-view/<role>/<agent>/` 下建立视图（brain 与 worker 分开，避免同一 agent 的两个角色互相覆盖）。
2. 未覆盖的目录/文件尽量用链接指向 real home；这样技能/记忆/会话仍是双向的。平台策略：
   - 目录：Windows 用 junction（不需要管理员权限）；macOS/Linux 用目录 symlink。
   - 单文件：优先 file symlink（真正指向 real 文件，终端原子替换后仍有效）；Windows 无 symlink 权限时退回 hardlink；跨卷或两者都不可用时才复制，并在 `doctor` / 日志里标记“该文件是副本，双向同步可能不完整”。
   - `junction` 只适用于目录，不能拿来链接单个文件。
3. 被覆盖的单文件生成副本；副本 = real + overlay + MCP/yolo 策略。只为**确实需要独立写入**的文件建副本；普通只读文件优先用链接，避免把整份 home 复制一遍。
4. 对生成文件做三路合并：
   - 记录上次同步的 real 快照 `B`、生成文件 `G`；
   - 真实变化 = `diff(B, real)`；生成侧变化 = `diff(B, G)`；
   - 非 overlay 键的变化写回真实文件；overlay 键永不写回；
   - 双方改同一键且值不同 → 保留真实值，写 `.conflict-<时间>`，微信提示登录者。
5. 写回真实文件的格式边界（第一期已实现）：
   - JSON / 无注释 JSONC：读取 → 路径 patch → 备份 → 原子写；
   - **含注释的 JSONC：拒绝命令行写入**，提示用 `config agent edit` 或编辑器修改，避免静默丢注释；
   - YAML / TOML：只读，拒绝写入；等接入 `yaml` Document API 或等价保留格式编辑器后再开放；
   - 写前比对 mtime + size + sha256；终端侧在“读—改—写”之间改过就拒绝覆盖，要求重新读取。
6. **硬链接只用于“不会被 WeMind 独立改写”的文件。** 硬链接写入会直接落到真实文件；如果该文件需要镜像/回滚，必须用副本 + 三路合并，不能硬链接。目录优先用 junction/symlink；单文件按上面的平台顺序选择 symlink / hardlink / 副本，不假装“副本也是双向的”。
7. **含密钥的文件默认不复制。** 优先用 ACP / CLI 参数避免复制；必须复制时（如某些 Agent 的 `settings.json` 混有网关 token）只允许写到 0600 的账号目录、纳入敏感文件 denylist、并在 `doctor` 中明确告警；不能把密钥写进 overlay 或 env 快照。无法避免复制且用户不接受时，该 Agent 标记为 `real-only` 或 `sandbox`，不静默复制。

### 7.4 sandbox 模式

保留现有 `brain-home` / `worker-home` 行为，用于：

- 多账号由不同人使用；
- 不可信任务；
- Agent 有全局锁/不支持共享 home；
- 用户显式选择隔离。

### 7.5 overlay 格式

位置：`<账号>/agent-overrides/<agent>.json`

```json
{
  "version": 1,
  "config": {
    "settings/cli.json": {
      "chat.defaultModel": "claude-sonnet-4.5"
    }
  },
  "mcp": {
    "disable": ["heavy-server"],
    "extra": {
      "my-extra": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "my-mcp"]
      }
    }
  }
}
```

规则：

- `config` 的键是“相对 real home 的文件路径”，值是路径级 patch。`/` 与 `\` 都接受，内部统一按平台分隔符归一化；默认禁止 `..` 逃出 real home；只有该 Agent 显式声明为 `extraConfigFiles` 的目标（如 Claude Code 的 `~/.claude.json`）才允许用相对路径指过去。
- `null` 表示删除该键；数组第一期整段替换，不做元素级 merge。
- **不设“安全键 / 禁止键”白名单**：任何 real 配置键都允许被 overlay 覆盖。用户明确表示没有“必须独享、或绝对不能独享”的键，因此不为了想象中的风险引入一套难以维护的键分类。
- 所有写入仍必须经过：JSON/JSONC 解析 → 未知键告警 → 危险路径/越界路径拒绝 → 写前备份 → 并发快照校验 → 原子写。YAML/TOML 在第一期只读。安全性来自校验与回滚，不来自键白名单。
- overlay **不保存密钥**：`mcp.extra` 的认证信息通过环境变量/密钥链注入；发现 `*_KEY`、`*_TOKEN`、`*_SECRET`、`*_PASSWORD`、`*_CREDENTIAL*` 字面值要告警并拒绝写入。
- `mcp.disable` 从有效集中移除；`mcp.extra` 增加真实配置没有的 MCP（brain 与 worker 都可用，但 brain 是否自动加载仍由激活集决定）。`extra` 使用中性描述（`type: stdio|http` + `command/args/env` 或 `url/headers`），由各 Agent 适配器转成原生格式；不支持的类型明确拒绝，不猜测。
- **工作区不放进 agent overlay**：它是“账号 + 角色（brain/worker）”级配置，放在 `<账号>/workspace.json`（见第 9 章）。把工作区塞进 per-agent overlay 会导致切换 Agent 时工作区跟着变，不符合“brain / worker 各一个默认工作区”的目标。
- overlay 只影响微信侧，**永不自动写回真实配置**；需要提升为共享配置时用显式 `promote` 命令。
- overlay 落到视图时，目标路径若是指向 real 的 symlink/junction，必须先断开链接再写副本；绝不能穿透链接改到真实文件。
- 未知键、解析失败、危险路径要告警/拒绝，不能静默忽略。

### 7.5.1 账号级微信设置（预留）

`agent-overrides/<agent>.json` 只放**与某个 Agent 配置相关**的覆盖。工作区放在 `workspace.json`；回复风格、进度提示、默认语气这类 WeMind 自身行为也不属于 Agent 配置，不应塞进 agent overlay。预留 `<账号>/wechat-settings.json`：

```json
{
  "version": 1,
  "replyStyle": null,
  "progress": null
}
```

第一期只创建空文件与读取入口，不定义具体字段语义；等真正需要时再补。这样既不会把“微信独享配置”做成一个大杂烩，也不会限制未来扩展。

### 7.6 修改入口

| 入口 | 行为 |
|---|---|
| 直接编辑 overlay 文件 | 支持。也可以直接用编辑器打开 `<账号>/agent-overrides/<agent>.json`；建议用 `wemind config wechat edit <agent>`，它会先校验再落盘 |
| CLI | `wemind config wechat get/set/unset <agent> <path> [value]` |
| 微信自然语言（第一期） | 用户明确说“微信侧 / 仅微信 / 这边”时，优先走确定性指令 `微信配置 ...`；模型不参与路径与 JSON 的拼装 |
| 微信自然语言（第三期，预留） | 由 WeMind 自带 admin MCP 暴露 `wechat_config` / `agent_config` 工具；工具调用 daemon 的内部配置服务，做校验、备份、原子写与 idle reload。ACP 没有“宿主注册工具”的标准方法，因此不能把这一步写成现成能力 |
| 默认配置修改 | 用户没有说“微信侧”时，Agent 直接改真实配置；这是默认语义。CLI 提供 `wemind config agent edit/set/unset`；微信侧在第一期通过“对话 + `wemind config agent ...` CLI”或确定性指令完成，二者都做备份、并发校验与原子写 |

因此“能不能直接跟大模型说‘把模型改成 X’”——可以，且默认就是改真实配置。只有用户明确说“微信侧 / 仅微信 / 这边”时，才写 overlay。自然语言修改必须走受控入口，不让模型猜路径：第一期是确定性微信指令 / `wemind config` CLI；第三期才评估 admin MCP 工具。无论哪一期，写入层都负责校验、备份、原子写、触发 idle reload，并回复“已写入微信侧，下一次新会话生效”。

### 7.6.1 `wechat_config` / `agent_config` 的实现链（第三期预留）

> 这一节回答“Agent 调用 `wechat_config` 到底是怎么发生的”。结论先说：**它不是 ACP 宿主直接注册给模型的工具，而是一个本地 MCP server**。当前代码尚未实现；第一期只有确定性微信指令与 `wemind config` CLI。

#### 为什么必须绕到 MCP

ACP 的 client（WeMind）能处理的反向请求是固定的：`session/request_permission`、`fs/read_text_file`、`fs/write_text_file`、`terminal/*` 等。协议里**没有** `tools/register`、`tool/call` 这类“宿主向 agent 注册任意工具”的方法。agent 能看到的工具只有两类：

1. agent 自己的内置工具（shell、文件读写、搜索等）；
2. `session/new` / `session/load` / `session/resume` 的 `mcpServers` 参数带进去的 MCP server 工具。

所以要让模型看到名为 `wechat_config` 的工具，唯一标准路径是：**WeMind 自己起一个 MCP server，把工具声明通过 MCP 暴露给它**。`fs/*` 反向请求可以拦截“模型用普通文件工具写配置”，但它不是命名工具，也没有 schema、作用域和审计语义，不能拿它冒充 `wechat_config`。

#### 组件

| 组件 | 职责 |
|---|---|
| Admin MCP server | 一个本地 MCP server，声明 `wechat_config` / `agent_config` 两个工具；只接受本账号、本 agent、本角色的调用 |
| ConfigService | 与 CLI 共用的配置服务：解析路径、合并 patch、密钥/越界校验、备份、并发快照校验、原子写、审计 |
| Config view / overlay | `scope=agent` 改真实配置；`scope=wechat` 只改 `<账号>/agent-overrides/<agent>.json`，不碰真实文件 |
| Control bridge | Admin MCP 写完配置后投递 `config.reload`；daemon 在空闲时重建视图/重启 brain |

#### 怎么注入

- **支持 ACP MCP 的 agent**（`mcpViaAcp`，如 DSH / Claude Code / Copilot）：在 `session/new`、`session/load`、`session/resume` 的 `mcpServers` 数组里追加一个 `wemind_admin` 条目。例如 stdio：

  ```json
  {
    "name": "wemind_admin",
    "command": "node",
    "args": ["<WeMind 安装目录>/dist/admin-mcp.js"],
    "env": [
      { "name": "WEMIND_ACCOUNT", "value": "<账号 key>" },
      { "name": "WEMIND_ADMIN_TOKEN", "value": "<每次会话随机生成>" },
      { "name": "WEMIND_ROLE", "value": "brain" },
      { "name": "WEMIND_AGENT", "value": "claude-code" }
    ]
  }
  ```

  如果 agent 支持 HTTP MCP，则优先由 daemon 起一个只监听 `127.0.0.1` 的 HTTP MCP，`mcpServers` 里只放 URL + `Authorization` header。这样不会每个会话多一个 Node 子进程，启动成本更低。

- **只从配置文件读 MCP 的 agent**（kiro / opencode / gemini / qoder / cline / pi）：把 `wemind_admin` 写进 WeMind 生成的 config view 的 MCP 文件，**不写真实配置**。终端自己开的会话看不到这个工具，只有微信侧视图能看到。
- **不支持客户端 MCP 的 agent**（如 codex 适配器）：没有 `wechat_config` 工具，退回“模型通过 shell 调 `wemind config ...`”的 CLI 路径。

#### 一次调用的完整链路

1. 微信用户说“把模型换成 X”或“微信侧回复简短一点”。
2. daemon 把消息作为 `session/prompt` 发给 brain。
3. 模型根据工具描述选择 `agent_config`（默认，真实配置）或 `wechat_config`（仅微信侧）。它发出的是 MCP `tools/call`，不是 shell 命令。
4. agent 内置的 MCP client 把 JSON-RPC 请求发给 `wemind_admin`（stdio 或 loopback HTTP）。
5. Admin MCP 校验 `WEMIND_ADMIN_TOKEN`，并核对 token 绑定的账号 / agent / 角色与当前进程一致；不匹配直接拒绝。
6. ConfigService 解析目标文件：
   - `scope=agent`：按 agent preset 解析真实配置路径（只允许该 agent 的已知配置根内）；
   - `scope=wechat`：`<账号>/agent-overrides/<agent>.json`。
7. 读取当前文件，比对调用方带来的 `expectedRevision`（或服务端刚生成的 mtime/size/hash）；发现终端侧刚改过就返回冲突，不覆盖。
8. 应用路径 patch（`set` / `unset` / `mcp.enable` / `mcp.disable` / `mcp.add` / `mcp.remove`），拒绝疑似密钥键、`..` 越界、指向真实配置之外的路径。
9. 备份原文件（最多保留 5 份）→ 同目录临时文件 → `rename` 原子替换 → 追加审计记录（谁、什么时间、哪个文件、改了哪些键、备份在哪）。
10. 返回 MCP 工具结果，例如：

    ```json
    {
      "ok": true,
      "scope": "agent",
      "agent": "claude-code",
      "file": "<HOME>/.claude/settings.json",
      "changed": ["model"],
      "backup": "<HOME>/.claude/settings.json.wemind-bak-2026-11-12T...",
      "effective": "new-session",
      "revision": "sha256:..."
    }
    ```

11. Admin MCP 向控制桥投递 `config.reload`。daemon 若正在跑回合，就把 reload 排到空闲；否则重建 config view，必要时重启 brain/worker 进程。
12. 模型看到工具结果，用自然语言回复“已改真实配置，新会话生效”；daemon 把回复发回微信。

#### 工具契约

建议暴露两个工具，而不是一个含糊的 `wechat_config`：

| 工具 | 作用域 | 使用条件 |
|---|---|---|
| `agent_config` | 真实配置（默认） | 用户没有明确说“微信侧/仅微信/这边”时使用 |
| `wechat_config` | 微信侧 overlay | 只有用户明确要求微信独享配置时使用 |

两者共用参数结构：`action`（`get` / `set` / `unset` / `list` / `mcp_enable` / `mcp_disable` / `mcp_add` / `mcp_remove` / `reload`）、`agent`、`path`、`value`、`role`（`brain` / `worker`）、`expectedRevision`、`dryRun`。工具描述必须写清“默认改真实配置；只有用户明确说微信侧才用 `wechat_config`；不要写密钥”。这样作用域由工具名 + 描述双重约束，审计日志也能直接看出模型选的是哪一侧。

#### 安全边界

- **yolo 不等于无校验**：yolo 只关掉 OS 权限询问；MCP 工具仍然做 token、账号、路径、密钥、并发和备份校验。
- **token 绑定**：每次会话生成随机 token，绑定账号 + agent + 角色；Admin MCP 不接受跨账号调用。HTTP 模式只监听 loopback，并要求 `Authorization`。
- **不是 shell**：工具只接受结构化 JSON，不接受任意命令/路径；不会把“写配置”变成“执行任意程序”。
- **审计与回滚**：每次写入都有备份和审计；冲突时拒绝覆盖，不静默赢。
- **硬边界仍是 `wechat` 排除**：任何 scope 都不允许把 `wechat` MCP 加进 brain/worker 的有效集；按名字和定义双重判断。
- **提示注入**：在 yolo + 真实 HOME 下，恶意提示仍可能让模型走 shell 绕过工具。`wechat_config` 是便利与审计层，不是对抗被攻陷模型的 OS 沙箱；真正的隔离需要独立 OS 用户/VM。

#### 成本

- stdio Admin MCP 每个会话多一个小 Node 进程（约几十 MB 内存、几十到几百毫秒启动），会拖慢 brain 首帧；HTTP 模式由 daemon 常驻，成本低得多。
- 因此建议：**brain 默认不注入 Admin MCP**，只在用户显式开启“自然语言改配置”或该 agent 没有 shell 时注入；worker 默认也不注入。第一期继续用 CLI 路径，第三期再按需开启。

### 7.7 reload 策略

- 配置来源变化用 mtime + hash 检测；轮询间隔建议 2–5s，防抖 300–500ms。
- 忽略 WeMind 自己刚写入的 hash，避免回环。
- brain 在**空闲**时 reload；有在途回合则排队，不中途换模型/权限/MCP。
- worker 在每次 `acquire` 时刷新；任务运行中不热切换。
- 无法 reload 的 Agent 明确提示“需要新会话/重启 daemon”。
- `wemind config reload` 提供手动入口。

---

## 8. MCP 设计

### 8.1 角色策略

| 角色 | 默认有效集 | 持久化 | 说明 |
|---|---|---|---|
| brain | **空** | `<账号>/brain-mcps.json`（按 agent 分键） | 用户显式 `加载` 后，后续所有由 WeMind 新建的 brain 会话都加载；`卸载` 后移除 |
| worker | （真实配置中的全部 MCP ∪ `extra`）− `wechat` − `disable` | 账号级 overlay | 无人值守任务需要开箱即用的完整能力 |

brain 默认空是为了保证最佳首帧/启动速度；这不是“真实配置里没有”，而是“微信侧不自动加载”。用户显式加载后，激活集持久化到磁盘，跨会话、跨 daemon 重启保留（按 agent 命名空间隔离）。这里的“所有会话”指 WeMind 新建的 brain 会话；终端自己开的会话不受 WeMind 的激活集影响。

“显式加载”与“显式禁用”的优先级：`brain-mcps.json` 记录用户主动加载的集合；overlay 的 `mcp.disable` 永远最后生效。也就是说，即使某个 MCP 曾经被加载过，只要用户明确 disable，它就不会再出现在 brain 的有效集里；重新 `加载` 会把它从 disable 中移除并写回激活集。

### 8.1.1 切换 brain 时的激活集

激活集按 **agent 名称** 分键，不是“当前 brain 进程”的一份全局状态：

| 场景 | 激活集行为 |
|---|---|
| 同一个 agent 新建会话 / daemon 重启 | 保留之前显式加载的集合 |
| 切到另一个 agent | 使用那个 agent 自己的集合；从未加载过就是**空** |
| 切回原 agent | 恢复原 agent 的集合 |
| 当前正在进行的会话 | 不热改；加载/卸载只影响之后新建的会话 |
| worker | 不受 brain 激活集影响，始终是真实全量减 `wechat` |

这样设计的原因是各 agent 的 MCP catalog 不同：A 里有的名字 B 未必有，盲目继承会让 B 启动时挂载失败（DSH 这类 Agent 甚至会回滚整个 `session/new`）。已实现的 `brain-mcps.json` 是 `{ "version": 2, "active": { "<agent>": [...] } }`；读取到旧版 `{ "active": [...] }` 时，会把旧全局列表归到首次读取时的当前 agent，其他 agent 初始为空。

### 8.2 有效集计算

```text
brain:
  catalog = real 已启用 MCP ∪ overlay.mcp.extra
  (brain-mcps.json[agent] ∩ catalog)
  − wechat
  − overlay.mcp.disable

worker:
  (real 已启用 MCP ∪ overlay.mcp.extra)
  − wechat
  − overlay.mcp.disable
```

这样 brain 仍然不会因为 `mcp.extra` 里“存在”某个 MCP 就自动加载；它只有在用户显式 `加载` 后才进入激活集。worker 则按“无人值守任务需要开箱即用”的语义，直接使用真实全量加 extra。

如果 `brain-mcps.json` 里的某个名字在 catalog 中已经不存在（真实配置删了、extra 也删了），不要静默丢弃：保留记录、在 `wemind mcp list` / `doctor` 里标记 `missing`，等用户确认后再清理。

`wechat` 排除按名字和定义双重判断：

- 名字为 `wechat`；
- command/args/url 里跑 `wemind-mcp` 或 `@wemind/wechat-mcp`；
- agent 自己配置里的微信 MCP 同样剔除，真实文件不动。

### 8.3 传输方式

| Agent | 写入位置 |
|---|---|
| kiro | `settings/mcp.json`（生成视图） |
| gemini | `.gemini/settings.json` |
| qoder | `settings.json` 的 `mcpServers` |
| opencode | `opencode.json` 的 `mcp.servers` |
| cline | `mcp.json`（`CLINE_MCP_SETTINGS_PATH`） |
| pi | `<agent-dir>/mcp.json` |
| DSH / Claude Code / Copilot | ACP `session/new|resume` 的 `mcpServers` |
| codex | 支持客户端 stdio MCP；微信侧 `加载/卸载` 可下发 catalog/overlay 额外项；原生 `~/.codex/config.toml` 由 Codex 自己加载，同名原生优先。WeMind 只读解析 TOML 用于列出/指标，不写回，也无法 unload 原生项；原生含 `wechat` 时拒绝启动 |

**“通过 ACP 传 MCP”不等于“覆盖真实配置”。** 有些 Agent 会把 ACP `mcpServers` 与自己的配置文件合并；brain 默认空集要求最终有效集为空，所以每个 Agent 都必须实测“传空列表是否真的不加载”，不能假设 ACP 参数会替换。若 Agent 只做增量合并，则 brain 必须生成剔除 MCP 的视图，或提供明确的 disable 参数；两者都没有时，该 Agent 不能承诺“brain 默认空 MCP”，必须在能力矩阵中标注。

### 8.4 性能与观测

MCP 数量会同时影响：

- **启动**：每个 stdio MCP 一次子进程启动 + 握手；HTTP MCP 一次网络连接；失败会等到超时。
- **首帧**：工具 schema 进入模型上下文，增加 prefill 和 token 成本，可能降低工具选择准确率。
- **内存**：每个 MCP 进程都占内存。

设计约束：

- 不自动禁用“成功但慢”的 MCP；只警告，避免微信侧行为悄悄偏离终端。
- 记录 `mcpCount`、`mcpStartupMs`、`sessionNewMs`、`firstFrameMs`（已实现，`agents/config/mcp-perf.ts`）；`scripts/doctor.ps1` 在数量/耗时异常时提示（阈值与代码里的常量保持一致）。
- 启动前做轻量 preflight；坏条目跳过并告警。
- DSH 这类“坏 MCP 会回滚整个 session”的 Agent 必须先预检，必要时拒绝启动并给出明确原因。
- 用户可用 `mcp.disable` 显式关闭重型 MCP；微信侧额外 MCP 用 `mcp.extra`。brain 的 `mcp.extra` 只是“可加载目录”，仍需显式 `加载`；worker 的 `mcp.extra` 默认生效。

---

## 9. 工作区设计

### 9.1 要求

- 绝对路径、已存在、是目录；显式指定时不自动创建任意路径。
- 本地磁盘，realpath 可解析；Windows 拒绝 UNC（`\\server\share` / `//server/share`），所有平台都拒绝显式网络挂载语义（例如 `file://host/...`）。
- 当前用户可读写；POSIX 默认目录 0700、文件 0600，Windows 用数据目录自身的 ACL（`chmod` 是 no-op，不能假装等价）。
- 不能是账号根目录（`<账号>/` 本身）、`brain-home`、`worker-home`、Agent 真实配置目录、系统目录或家目录根。
- 路径稳定；`session/new` 的 `cwd` 是会话身份的一部分。
- 项目级技能/规则需要项目根时，用户应把工作区指到项目根。
- `external` 工作区不随账号删除；`managed` 工作区随账号清理。

### 9.2 默认布局

```text
~/.wemind/<账号>/
├── workspace/
│   ├── brain/       # brain 默认 managed 工作区
│   └── worker/      # worker 默认 managed 工作区
└── workspace.json   # 覆盖配置
```

`workspace.json`：

```json
{
  "version": 1,
  "brain": { "mode": "managed" },
  "worker": { "mode": "managed" }
}
```

`managed` 不需要写 `path`；代码按账号目录计算，账号目录整体搬家后仍然有效。只有 `external` 必须写绝对路径。

外部项目：

```json
{
  "version": 1,
  "brain": { "mode": "external", "path": "D:\\projects\\my-app" },
  "worker": { "mode": "external", "path": "D:\\projects\\my-app" }
}
```

“外部项目目录”不是把项目复制进账号目录，也不是给每个项目建一套独立配置；它只是把该账号 brain / worker 的**默认工作区**指向一个已存在的项目根。按账号配置的原因是：同一台机器上的两个微信号可能分别服务两个项目，各自需要不同的 `cwd`。第一期不引入“命名工作区列表”，每个角色只有一个默认值，避免把简单问题做成工作区管理器。

### 9.2.1 账号目录中的新增与变化项

| 路径 | 生效模式 | 作用 |
|---|---|---|
| `workspace/{brain,worker}/` | 全部 | 默认 managed 工作区；首次启动创建，0700 |
| `workspace.json` | 全部 | brain / worker 的默认工作区覆盖；唯一权威 |
| `session-cwd.json` | 全部 | `<agent>:<sessionId> → cwd`；恢复会话时校验 |
| `agent-overrides/<agent>.json` | 全部 | 微信独享的 Agent 配置 patch 与 MCP 增删 |
| `agent-view/<role>/<agent>/` | `real` / `mirror` | 生成的配置视图；brain 与 worker 分目录，避免互相覆盖 |
| `wechat-settings.json` | 全部 | 预留的账号级微信行为设置（回复风格等），第一期空 |
| `env.json` | 可选 | 非敏感环境快照（PATH/代理/locale），不含密钥 |
| `brain-mcps.json` | 全部 | brain 显式激活的 MCP 集；按 agent 分键 |
| `media/inbound/` | 全部（`real` 新增） | 入站文件/视频/无转写语音；`sandbox` 仍放各自 home 下 |
| `brain-home/`、`worker-home/` | 仅 `sandbox` | 旧沙箱布局；`real` 模式不再创建 |
| `brain-sessions.json`、`worker-sessions.json`、`session-registry.json` | 全部 | 会话指针与展示元数据，语义不变 |

`real` 模式的新入站媒体统一写到 `<账号>/media/inbound/`；迁移时把旧 `brain-home/media/inbound/` 整体搬到新位置，失败则保留备份并告警。`sandbox` 模式保持现有 `<sandbox>/media/inbound/`，避免一次改动同时动两套路径。该路径变化必须同步更新 `AGENTS.md` §4.19、`media-store` 测试与数据目录速查。其余账号数据（token、state、tasks、control-inbox/out、日志）保持现状，详见 [速查：数据目录与环境变量](../使用指南/速查-数据目录与环境变量.md)。

### 9.3 会话绑定

- 新建 session 时把 `cwd` 传入 `session/new`。
- 已有 session 保持原 cwd；改默认工作区只影响下一条新会话。
- 设置/重置工作区时，微信与 CLI 都提示“需要新会话才能生效”。
- 恢复旧会话时使用该 session 记录的 cwd；如果 Agent 不接受新 cwd，则明确报错或新建，不静默搬家。
- 新增 `<账号>/session-cwd.json`（建议）或在 `session-registry.json` 记录 cwd；`brain-sessions.json` 的 string→string 格式保持兼容。
- 旧会话没有 cwd 记录时，优先用 Agent 自己保存的会话 cwd；两者都没有才回落到当前默认工作区，并在日志/回复里标注“旧会话 cwd 未知”。

### 9.4 worker 工作区

- 每个任务有自己的 `cwd`；`--cwd` 优先，其次任务创建时的默认工作区。
- 任务续跑使用 `tasks.json` 里保存的 cwd，不使用当前默认工作区。
- 并发任务共享 workspace 时，文件冲突由任务自身负责；可用不同 `--cwd` 隔离。

### 9.5 危险路径确认

以下路径拒绝或要求二次确认：

- 账号根、`brain-home`、`worker-home`；
- Agent real home（如 `~/.kiro`、`~/.claude`）；
- 家目录根、系统目录、磁盘根；
- 解析后指向上述位置的 symlink/junction；
- Windows UNC / 所有平台的显式网络路径。

---

## 10. 环境设计

### 10.1 默认：继承 daemon 环境

- API key、token、密码继续由系统环境或密钥链提供，**不写入账号目录**。
- Agent 进程继承 daemon 的 `process.env`，再叠加预设的 `env` / `envDefaults`。
- 不针对 fnm 写死任何路径或 hook；fnm 只是“可能改变 PATH 的来源”之一。

### 10.2 可选：非敏感环境快照

后台/自启动 daemon 可能拿不到交互 shell 的 PATH。这个问题不只属于 fnm：nvm、Volta、asdf、mise、corepack、conda/pyenv、包管理器 shim、用户级 bin 目录，以及代理/locale 设置，都可能只存在于登录 shell 里。因此设计提供通用的环境捕获，而不是为某个版本管理器写适配：

```text
wemind env capture [--key <key>] [--dry-run]
```

在**能正常执行目标 Agent 的终端**里运行即可；它读取当前进程环境，不猜测 shell、不解析 fnm/nvm 配置，也不执行任何版本管理器的 hook。无论 PATH 是被哪种工具改的，捕获到的都是同一份最终 PATH。

写入 `<账号>/env.json`，只允许白名单键：

- `PATH`、`PATHEXT`、`ComSpec`、`SystemRoot`；
- `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`；
- `LANG`、`LC_*`、`TZ`；
- `NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE`；
- 其它显式配置的非敏感变量。

其中 `PATHEXT` / `ComSpec` / `SystemRoot` 只在 Windows 有意义；其它平台忽略即可，不要求用户提供。白名单按平台过滤，不做“一套键假装跨平台”。

禁止：`*_KEY`、`*_TOKEN`、`*_SECRET`、`*_PASSWORD`、`*_CREDENTIAL*`。POSIX 下文件 0600；Windows 下 `chmod` 是 no-op，依靠账号目录 ACL，不能把 0600 当成跨平台保证。加载时再次做模式匹配，命中就丢弃并告警。

合并顺序固定为：daemon 环境 → 快照中的白名单键覆盖 → Agent 预设的 `env`（显式要求）→ `envDefaults`（仅缺省时补）。快照对白名单键是权威的；没捕获的变量继续继承 daemon。若用户不想保存任何环境信息，保持默认“继承 daemon 环境”即可。

为什么放在账号目录：不同账号可能使用不同的 Node 版本、代理或 locale；快照按账号隔离，daemon 重启 / 开机自启后不需要重新打开交互终端。它保存的是**环境形状**，不是密钥——API key、token、密码仍由系统环境或密钥链提供，禁止落盘。PATH 里可能含用户名或私有安装路径（不是密钥，但属于本机信息），因此 `env.json` 仍按 0600 保存。

### 10.3 版本管理器与登录 shell（通用）

不假设用户使用 fnm，也不假设 PATH 一定来自 shell profile。Agent 可执行文件的解析顺序：

1. **显式覆盖**：`--bin` / `WEMIND_BRAIN_BIN` / 预设的 `fallbackBinPaths`（仅限已知安装器的固定位置，必须逐 Agent 记录）。
2. **最终 PATH**：daemon 继承的 PATH + `env.json` 快照覆盖后的结果。
3. **失败要可操作**：找不到时明确提示“在能运行 `<agent> --version` 的终端执行 `wemind env capture`”，而不是让用户去猜 fnm/nvm 配置。

`wemind doctor` 对每个 Agent 打印：解析到的 bin 绝对路径、来源（显式 / 快照 / 继承 PATH / fallback）、`--version` 是否成功。这样 fnm、nvm、Volta、asdf、mise、corepack、conda 或手工 PATH 都能用同一套诊断，不需要在代码里枚举。

后台运行环境不会自动加载交互 shell 的配置：Windows 计划任务不执行 PowerShell profile，macOS launchd / GUI 启动不继承终端 shell 环境，Linux systemd user service 也不保证登录 shell 的 PATH。因此 `env capture` 是跨平台的通用补充，不是 fnm 专用开关。

---

## 11. 会话设计

### 11.1 共享会话库

把会话留在 Agent 自己的会话库，而不是 WeMind 再建一套聊天历史，是有意的取舍：

| 好处 | 代价 / 缓解 |
|---|---|
| 终端 `session list` 能看到微信会话，符合“终端等效” | 会话标题、排序由 Agent 决定，WeMind 只能展示它提供的元数据 |
| 恢复、压缩、分支、工具调用记录都复用 Agent 原生能力 | Agent 升级可能改变会话布局；能力矩阵记录版本与已知坑 |
| 不重复存储，不需要把 ACP 帧重新拼成历史 | 删除语义要写清楚：WeMind 只删登记/指针，Agent 历史仍在 |
| 终端与微信可以各自开新会话，互不打断 | 同一 Agent 的并发写入需按 Agent 实测（SQLite / 全局锁） |

因此 WeMind 的 `brain-sessions.json` / `worker-sessions.json` 只负责“微信当前用哪条 session”，不试图成为第二套会话库。

- 配置同源后，Agent 的会话库落在 real home；微信创建的 session 与终端 session 在同一个 Agent 会话库中。
- 终端 Agent 的 `session list` 应能看到微信产生的会话；具体显示名称/标题由 Agent 自己决定。
- WeMind 的 `brain-sessions.json` 仍是“微信当前用哪条 session”的权威；它不替代 Agent 的会话库。

### 11.2 会话键

- brain：`<agent>:<userId> → sessionId`。
- worker：`<agent>:task-<编号>@<userId> → sessionId`。
- 切换 Agent 不覆盖其他 Agent 的会话。
- 新增 cwd 记录：建议 `session-cwd.json`，键 `<agent>:<sessionId>`；`session-registry.json` 增加 `cwd` 仅用于展示。

### 11.3 DSH 的处理

- `sandbox` 模式保留 `isolateSessions: true`，避免与 kiro/pi 共用沙箱根时的 `unsupported flat-file layout`。
- `real` 模式关闭 `--patch`，让 DSH 使用真实 `~/.dsh` 会话库，终端可见微信会话。
- 如果 DSH 升级后出现会话布局冲突，回退 `mirror` 或 `sandbox` 并记录已知坑。

### 11.4 删除语义

- `删除会话` 仍只删 WeMind 的登记/指针，不删除 Agent 自己的历史（除非 Agent 支持 `session/delete` 且用户明确要求）。
- `wemind delete` 删除账号目录；不删除 real home、external workspace、Agent 会话库。
- 文档与回复必须写清楚“Agent 自己那份历史仍在它的存储里”。

---

## 12. 权限与 yolo

### 12.1 Agent 侧

| Agent | 免审批方式 |
|---|---|
| kiro v2 | `acp --trust-all-tools` |
| kiro v3 | 生成 `settings/permissions.yaml` allow-all（真实文件已有则尊重） |
| gemini | `--acp --approval-mode yolo --skip-trust` |
| copilot | `--allow-all-tools`（不启用完整 `--allow-all` 的路径/URL 放宽） |
| opencode | 生成 `opencode.json` 的 `"permission": "allow"` |
| DSH | `DSH_PERMISSION_MODE=danger-full-access` |
| qoder | `--acp --yolo` |
| cline | `--acp --auto-approve true` |
| pi | 无（默认不逐次审批） |
| claude-code | `session/set_mode {modeId:"bypassPermissions"}` |
| codex | `INITIAL_AGENT_MODE=agent-full-access` + `session/set_mode` |

### 12.2 宿主侧

- `session/request_permission` 默认仍拒绝；parity 模式下建议账号级默认开启 `WEMIND_ACP_AUTO_ALLOW=1`，对边缘请求自动 `allow_once`。
- 不是所有 Agent 的 yolo 都等价；Copilot 的路径/URL 限制、DSH/codex 的沙箱层仍需在接入文档中标注。
- 启动时日志与 `wemind doctor` 明确打印“当前为 yolo / 完整用户权限”，避免误以为有隔离。

---

## 13. 多账号与并发

### 13.1 多账号

- WeMind 账号数据继续按 `<账号>/` 隔离：token、state、session 指针、tasks、overlay、workspace、日志。
- Agent 真实配置、技能、记忆、会话库默认共享。
- 每个账号可有独立的 `agent-overrides/<agent>.json`、`workspace.json`、`brain-mcps.json`。
- 多个 daemon 可同时运行；每个 daemon 各自拉起 Agent 进程。

### 13.2 并发假设

按“Agent 支持并发会话/进程”设计，但增加能力矩阵与测试：

- 同一 Agent 在终端与微信同时运行；
- 同一账号多个 worker 并发；
- 多个 WeChat 账号同时运行。

需要验证：

- 配置写入是否互相覆盖；
- 会话库/SQLite 是否支持多进程；
- 是否有全局锁/单实例限制；
- MCP 子进程是否重复拉起、端口是否冲突。

### 13.3 失败回退

如果某个 Agent 被实测不支持共享 real home：

1. 标记 `sharedHome: unsupported`；
2. 该 Agent 默认 `mirror` 或 `sandbox`；
3. `wemind doctor` 与文档明确说明；
4. 不因为单个 Agent 影响其他 Agent 的 parity 默认。

---

## 14. 安全与护栏

必须保留：

- `wechat` MCP 按名字和定义双重排除，真实配置中的微信 MCP 也不加载。
- 出站附件敏感文件 denylist、UNC/网络路径拒绝、NTFS 数据流拒绝、大小上限。
- 工作区不能是账号根、Agent real home、系统目录；危险路径二次确认。
- 不把 API key/token 写入 overlay、env 快照；镜像视图若必须复制含密钥文件，按 7.3 的 0600 + 敏感文件 denylist + 告警处理，且不得进入 overlay。
- 写真实配置前备份；用 mtime/hash 做乐观并发校验，发现终端侧刚改过就拒绝覆盖并写 `.conflict-<时间>`；原子写。
- 启动日志/`doctor` 明确提示 yolo 与完整权限。

已知但接受的边界：

- 同一 OS 用户下，Agent 可通过 shell 读取账号目录/控制桥/任务目录；工作区不是安全边界。
- 需要更强隔离时，使用独立 OS 用户、容器或虚拟机，或 `sandbox` 模式。
- 硬链接无法从路径区分，属于已接受风险。

---

## 15. 迁移

### 15.1 新账号

- 默认 `homeMode = real`。
- 创建 `<账号>/workspace/{brain,worker}`、`media/inbound`、`agent-overrides/` 目录与空的 `wechat-settings.json`；不主动写 `workspace.json` / `runtime.json`（缺省分别就是 managed / real，账号目录搬家后不会留下失效绝对路径）。某个 Agent 第一次被使用时再创建它的空 overlay。
- 不创建 `brain-home` / `worker-home`，除非用户选择 `sandbox`。

### 15.2 老账号

用户接受“迁移不了可以丢数据”，因此采用“尽力迁移、必须备份”：

1. 先把 `brain-home/media/inbound/` 搬到 `<账号>/media/inbound/`；失败则保留原目录并告警。
2. 检测到 `brain-home` / `worker-home` 时，重命名为 `brain-home.bak-<时间>` / `worker-home.bak-<时间>`，保留回滚。
3. 尝试把旧会话文件复制到对应 real home 的会话目录；布局不兼容就跳过并记录。
4. 生成新的 `workspace.json`、空 overlay、空 `wechat-settings.json`、`session-cwd.json`。
5. 迁移 `brain-mcps.json`：旧全局激活集只归到迁移时的当前 agent，其他 agent 初始为空；无法映射的 MCP 记录告警。
6. 启动后微信通知登录者“已切换到 real 模式；旧数据备份在 …”。
7. `wemind config migrate --rollback` 可恢复旧沙箱目录与模式；已搬走的入站媒体按记录搬回，搬不回的留在新位置并提示。

不自动删除备份；由用户确认后清理。

---

## 16. CLI 与微信交互

### 16.1 CLI

| 命令 | 作用 |
|---|---|
| `wemind config show [--key <key|label>]` | 显示 homeMode、real home、overlay 目录、workspace、env 快照键与 MCP 激活集文件 |
| `wemind config home-mode [real|mirror|sandbox]` | 查看/写入 `<账号>/runtime.json`；重启 daemon 后生效 |
| `wemind config reload [--key <key|label>]` | 经控制桥重建 config view，空闲时重启常驻 brain |
| `wemind config agent show|get|set|unset|edit <agent> [<键路径>] [值] [--file <相对路径>]` | 默认修改真实 Agent 配置；写入前备份并做并发校验 |
| `wemind config wechat show|get|set|unset|edit <agent> [<file#键路径>] [值]` | 只读写微信独享 overlay，不碰真实文件 |
| `wemind workspace show|set <绝对路径>|reset [--role brain|worker] [--key <key|label>]` | 查看/设置/重置工作区；提示新会话生效 |
| `wemind mcp list|enable|disable|add|remove [--key <key|label>]` | 管理 brain 的 MCP 激活集与 overlay `disable`/`extra`；worker 不通过该命令单独配置 |
| `wemind env capture|show|clear [--dry-run] [--key <key|label>]` | 捕获/查看/清除非敏感环境快照；`--dry-run` 只预览 |
| `wemind config promote` / `wemind doctor` | **Phase 2/3 预留**，当前未实现；不要写进用户说明当作现成命令 |

### 16.2 微信

- `加载 <MCP>` / `卸载 <MCP>`：brain 激活集；只影响新建的 brain 会话，当前会话不变，需要新会话生效。
- 真实配置里没有的额外 MCP：先通过 `微信配置` / `wechat_config` 工具写入 `mcp.extra`，再 `加载`（brain）或直接生效（worker）；不在聊天里让模型手写 JSON。
- `工作区` / `设置工作区 <路径>` / `重置工作区`：仅登录者；回复“需要新会话生效”。
- `微信配置 ...`：确定性入口，避免自然语言歧义。
- 自然语言“微信侧用模型 X”：第一期通过确定性指令或 `wemind config wechat ...` CLI 落盘；第三期才评估 admin MCP 的 `wechat_config` 工具。不要把“自然语言直接调用工具”写成当前已实现能力。

---

## 17. 实施阶段

### Phase 0：设计定稿（已完成）

- 本文评审、确认命名、确认安全前提。
- 建立 Agent 能力矩阵与验收用例。

### Phase 1：核心 parity 模式（已实现，待逐 Agent 真机验收）

- `homeMode` 抽象与 `ConfigViewBuilder`。
- `real` 模式 + 必要的 MCP/yolo 生成文件。
- brain 默认空 MCP、显式加载持久；worker 全量减 `wechat`。
- `workspace.json`、brain/worker 默认工作区、会话 cwd 绑定、变更提示。
- `agent-overrides`、`wechat-settings.json`、`session-cwd.json` 与 `real` 模式入站媒体路径。
- `env capture`（通用 PATH / 版本管理器 / 代理；不含密钥，不绑定 fnm）。
- 会话共享与终端可见（先验 kiro / opencode / qoder / gemini / claude-code）。
- 配置 reload / hash 检测 / 冲突备份。
- 老账号迁移：已实现尽力迁移（搬入站媒体、旧 `brain-home`/`worker-home` 重命名备份）；会话布局迁移只做能识别的部分，失败不阻塞启动。`config migrate --rollback` 尚未实现，回滚依靠 `.bak-*` 目录人工恢复。

### Phase 2：剩余 Agent 与 mirror 合并（未开始）

- ✅ 已完成：MCP/首帧观测 + doctor 告警；Codex `config.toml` 只读 MCP 解析与 `wechat` 拒绝启动；`codex-acp 2.6.0` 全套探针复测。
- ✅ 已完成（握手级）：10 个预设里 8 个已装 Agent 的 `brain check` 矩阵通过（kiro / qoder 本机未安装）。
- ✅ 已完成（prompt 级）：`homeMode=real` 下 9/10 跑通两轮真实对话（opencode / gemini / cline / pi / copilot / codex / kiro / claude-code / qoder，见 §18.2.1）；deepseek 已确认 `session/new` 跟随真实 profile 的 `- id: acp`，但其 provider 依赖（用户自己的模型网关）未就绪，prompt 未补跑。
- 待做：等用户自己把 DSH 的 provider 依赖准备好后补跑 deepseek；再扩到技能/记忆共享与会话可见性（mirror 模式同样要跑）。
- 待做：混合配置文件的三路合并；JSONC 注释与 YAML 的保留格式编辑（引入 `jsonc-parser` / `yaml` Document API 后开放）。
- 待做：各 Agent 并发/锁/会话库实测。

### Phase 3：体验与治理（未开始）

- 微信自然语言 `wechat_config` / `agent_config` admin MCP 工具（第一期已有确定性指令与 CLI）。
- `config promote`、冲突提示、overlay diff。
- 多账号并发测试矩阵。
- 文档、CHANGELOG、接入文档同步。

---

## 18. 测试矩阵与验收

### 18.1 单元测试

- `AgentHomeResolver`：10 个 Agent 的 real/mirror/sandbox 选择。
- `ConfigViewBuilder`：链接/生成/失败回退；`configSubdir` 的 manifest 以 view root 为基准；kiro v3 `permissions.yaml` 不穿透 junction。
- `OverlayStore`：路径 patch、删除、数组替换、未知键告警。
- `McpPolicy`：brain 空集、显式加载持久、worker 全量、wechat 排除、disable/extra。
- `WorkspaceManager`：managed/external、危险路径、缺失路径、session cwd。
- `AgentConfigWriter`：备份、mtime/size/hash 冲突拒绝、密钥字面值拒绝、原子写、含注释 JSONC 拒绝。
- `MediaStore`：`real` 模式走 `<账号>/media/inbound`，迁移与清理不越界。
- `EnvProvider`：白名单、密钥过滤、0600；快照覆盖 PATH 后能解析到任意安装方式的 Agent，未捕获变量仍继承；不依赖 fnm。
- `SessionBinder`：sessionId↔cwd、恢复不匹配、旧格式兼容。

### 18.2 每个 Agent 的 E2E

1. 终端改模型/设置 → 新微信会话使用新值。
2. 微信侧 overlay 改模型/设置 → 微信生效，真实配置不变。
3. 终端新增 skill/memory → 微信可用；微信写 memory → 终端可见。
4. yolo：常见工具无逐次询问；宿主边缘请求自动放行。
5. brain 默认无 MCP；显式加载一个 → 所有新会话都有；卸载 → 消失。
6. worker 默认全量 MCP 减 `wechat`；坏 MCP 跳过/告警。
7. 工作区切到项目根 → 新会话看到项目 `AGENTS.md`/skills；旧会话不变。
8. 微信会话在终端 Agent 会话列表中可见。
9. daemon 重启后 session resume/load，cwd 正确。
10. 两个账号不同 overlay/workspace，同时运行不串数据。
11. 终端 + 微信 + 多 worker 并发，配置/会话库不损坏（按 Agent）。
12. 真实配置包含 `wechat` 时，微信侧不加载，且不形成第二个 poller。
13. 老账号迁移、备份、回滚。
14. `real` 模式入站文件/视频落到 `<账号>/media/inbound/`，prompt 中的绝对路径可读，30 天/1GB 清理仍生效。
15. 直接编辑 overlay 与微信自然语言修改都能触发 idle reload；改真实配置也能在下一条新会话生效。
16. 对 ACP 传 MCP 的 Agent，实测“传空列表”确实不加载真实配置里的 MCP；若只是增量合并，则 brain 走视图或拒绝启动。

### 18.2.1 2026-11-12 握手矩阵（本机实测）

用 `checkAgent()`（`wemind brain check` 的同一实现）逐个启动，临时 `WEMIND_HOME`，不碰账号数据；**只证明 initialize + session/new 通**，不代替 prompt/技能/会话 E2E。

| Agent | 结果 | 耗时 | 备注 |
|---|---|---|---|
| kiro | PASS | — | 初次探测时 PATH 缺 `kiro-cli`；修复 PATH 后 prompt E2E 通过（握手随 `askBrain()` 一并验证） |
| gemini | PASS | 5.6s | |
| copilot | PASS | 11.4s | |
| opencode | PASS | 2.5s | |
| deepseek (dsh) | PASS | 16.7s | 最慢，符合其启动成本 |
| qoder | PASS | — | 初次探测时 PATH 缺 `qodercli`；修复 PATH + 完成登录后 prompt E2E 通过 |
| cline | PASS | 1.4s | |
| pi | PASS | 4.4s | |
| claude-code | PASS | 7.1s | mode=bypassPermissions |
| codex | PASS | 0.9s | mode=agent-full-access |

**结论**：10 个预设全部握手通过（kiro / qoder 在修复本机 PATH 与登录态后补跑）。下一步仍是每家的技能/记忆共享 + 会话可见性 E2E。

#### Prompt 级 E2E（同日，`homeMode=real`，真实 Agent home，临时账号目录）

每家用真实产品路径 `askBrain()` 跑两轮：第一轮要求只回 `WEMIND_E2E_OK`，第二轮追问同一个 token（验证同一会话多轮）。

| Agent | 结果 | 耗时 | 说明 |
|---|---|---|---|
| opencode | PASS | 11.7s | 两轮都对 |
| gemini | PASS | 13.8s | 两轮都对 |
| cline | PASS | 12.2s | 修复 `CLINE_*` 真实路径后通过（修复前 60s 无首帧） |
| pi | PASS | 9.9s | 两轮都对 |
| copilot | PASS | 48.1s | 最慢，但通过 |
| codex | PASS | 10.5s | 两轮都对 |
| kiro | PASS | 17.7s | PATH 修复后补跑通过 |
| claude-code | PASS（修环境后补跑） | 11.1s | 首次失败是 `~/.claude/settings.json` 的 `model` 失效；修正为 `sonnet[1m]` 后两轮都对 |
| deepseek | 待 provider | — | 已在真实 profile 补 `- id: acp`，`session/new.currentValue` 已确认生效；但该路由依赖的本机模型网关未运行，prompt 仍会连接失败——provider 与依赖由用户自己的 DSH 配置负责。见 [接入-DeepSeek §7.6](../接入方案/接入-DeepSeek.md) |
| qoder | PASS（修环境后补跑） | 10.8s | 首次失败是 `~/.qoder/.auth/user` 缺失（CLI 未登录）；登录后两轮都对 |

**本轮发现并修掉的两个真实 bug**：

1. **real 模式下无 `homeEnvVar` 的 Agent env 拼错**：`claude-code` / `cline` / `qoder` 的 `env` 模板假设 `%HOME%` 是沙箱根，real 模式 `home=realHome` 时变成 `~/.claude/claude`、`~/.cline/cline`、`~/.qoder/qoder`。新增预设 `realEnv`（值为 `%HOME%`，在 `home===realHome` 时按真实 home 展开）；修复后 cline 从「60s 无首帧」变为 12.2s 通过。守卫：`brain-agents.test.ts`。
2. **模型设置失败不应打死整轮**：`applyAcpModel` 原来把 `session/set_config_option` 的失败重新抛出，Agent 升级后旧 model id 失效会让每条消息都失败。现在只记 `WARN`（附 `wemind brain set <agent> --model` 提示），继续用 `session/new` 的默认模型。守卫：`acp-connection.test.ts`。

**结论**：9/10 在真实 real 模式下完成两轮 prompt（claude-code / qoder 修好环境后补跑通过）；只剩 deepseek 依赖用户自己的 provider 就绪。下一步是等该依赖可用后补跑 deepseek，并扩展到技能/记忆与会话可见性。

### 18.3 性能验收

- brain 默认空 MCP，启动/首帧不应比现状明显变慢。
- worker 全量 MCP 允许变慢，但必须记录 `mcpCount` / `mcpStartupMs` / `sessionNewMs` / `firstFrameMs`（已实现）；异常只警告，不自动禁用。
- 具体阈值按 Agent 实测后写入接入文档，本文不预设硬指标。

---

## 19. 风险与开放问题

| 风险 / 问题 | 处理 |
|---|---|
| 终端与微信同时写同一配置文件 | 三路合并、锁、备份、冲突文件；不支持则 mirror/sandbox |
| Agent 有全局锁/单实例限制 | 实测后标 `sharedHome: unsupported`，回退 mirror/sandbox |
| 会话库 SQLite/多进程并发 | 按 Agent 实测；必要时限制并发或隔离会话目录 |
| MCP 多导致启动/首帧变慢 | 记录指标、警告、允许 disable；不自动改变行为 |
| JSONC/YAML/TOML 格式与注释 | 第一期：JSON/无注释 JSONC 可写；含注释 JSONC 拒绝；YAML/TOML 只读。Phase 2 再接保留格式编辑器 |
| Windows 文件 symlink 权限 | 目录用 junction；文件用 hardlink/复制+watcher；必要时 mirror |
| codex 无独立配置目录、原生 MCP 与 ACP MCP 双来源 | 原生 `config.toml` 由 Codex 加载；WeMind 只读解析用于列出/指标，只管理 ACP 下发的额外项，同名原生优先。原生含 `wechat` → 拒绝启动（无法替它 unload） |
| Claude Code `settings.json` 含网关 token | 优先 ACP `mcpServers` + `set_mode`，不复制该文件；未来若必须生成视图，按 7.3 的密钥复制规则处理 |
| Copilot `--allow-all-tools` 仍可能触发路径/URL 审批 | 实测；若频繁则仅对该账号显式启用 `--allow-all`，默认不悄悄放宽网络访问 |
| DSH 坏 MCP 回滚 session | 启动前预检；跳过坏 MCP |
| 多账号共享真实配置 | 单机单人可接受；不同人用不同 OS 用户/VM |
| yolo + 真实 HOME 的提示注入风险 | 明确安全前提；建议独立 OS 用户/VM；保留出站 denylist |
| 老账号会话迁移失败 | 备份后接受丢失；不阻塞启动 |

---

## 20. 相关文档

- [AGENTS.md](../../AGENTS.md)
- [系统架构](../repowiki/02-系统架构.md)
- [ACP 大脑与沙箱](../repowiki/06-ACP-大脑与沙箱.md)
- [远程任务 Worker](../repowiki/07-远程任务-Worker.md)
- [数据存储与多账号](../repowiki/08-数据存储与多账号.md)
- [配置项与环境变量](../repowiki/09-配置项与环境变量.md)
- [接入其它 ACP Agent](../接入方案/接入其它-ACP-Agent.md)
- [速查：数据目录与环境变量](../使用指南/速查-数据目录与环境变量.md)
- [已知坑](../ai/已知坑.md)
