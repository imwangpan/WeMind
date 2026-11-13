# WeMind 接入本机 Agent：终端等效工作模式设计与实现

> **状态**：Phase 1 已实现（2026-11-13）｜**分支**：`feat/agent-parity-mode`｜**最后核对**：2026-11-13
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
4. **可观测、可恢复**：能看出当前用的是哪份配置、哪个工作区、哪些 MCP、是否已 reload；迁移保留 `.bak-*` 备份，可人工恢复，但不承诺自动回滚。
5. **不破坏既有硬约束**：同一 bot token 只能有一个收消息实例；WeMind 自己生成/下发的 MCP 集永不包含 `wechat`。Agent 真实配置里的微信 MCP 在 `direct` 下只告警，`sandbox` 复制配置时剔除，真实文件不动。

### 1.3 已确认决策（2026-11-13）

| 决策 | 取值 |
|---|---|
| 使用场景 | 单机单人；支持同机多微信账号 |
| 默认配置模式 | `direct`（终端完全等效）；`sandbox` 为显式隔离选项；接受 yolo + 真实 HOME 的完整权限代价 |
| Agent 覆盖 | 10 个内置预设全部覆盖 |
| 配置修改 | 默认改真实 Agent 配置；明确说“微信侧/仅微信”时改 overlay |
| brain MCP | `direct`：由 Agent 自己加载真实配置全量，WeMind 不维护激活集、不重发 catalog；`sandbox`：默认空，显式加载后按 agent 持久到所有由 WeMind 新建的 brain 会话，直到卸载 / 禁用 |
| worker MCP | `direct`：由 Agent 自己加载真实配置，WeMind 不额外下发；`sandbox`：真实全量减 `wechat`（WeMind 下发集） |
| 启动变慢 | 只警告，不自动禁用成功的 MCP |
| 工作区 | brain / worker 各一个默认工作区；可指定外部项目目录 |
| 环境 | 默认继承；可选非敏感快照（覆盖版本管理器/PATH/代理），API key 不落盘 |
| 会话 | `direct` 与终端共用 Agent 会话库；终端能看到微信会话 |
| 并发 | 按 Agent 支持并发设计，后续用测试矩阵验证 |
| 迁移 | 老账号只搬入站媒体并重命名旧沙箱目录为 `.bak-*`；不迁移旧会话/激活集/overlay；回滚靠人工恢复备份 |
| 安全护栏 | 危险路径确认、WeMind 下发集 `wechat` 排除、出站敏感文件 denylist 保留 |

### 1.4 非目标

- **不是多用户隔离方案**。同一 OS 用户下的多个微信账号共享真实 Agent 配置、技能与记忆；不同人使用同一台机器时，应使用不同 OS 用户或虚拟机。
- **不是安全沙箱**。`direct` + yolo 下，微信侧 Agent 拥有当前 OS 用户的完整权限。
- **不追求微信会话与终端当前会话是同一条 session**。默认共享 Agent 会话库、但微信使用独立 session ID；终端能看到微信会话，不会把两边正在进行的上下文混在一起。
- **不保证所有 Agent 的“终端等效”完全一致**。各 Agent 的 ACP 能力、配置布局、MCP 传输方式不同；差异会在能力矩阵中明确标注。

### 1.5 安全前提

本设计默认接受以下代价：

- 微信侧 Agent 可以读写当前用户能访问的任何文件。
- 提示注入可能诱导 Agent 修改真实配置、项目文件、凭据或执行命令。
- yolo 意味着大多数工具调用不会逐次询问。

因此，`direct` + yolo 只适合可信的单机单人环境。需要更强隔离时，使用 `sandbox` 模式、独立 OS 用户或虚拟机；不能把本设计的“工作区”或“overlay”当成安全边界。

---

## 2. 术语与模式

| 术语 | 含义 |
|---|---|
| **Agent 真实配置目录** | 本机 Agent 在终端使用的真实配置目录，如 `~/.kiro`、`~/.claude`、`~/.pi/agent`；对应预设字段 `realHome` |
| **effective config** | `真实配置 → 微信 overlay（仅 sandbox / ACP 下发）→ 角色策略` 合并后的最终配置 |
| **overlay** | 微信独享覆盖，存放在账号目录，永不自动写回真实配置 |
| **workspace** | Agent 的 `cwd`，影响项目级规则、技能发现、相对路径与 git 上下文 |
| **homeMode** | `direct` / `sandbox` 两种配置来源模式 |
| **direct** | Agent 直接使用完整真实配置；daemon 启动/运行期不自动写 Agent 文件、不注入 `homeEnvVar` / 预设 `env`（用户显式执行 `wemind config agent ...` 时才会写并备份） |
| **sandbox** | WeMind 在账号目录复制配置、继承技能/记忆并生成 MCP 集；真实配置不被写入 |

### 2.1 两种 homeMode

| 模式 | 行为 | 适用场景 |
|---|---|---|
| `direct` | 启动路径不生成副本、不注入 `homeEnvVar` / 预设 `env`；Agent 直接读取完整真实配置。WeMind 只保留 `envDefaults`（yolo 默认值）与只读凭据桥接。只有用户显式执行 `wemind config agent ...` 才写真实配置；微信侧 overlay 只由显式 `wemind config wechat ...` 写入，且文件式 Agent 不消费 | **默认**；单机单人；要求“终端怎么配，微信就怎么跑” |
| `sandbox` | 完整复制到账号目录，Agent 与真实配置隔离；技能/记忆按 `inheritDirs` / `inheritFiles` 选择性继承 | 多账号不同人、不可信任务、Agent 不支持共享 home、需要回滚 |

**默认：`direct`。** 现有账号迁移后也进入 `direct`；`sandbox` 保留为显式选项。历史遗留的其他 `homeMode` 值读取时一律按 `direct` 处理，新写入只写 `direct / sandbox`。

### 2.2 沙箱隔离的取舍

旧实现把 brain / worker 放进 `brain-home` / `worker-home`，本质是「用隔离换可控」。这个取舍需要明确记录，避免后续又把两种目标混在一起。

| 维度 | `sandbox` | `direct`（默认） |
|---|---|---|
| 配置一致性 | 启动时复制，长跑期间真实配置变化不生效 | 完全由 Agent 自己加载，天然与终端一致 |
| 技能 / 记忆 | 只继承预设列出的目录，容易漏 | 直接使用真实目录，天然双向 |
| 会话可见性 | 会话在沙箱，终端看不到 | 共享 Agent 会话库，终端可见 |
| 微信独享 | 整份配置天然独享，但会逐渐漂移 | 仅 `agent-overrides` 的 `mcp.disable` / `mcp.extra`，且只对 ACP 下发或 sandbox 生效 |
| MCP 控制 | 由 WeMind 生成完整 MCP 集 | 完全由 Agent 真实配置决定；`加载/卸载` 原样转给 Agent 处理 |
| 安全性 | 能限制写入范围，降低提示注入影响面 | 微信侧拥有当前 OS 用户完整权限 |
| 可回滚 | 删沙箱即可 | 不写入，无需回滚 |
| 适用场景 | 多账号不同人、不可信任务、Agent 不支持共享 home | 单机单人、可信环境、追求「终端什么效果，微信就什么效果」 |

结论：默认 `direct` 不是否定沙箱，而是把沙箱降级为**显式隔离选项**。`direct` 完全交给 Agent，WeMind 运行期不托管 MCP/settings；但用户显式配置的 `overlay.mcp.extra` 仍会补进 ACP 会话。安全边界仍然只能靠独立 OS 用户、容器或虚拟机，不能靠工作区或 overlay。

---

## 3. 现状与差距

### 3.1 现状摘要

Phase 1 已落地（本分支）：

- 账号默认 `homeMode = direct`（`agents/config/home-mode.ts`），读取 `<账号>/runtime.json`；缺失/损坏/历史遗留值一律回落 `direct`，`WEMIND_HOME_MODE` 只做一次性覆盖。
- `agentRuntime("brain"|"worker", ag)` 在 `direct` 下直接返回 Agent 的真实配置目录，`configDir === home`；WeMind 不生成任何配置副本、不注入 `homeEnvVar`、不写 settings / MCP / 权限文件。`sandbox` 才使用 `brain-home` / `worker-home`，由 adapter 生成副本并按 `inheritDirs` / `inheritFiles` 继承。
- brain 与 worker 的启动/会话 `cwd` 改为账号级默认工作区（`<账号>/workspace/brain`、`<账号>/workspace/worker`，`agents/config/workspace.ts`）；`session-cwd.json` 记录 `<agent>:<sessionId> → cwd`，恢复旧会话时优先使用它。`WEMIND_WORKER_CWD` 与 `task --cwd` 仍是一次性覆盖。
- `direct` 的 MCP 完全由 Agent 真实配置决定：文件式 Agent 自己读配置，DSH 读 profile YAML 的 `dsh-mcp-client` 条目，Claude Code / Copilot / Codex 读各自的 `.claude.json` / `mcp-config.json` / `config.toml`。WeMind **不重发 catalog**；只有用户显式配置的微信独享 `overlay.mcp.extra` 会通过 ACP 补进会话（仅 `acpMcpServers` 的 Agent）。`加载/卸载 MCP` 在 direct 下原样转给 Agent（由它自己改配置）。`sandbox` 才是 brain 默认空（激活集按 agent 分键持久化在 `<账号>/brain-mcps.json`，`version: 2`）、worker 真实全量减 `wechat`；`mcpDelivery: "acp"` 的 Agent 由 WeMind 经 ACP 投递，文件式 Agent 写沙箱配置。
- MCP/首帧指标已落到日志：`session/new|load|resume ok … mcpCount= nativeMcpCount= sessionNewMs= mcpStartupMs=`、`prompt ok … firstFrameMs=`（`agents/config/mcp-perf.ts`）；`scripts/doctor.ps1` 汇总 `mcpCount/sessionNewMs/firstFrameMs`，数量/耗时超阈值只提示，**不自动禁用**；`nativeMcpCount/mcpStartupMs` 也在日志里，但当前 doctor 不单独汇总。Agent 自己配置文件里的 MCP 单独记 `nativeMcpCount`：Codex 的 `config.toml`、DSH 的 `cordis.patch.yml`、Claude Code 的 `.claude.json`、Copilot 的 `mcp-config.json` 都算。
- Codex 的 `~/.codex/config.toml` 与 DSH 的 profile YAML 都做**只读**解析（`agents/sandbox/toml-mcp.ts` / `dsh-mcp.ts`）：名字/`command`/`args`/`env`/`url` 会进 `列出` 与指标；WeMind 不写回、也无法替 Agent unload 原生项。原生配置里若有 `wechat`（或任何会跑 `wemind-mcp` 的定义），brain/worker **只告警、不阻止启动**（`warnForbiddenNativeMcp`），由用户自行删除。
- 微信 overlay 位于 `<账号>/agent-overrides/<agent>.json`；CLI 为 `wemind config wechat show|edit <agent>`，微信侧为只读的 `微信配置 查看 <agent>`。
- 真实配置写入走 `agents/config/agent-config-writer.ts`：备份、mtime + size + sha256 并发校验、同目录原子写；含注释 JSONC、YAML/TOML 第一期拒绝写入。
- 入站媒体在 `direct` 下写到 `<账号>/media/inbound`；`sandbox` 仍是 `<sandbox>/media/inbound`。
- 配置变化通过 `configFingerprint()` 在每轮开始前检测并重启进程（只哈希显式配置文件与 overlay；无 `homeEnvVar` 的 Agent 返回空，改完重启 daemon）；`wemind config reload` 经控制桥让 brain 重建进程，有回合在跑时排到回合结束。worker 在每次 `acquire` 时按该任务 agent 重新解析。
- 技能/记忆在 `direct` 下由 Agent 自己读真实目录，天然双向；`sandbox` 才由 WeMind 的 `sandbox-inherit.ts` 按 `inheritDirs` / `inheritFiles` 链接/复制。
- 会话指针仍在 `brain-sessions.json` / `worker-sessions.json`；Agent 的真实会话库由各 Agent 自己管理，`direct` 下与终端共用同一个库。

旧的“沙箱优先”行为仅在显式 `sandbox` 模式保留，用于回滚、不可信任务或 Agent 不支持共享 home 的场景；`direct` 在 daemon 启动/运行期不自动写任何 Agent 配置（只有用户显式执行 `wemind config agent ...` 时写并备份），适合“完全交给 Agent”的用户。

### 3.2 与目标的差距

| 维度 | 现状 | 目标差距 |
|---|---|---|
| 配置 | 默认 `direct`，完全使用真实配置；daemon 启动/运行期不自动写 Agent 文件（显式 `config agent` 例外） | 仍需各 Agent 实测“哪些设置无需新会话”，Phase 2 补矩阵 |
| 配置回写 | 默认改真实配置；overlay 只写微信侧 | 已实现；JSONC 注释/YAML/TOML 的保留格式编辑留到 Phase 2 |
| 技能/记忆 | `direct` 共享真实目录；`sandbox` 复制回退不保证双向 | 需要在无 symlink 权限的平台记录“副本漂移”告警 |
| MCP | `direct` 下 brain/worker 都由 Agent 自己加载真实配置、WeMind 不额外下发；`sandbox` 才 brain 默认空 / worker 全量减 `wechat`；日志有 `mcpCount/nativeMcpCount/sessionNewMs/mcpStartupMs/firstFrameMs`，`scripts/doctor.ps1` 超阈值只警告；Codex 原生 TOML 只读可见、含 `wechat` 只告警 | 主体已实现；MCP 预检/跳过坏条目留 Phase 2；各 Agent 的耗时基线数值仍要在真机上收集后写进接入文档 |
| cwd | brain/worker 各有账号级默认工作区；旧会话按 `session-cwd.json` 恢复 | 已实现；各 Agent 对“恢复时改 cwd”的接受度待逐家实测 |
| 环境 | 默认继承 daemon；可选非敏感快照 | 已实现；不绑定 fnm/nvm/Volta/asdf/mise |
| 权限 | 预设 yolo + 宿主默认放行（`WEMIND_ACP_AUTO_ALLOW=0` 可恢复拒绝） | 已保留；真正隔离仍需独立 OS 用户/VM |
| 会话 | `direct` 共享 Agent 会话库，终端能看到微信会话 | 各 Agent 的会话列表呈现/并发写锁待逐家验收 |
| 多账号 | WeMind 数据隔离；Agent 配置共享；overlay/workspace 按账号 | 已实现；不同人共用一台机器仍需不同 OS 用户 |

---

## 4. 设计原则

1. **单一真实来源**：非微信独享的配置、技能、记忆、会话以本机 Agent 的真实配置目录为准。
2. **薄隔离**：只隔离必须由 WeMind 控制的部分：账号级 overlay、会话指针、任务/控制桥、workspace 默认值；`sandbox` 才复制配置。
3. **显式覆盖**：微信独享配置只写入 overlay（`mcp.disable` / `mcp.extra`）；默认不复制整份配置。
4. **回环防护**：WeMind 自己生成的 MCP 集永久排除 `wechat`（按名字和定义双重判断）；Agent 真实配置里的微信 MCP 只告警，由用户自行删除。
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
AgentHomeResolver ──► Agent 进程
   │
   ├── direct：Agent 真实配置目录（配置/技能/记忆/会话）
   └── sandbox：账号副本 + 继承 + 生成的 MCP 文件
   │
   ├── McpPolicy（direct brain/worker 均不额外下发 / sandbox brain 默认空 / sandbox worker 全量）
   ├── WorkspaceManager（brain / worker 默认工作区）
   ├── EnvProvider（继承或非敏感快照）
   ├── SessionBinder（sessionId ↔ cwd）
   └── ReloadCoordinator（空闲 reload / 新会话生效）
```

### 5.1 核心组件

| 组件 | 职责 |
|---|---|
| `AgentHomeResolver`（`agents/config/runtime.ts`） | 根据 Agent 预设、账号配置与角色（brain/worker）决定 `homeMode`、真实配置目录 / 沙箱根、`cwd`、媒体目录 |
| `OverlayStore`（`agents/config/overlay.ts`） | 读写 `<账号>/agent-overrides/<agent>.json` 的 `mcp.disable` / `mcp.extra` |
| `McpAdapter`（`agents/sandbox/mcp-adapters.ts`） | 每种 MCP **文件格式**的路径/读写/剥离/ACP 转换/原生只读/设置继承；Agent 只是选择其中一种，新增格式才加 adapter |
| `McpPolicy`（`agents/sandbox/mcp-sandbox.ts`、`worker-sandbox.ts`） | `direct` 下 brain/worker 都由 Agent 自己加载真实配置、WeMind 不额外下发；`sandbox` 算激活集/全量集；处理 disable/extra 与 `wechat` 排除 |
| `WorkspaceManager`（`agents/config/workspace.ts`） | 校验、创建、读取 brain/worker 默认工作区；区分 managed/external |
| `EnvProvider`（`agents/config/env-snapshot.ts` + `brain-agents.ts`） | 继承 daemon 环境，或加载非敏感快照（PATH/代理/locale）；解析顺序不绑定某个版本管理器 |
| `SessionBinder`（`agents/config/session-cwd.ts`） | 保存 `<agent>:<sessionId> → cwd`；恢复时使用并校验 cwd |
| `ReloadCoordinator`（`config-fingerprint.ts` + `config.reload` 控制桥） | 检测真实配置变化；手动 reload 让 brain 重建进程，重启在回合结束后执行 |
| `AgentCapabilityMatrix`（`brain-presets.ts`） | 每个 Agent 的 homeMode、MCP 传输、会话布局、yolo 方式、并发注意事项 |

### 5.2 brain 与 worker 的差异

| 维度 | brain | worker |
|---|---|---|
| 配置来源 | `direct`（默认，真实配置）/ `sandbox`（账号副本） | 同左 |
| 默认工作区 | `<账号>/workspace/brain` | `<账号>/workspace/worker` |
| MCP 默认 | `direct`：由 Agent 自己加载真实配置（WeMind 不额外下发）；`sandbox`：**空**，显式加载后持久到所有新会话 | `direct`：由 Agent 自己加载真实配置，WeMind 不额外下发；`sandbox`：真实全量减 `wechat` |
| 会话 | 每个用户一条当前 session | 每个任务一条 session |
| 进程 | 1 个常驻 ACP 进程 | N 个进程池 |
| 重载 | 空闲时 reload / 新会话 | 每次 `acquire` 重新解析配置；任务中不热切换 |

---

## 6. Agent 能力矩阵

> 表中 `~` 表示当前 OS 用户的主目录；Windows 的 `%USERPROFILE%`、macOS/Linux 的 `$HOME` 都等价。路径分隔符、权限位与链接能力按平台处理，不把某一种平台的文件布局当成通用事实。`homeMode` 为建议默认，最终以实测为准。

| Agent | 配置入口 | Agent 真实配置目录 | 配置目录 | MCP 传输 | 会话库 | yolo 方式 | homeMode | 主要风险 |
|---|---|---|---|---|---|---|---|---|
| `kiro` | `KIRO_HOME` | `~/.kiro` | 根 | `settings/mcp.json` | `sessions/` | v2 `--trust-all-tools`；v3 `settings/permissions.yaml` | `direct`；`sandbox` 可选 | v3 的免审批写文件只在 sandbox 生成 |
| `gemini` | `GEMINI_CLI_HOME` | `~`（它是“家目录”根，配置在其下的 `.gemini`） | `~/.gemini` | `.gemini/settings.json` | `.gemini/` | `--approval-mode yolo --skip-trust` | `direct`；`sandbox` 可选 | `direct` 用真实 `settings.json`；sandbox 才剥离/重建 |
| `copilot` | `COPILOT_HOME` | `~/.copilot` | 根 | ACP `mcpServers` | COPILOT_HOME 内 | `--allow-all-tools` | `direct`；`sandbox` 可选 | 不启用 `--allow-all` 的路径/URL 放宽；图片能力待实测 |
| `opencode` | `XDG_CONFIG_HOME` | `~/.config/opencode` | `opencode/` | `opencode.json` 的 `mcp.servers` | 真实 `~/.local/share/opencode` | `opencode.json` 的 `permission: "allow"` | `direct`；`sandbox` 可选 | 数据目录在 direct 下与终端共享是预期行为 |
| `deepseek` / DSH | `DSH_HOME` | `~/.dsh` | 根 | ACP `mcpServers` | 真实 `~/.dsh`（direct） | `DSH_PERMISSION_MODE=danger-full-access` | `direct`；`sandbox` 可选 | 坏 MCP 可能导致 `session/new` 回滚；`isolateSessions` 只在 `sandbox` 启用 |
| `qoder` | `QODER_CONFIG_DIR` | `~/.qoder` | `qoder/` | `settings.json` 的 `mcpServers` | `qoder/` | `--yolo` | `direct`；`sandbox` 可选 | 没有 `homeEnvVar`：direct 直接用真实 `~/.qoder`；沙箱靠预设 env 指到副本 |
| `cline` | `CLINE_DIR` / `CLINE_DATA_DIR` / `CLINE_MCP_SETTINGS_PATH` | `~/.cline` | `cline/` | `mcp.json`（`CLINE_MCP_SETTINGS_PATH`） | `cline/data/`（SQLite，假设/待实测） | `--auto-approve true` | `direct`；`sandbox` 可选 | 没有 `homeEnvVar`：direct 直接用真实配置；sandbox 靠预设 env 指到副本 |
| `pi` | `PI_CODING_AGENT_DIR` | `~/.pi/agent` | 根 | `mcp.json` | `sessions/` | 无（默认不逐次审批） | `direct`；`sandbox` 可选 | sandbox 下 `pi-acp` 仍读真实 `~/.pi/pi-acp/session-map.json`、`~/.agents/skills` |
| `claude-code` | `CLAUDE_CONFIG_DIR` | `~/.claude` | `claude/` | ACP `mcpServers` | `claude/` | `session/set_mode bypassPermissions` | `direct`；`sandbox` 可选 | 预设未声明 `homeEnvVar`，direct 直接用真实配置；`~/.claude.json` 混状态 |
| `codex` | 无 home env | `~/.codex` | 真实 `~/.codex` | **stdio MCP 支持**（2026-11-12 复测；`mcpCapabilities.acp=false` 只指 MCP-over-ACP） | `~/.codex` | `INITIAL_AGENT_MODE=agent-full-access` + `set_mode` | `direct`（没有 `homeEnvVar`，`sandbox` 也无法真正隔离 `~/.codex`） | 无独立配置目录；原生 `config.toml` 由 Codex 自己加载 |

**结论（2026-11-13 按实现修正）**：默认 `direct`，10 个预设都直接使用真实配置。WeMind 在 daemon 启动/运行期**不自动写 Agent 文件**（只有显式 `wemind config agent ...` 会写并备份），也**不重发 Agent 已原生加载的 MCP catalog**；`sandbox` 才复制配置并生成 MCP/settings/权限副本。`acpMcpServers` 只描述能力，`mcpDelivery: "acp"` 只在 sandbox 托管 MCP 时使用（DSH / Claude Code / Copilot / Codex）；`direct` 下只有用户显式配置的 `overlay.mcp.extra` 会通过 ACP 补进会话。

> **`direct` 的明确语义**：真实配置里有什么 MCP，Agent 就加载什么；WeMind 不保证 brain 默认空 MCP。这是用户显式选择“完全交给 Agent”的代价，不是缺陷。

---

## 7. 配置同源设计

### 7.1 effective config 的构建顺序

```text
1. Agent 真实配置基底（模型/供应商/技能/记忆/设置）
2. overlay            微信独享的 mcp.disable / mcp.extra（只对 brain 的 ACP 下发或 sandbox 生效）
3. MCP policy         direct brain/worker 均不额外下发；sandbox 才 brain 默认空 / worker 全量减 wechat
4. role policy        yolo envDefaults、路径、会话目录
5. validation         解析、必填项、wechat 告警、危险路径
6. materialize        direct 不生成；sandbox 完整复制
```

任何一步失败都要记录原因；不能让 Agent 带着半份配置启动。

### 7.2 direct 模式（默认）

`direct` 是“WeMind 不介入 Agent 启动配置”的模式，用于希望微信侧与终端**完全一致**、且接受自己维护配置的用户：

- 启动路径不生成任何配置副本，不写 MCP / settings / 权限文件，不注入 `homeEnvVar`、预设 `env`；仍保留 `envDefaults`（yolo 等免审批默认值，父进程显式设置优先）与只读凭据桥接。
- 文件式 Agent（kiro / opencode / qoder / cline / gemini / pi）完全由 Agent 自己读真实配置；WeMind 不写、不删。
- DSH 读 profile YAML 的 `dsh-mcp-client` 条目；Claude Code 读 `~/.claude.json`；Copilot 读 `~/.copilot/mcp-config.json`；Codex 读 `~/.codex/config.toml`。**WeMind 不把真实 catalog 再经 ACP 重发**，只在用户显式配置 `overlay.mcp.extra` 时补这一小集合（仅 `acpMcpServers` 的 Agent）。
- Worker 在 `direct` 下同样不额外下发 catalog，由 Agent 自己加载真实配置；这消除了“Worker 与终端读到不同 MCP”的 parity 缺口。
- 真实配置里存在 `wechat` MCP（或会跑 `wemind-mcp` 的定义）时**只告警、不阻止启动**；用户需要自己从 Agent 配置里移除，否则可能出现第二个 poller / 回环。
- 微信里的 `加载 / 卸载 MCP` 不拦截，原样作为消息交给 Agent；它能不能改、怎么改由 Agent 自己的能力决定。
- 不改写任何真实配置；`wemind config agent set` 这类写入口在此模式下仍会写真实文件（用户显式操作），但启动路径不做任何生成/同步。
- 不注入 `homeEnvVar` 意味着 Agent 使用自己的默认配置目录；若用户通过系统环境变量把配置指到别处，由用户自己负责。
- 配置指纹仍会盯真实配置文件与 overlay；有 `homeEnvVar` 的 Agent 在下一轮前发现变化会重启进程，没有 `homeEnvVar` 的 Agent 返回空指纹（改完重启 daemon）。

### 7.3 sandbox 模式

使用 `<账号>/brain-home` / `<账号>/worker-home`，WeMind 生成副本；实际 Agent 配置目录还要叠加预设的 `configSubdir`（例如 Gemini 是 `<沙箱>/.gemini`、OpenCode 是 `<沙箱>/opencode`）。只有 `sandbox` 会复制配置、同步凭据、按 `inheritDirs` / `inheritFiles` 继承技能/记忆、并按角色生成 MCP/settings/权限文件；`direct` 不进入这条路径。适用场景：

- 多账号由不同人使用；
- 不可信任务；
- Agent 有全局锁/不支持共享 home；
- 用户显式选择隔离。

### 7.4 overlay 格式

位置：`<账号>/agent-overrides/<agent>.json`

```json
{
  "version": 1,
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

- 只支持 `mcp.disable`（从有效集移除）与 `mcp.extra`（增加真实配置没有的 MCP）。其它键（如 `config`、`replyStyle`）会被忽略并告警；Agent 的模型/权限/settings 修改请直接改真实配置，不走 overlay。
- `mcp.extra` 使用中性描述（`type: stdio|http` + `command/args/env` 或 `url/headers`），由各 Agent 适配器转成原生格式；不支持的类型明确拒绝，不猜测。
- 生效范围：`sandbox` 的 brain 与 worker 都生效；`direct` 只对 `acpMcpServers` 的 Agent（brain 与 worker）经 ACP 补进会话（DSH / Claude Code / Copilot / Codex）。`direct` 的文件式 Agent 由 Agent 自己读配置，overlay 不参与，WeMind 会提示“改 Agent 配置”。
- overlay **不保存密钥**：`mcp.extra` 的认证信息通过环境变量/密钥链注入；发现 `*_KEY`、`*_TOKEN`、`*_SECRET`、`*_PASSWORD`、`*_CREDENTIAL*` 字面值要告警并拒绝写入。
- `sandbox` 的 brain 是否自动加载 `extra` 仍由激活集决定；worker 的 `extra` 默认生效。`mcp.disable` 永远最后生效。
- **工作区不放进 agent overlay**：它是“账号 + 角色（brain/worker）”级配置，放在 `<账号>/workspace.json`（见第 9 章）。把工作区塞进 per-agent overlay 会导致切换 Agent 时工作区跟着变，不符合“brain / worker 各一个默认工作区”的目标。
- overlay 只影响微信侧，**永不自动写回真实配置**。
- 未知键、解析失败要告警/拒绝，不能静默忽略。

### 7.5 账号级微信设置（预留）

`agent-overrides/<agent>.json` 只放**与某个 Agent 配置相关**的覆盖。工作区放在 `workspace.json`；回复风格、进度提示、默认语气这类 WeMind 自身行为也不属于 Agent 配置，不应塞进 agent overlay。预留 `<账号>/wechat-settings.json`：

```json
{
  "version": 1,
  "replyStyle": null,
  "progress": null
}
```

第一期只创建空文件，当前不读取其中字段，也不定义具体语义；等真正需要时再补。这样既不会把“微信独享配置”做成一个大杂烩，也不会限制未来扩展。

### 7.6 修改入口

| 入口 | 行为 |
|---|---|
| 直接编辑 overlay 文件 | 支持。可直接编辑 `<账号>/agent-overrides/<agent>.json`，也可用 `wemind config wechat edit <agent>` 打开编辑器。保存后由 daemon 读取时校验：坏 JSON、疑似密钥或微信 MCP 会被报告并忽略，不阻止启动 |
| CLI | `wemind config wechat show|edit <agent>`；只管理 `mcp.disable` / `mcp.extra` |
| 微信自然语言（第一期） | 只有只读指令 `微信配置 查看 <agent>`；要修改请用 `wemind config wechat edit <agent>` 或直接编辑文件。模型不参与路径与 JSON 的拼装 |
| 微信自然语言（第三期，预留） | 由 WeMind 自带 admin MCP 暴露 `wechat_config` / `agent_config` 工具；工具调用 daemon 的内部配置服务，做校验、备份、原子写与 idle reload。ACP 没有“宿主注册工具”的标准方法，因此不能把这一步写成现成能力 |
| 默认配置修改 | 用户没有说“微信侧”时，Agent 直接改真实配置；这是默认语义。CLI 提供 `wemind config agent show|get|set|unset|edit`；微信侧的 Agent 可在 YOLO 下直接调用这组 CLI，写入层做备份、并发校验与原子写 |

因此“能不能直接跟大模型说‘把模型改成 X’”——可以，且默认就是改真实配置。只有用户明确说“微信侧 / 仅微信 / 这边”时，才写 overlay；而 overlay 只接受 MCP 增删，不接模型/权限/settings。自然语言修改走受控入口，不让模型猜路径：第一期由 Agent 调用 `wemind config` CLI（聊天侧只有只读查看）；第三期才评估 admin MCP 工具。无论哪一期，写入层都负责校验、备份、原子写、触发 idle reload，并回复“下一次新会话生效”。

### 7.6.1 `wechat_config` / `agent_config` 的实现链（第三期预留）

> 这一节回答“Agent 调用 `wechat_config` 到底是怎么发生的”。结论先说：**它不是 ACP 宿主直接注册给模型的工具，而是一个本地 MCP server**。当前代码尚未实现；第一期只有 `wemind config` CLI 写入口与微信只读查看。

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
| Overlay | `scope=agent` 改真实配置；`scope=wechat` 只改 `<账号>/agent-overrides/<agent>.json` 的 `mcp.disable` / `mcp.extra`，不碰真实文件 |
| Control bridge | Admin MCP 写完配置后投递 `config.reload`；daemon 让 brain 重建进程，重启排到回合结束 |

#### 怎么注入

- **支持 ACP MCP 的 agent**（`acpMcpServers`，如 DSH / Claude Code / Copilot / Codex）：在 `session/new`、`session/load`、`session/resume` 的 `mcpServers` 数组里追加一个 `wemind_admin` 条目。例如 stdio：

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

- **只从配置文件读 MCP 的 agent**：`direct` 下 WeMind 不自动写 Agent 文件，无法自动注入 `wemind_admin`；只有显式 `sandbox` 才能把它写进沙箱副本。终端自己开的会话看不到这个工具，只有微信侧沙箱能看到。
- **不注入 Admin MCP 的 agent**（文件式 direct、Codex 原生 `config.toml`）：退回“模型通过 shell 调 `wemind config ...`”的 CLI 路径。Codex 的客户端 stdio MCP 自 2026-11-12 复测可用，但 `direct` 下 WeMind 不重发 MCP catalog，也不额外写 `config.toml`。

#### 一次调用的完整链路

1. 微信用户说“把模型换成 X”或“微信侧回复简短一点”。
2. daemon 把消息作为 `session/prompt` 发给 brain。
3. 模型根据工具描述选择 `agent_config`（默认，真实配置）或 `wechat_config`（仅微信侧）。它发出的是 MCP `tools/call`，不是 shell 命令。
4. agent 内置的 MCP client 把 JSON-RPC 请求发给 `wemind_admin`（stdio 或 loopback HTTP）。
5. Admin MCP 校验 `WEMIND_ADMIN_TOKEN`，并核对 token 绑定的账号 / agent / 角色与当前进程一致；不匹配直接拒绝。
6. ConfigService 解析目标文件：
   - `scope=agent`：按 agent preset 解析真实配置路径（只允许该 agent 的已知配置根内）；
   - `scope=wechat`：`<账号>/agent-overrides/<agent>.json`，只允许 `mcp.disable` / `mcp.extra`（不写入 Agent 真实配置）。
7. 读取当前文件，比对调用方带来的 `expectedRevision`（或服务端刚生成的 mtime/size/hash）；发现终端侧刚改过就返回冲突，不覆盖。
8. 应用修改：`scope=agent` 接受路径 `set` / `unset`；`scope=wechat` 只接受 `mcp.enable` / `mcp.disable` / `mcp.add` / `mcp.remove`。拒绝疑似密钥键、`..` 越界、指向真实配置之外的路径。
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

11. Admin MCP 向控制桥投递 `config.reload`。daemon 若正在跑回合，就把 reload 排到空闲；否则重启 brain/worker 进程，让下一次 spawn 重新读取配置。
12. 模型看到工具结果，用自然语言回复“已改真实配置，新会话生效”；daemon 把回复发回微信。

#### 工具契约

建议暴露两个工具，而不是一个含糊的 `wechat_config`：

| 工具 | 作用域 | 使用条件 |
|---|---|---|
| `agent_config` | 真实配置（默认） | 用户没有明确说“微信侧/仅微信/这边”时使用 |
| `wechat_config` | 微信侧 overlay（仅 MCP 增删） | 只有用户明确要求微信独享配置时使用；模型/权限/settings 不在 overlay |

两者共用参数结构：`action`（`get` / `set` / `unset` / `list` / `mcp_enable` / `mcp_disable` / `mcp_add` / `mcp_remove` / `reload`）、`agent`、`path`、`value`、`role`（`brain` / `worker`）、`expectedRevision`、`dryRun`。工具描述必须写清“默认改真实配置；只有用户明确说微信侧才用 `wechat_config`；不要写密钥”。这样作用域由工具名 + 描述双重约束，审计日志也能直接看出模型选的是哪一侧。

#### 安全边界

- **yolo 不等于无校验**：yolo 只关掉 OS 权限询问；MCP 工具仍然做 token、账号、路径、密钥、并发和备份校验。
- **token 绑定**：每次会话生成随机 token，绑定账号 + agent + 角色；Admin MCP 不接受跨账号调用。HTTP 模式只监听 loopback，并要求 `Authorization`。
- **不是 shell**：工具只接受结构化 JSON，不接受任意命令/路径；不会把“写配置”变成“执行任意程序”。
- **审计与回滚**：每次写入都有备份和审计；冲突时拒绝覆盖，不静默赢。
- **硬边界仍是 `wechat` 排除**：任何 scope 都不允许把 `wechat` MCP 加进 WeMind 生成的有效集；按名字和定义双重判断。Agent 真实配置里的微信 MCP 只告警。
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

| 角色 | `direct`（默认） | `sandbox` |
|---|---|---|
| brain | Agent 真实配置全量，由 Agent 自己读；WeMind 只补 `overlay.mcp.extra`（仅 `acpMcpServers` 的 Agent） | **空**；用户显式 `加载` 后持久到 `<账号>/brain-mcps.json`（按 agent 分键），`卸载` 后移除 |
| worker | 由 Agent 自己加载真实配置，WeMind 只补 `overlay.mcp.extra`（仅 `acpMcpServers` 的 Agent） | （真实配置中的全部 MCP ∪ `extra`）− `wechat` − `disable` |

`sandbox` 的 brain 默认空是为了保证最佳首帧/启动速度；这不是“真实配置里没有”，而是“微信侧不自动加载”。用户显式加载后，激活集持久化到磁盘，跨会话、跨 daemon 重启保留（按 agent 命名空间隔离）。这里的“所有会话”指 WeMind 新建的 brain 会话；终端自己开的会话不受 WeMind 的激活集影响。

“显式加载”与“显式禁用”的优先级（仅 `sandbox`）：`brain-mcps.json` 记录用户主动加载的集合；overlay 的 `mcp.disable` 永远最后生效。即使某个 MCP 曾经被加载过，只要用户明确 disable，它就不会再出现在 brain 的有效集里；重新 `加载` 会把它从 disable 中移除并写回激活集。

**`direct` 的语义**：Agent 真实配置里有什么 MCP 就加载什么，WeMind 不维护激活集、也不重发 catalog；微信里的 `加载 / 卸载 MCP` 原样转给 Agent 处理。只有 `overlay.mcp.extra` 这一小集合会通过 ACP 补进会话（仅 `acpMcpServers` 的 Agent）。真实配置里若有 `wechat`，只告警不阻止启动，用户需自行移除。

### 8.1.1 切换 brain 时的激活集（`sandbox`）

激活集按 **agent 名称** 分键，不是“当前 brain 进程”的一份全局状态：

| 场景 | 激活集行为 |
|---|---|
| 同一个 agent 新建会话 / daemon 重启 | 保留之前显式加载的集合 |
| 切到另一个 agent | 使用那个 agent 自己的集合；从未加载过就是**空** |
| 切回原 agent | 恢复原 agent 的集合 |
| 当前正在进行的会话 | 不热改；`sandbox` 下加载/卸载只影响之后新建的会话 |
| worker | 不受 brain 激活集影响；`sandbox` 下是真实全量减 `wechat` |

这样设计的原因是各 agent 的 MCP catalog 不同：A 里有的名字 B 未必有，盲目继承会让 B 启动时挂载失败（DSH 这类 Agent 甚至会回滚整个 `session/new`）。已实现的 `brain-mcps.json` 是 `{ "version": 2, "active": { "<agent>": [...] } }`；读取到旧版 `{ "active": [...] }` 时，会把旧全局列表归到首次读取时的当前 agent，其他 agent 初始为空。

### 8.2 有效集计算

```text
direct brain:
  Agent 自己加载真实配置；WeMind 只额外补
  overlay.mcp.extra（仅 acpMcpServers 的 Agent）

direct worker:
  Agent 自己加载真实配置；WeMind 不额外下发

sandbox brain:
  catalog = Agent 真实配置已启用 MCP ∪ overlay.mcp.extra
  (brain-mcps.json[agent] ∩ catalog)
  − wechat
  − overlay.mcp.disable

sandbox worker:
  (Agent 真实配置已启用 MCP ∪ overlay.mcp.extra)
  − wechat
  − overlay.mcp.disable
```

`sandbox` 的 brain 不会因为 `mcp.extra` 里“存在”某个 MCP 就自动加载；它只有在用户显式 `加载` 后才进入激活集。`sandbox` 的 worker 则按“无人值守任务需要开箱即用”的语义，直接使用真实全量加 extra。`direct` 完全由 Agent 真实配置决定；overlay 只对 `acpMcpServers` 的 Agent（brain 与 worker）经 ACP 补进会话，不重发 catalog。

如果 `brain-mcps.json` 里的某个名字在 catalog 中已经不存在（真实配置删了、extra 也删了），不要静默丢弃：保留记录、在 `wemind mcp list` / `doctor` 里标记 `missing`，等用户确认后再清理。

`wechat` 排除按名字和定义双重判断：

- 名字为 `wechat`；
- command/args/url 里跑 `wemind-mcp` 或 `@wemind/wechat-mcp`；
- `sandbox` 副本里的微信 MCP 会被剔除（`stripWechatFromConfigCopy`）；`mcpDelivery: "acp"` 的 Agent 在复制阶段就剥离全部 MCP 条目，真实文件不动；`direct` 下 Agent 真实配置里的微信 MCP 只告警，由用户自行删除。

### 8.3 传输方式

下表是 **`sandbox` 的写入位置**。`direct` 下 WeMind 启动/运行期不自动写 Agent 配置文件：文件式 Agent 自己读真实配置；走 ACP 的 Agent 通过 `session/new|load|resume` 的 `mcpServers` 下发，不落盘；只有用户显式执行 `wemind config agent ...` 才会写真实文件。

| Agent | 写入位置 |
|---|---|
| kiro | `settings/mcp.json`（`sandbox` 副本） |
| gemini | `.gemini/settings.json` |
| qoder | `settings.json` 的 `mcpServers` |
| opencode | `opencode.json` 的 `mcp.servers` |
| cline | `mcp.json`（`CLINE_MCP_SETTINGS_PATH`） |
| pi | `<agent-dir>/mcp.json` |
| DSH | `profiles/<profile>/cordis.patch.yml` 的 `@deepseek-ai/dsh-mcp-client`（WeMind 只读解析） |
| Claude Code / Copilot | `~/.claude.json` / `~/.copilot/mcp-config.json`（Agent 自己读取；sandbox 才由 WeMind 经 ACP 投递） |
| codex | `~/.codex/config.toml` 由 Codex 自己加载，同名原生优先；`direct` 不重发 catalog，`sandbox` 才按激活集经 ACP 下发。WeMind 只读解析 TOML 用于列出/指标，不写回，也无法 unload 原生项；原生含 `wechat` 时只告警 |

**“通过 ACP 传 MCP”不等于“覆盖真实配置”。** 实测确认 DSH 会把 ACP `mcpServers` 与 profile 里的 MCP **合并**、Claude Code 也会读 `~/.claude.json`；所以 `sandbox` 的 brain 默认空集不能只靠“传空列表”。DSH 的做法是复制 profile 时**剥离全部 `dsh-mcp-client` 条目**，再按激活集经 ACP 注入；文件式 Agent 则写沙箱配置。新增 Agent 必须实测“传空列表是否真的不加载”，不能假设 ACP 参数会替换；做不到时必须在能力矩阵里标注，不能承诺“brain 默认空 MCP”。

### 8.4 性能与观测

MCP 数量会同时影响：

- **启动**：每个 stdio MCP 一次子进程启动 + 握手；HTTP MCP 一次网络连接；失败会等到超时。
- **首帧**：工具 schema 进入模型上下文，增加 prefill 和 token 成本，可能降低工具选择准确率。
- **内存**：每个 MCP 进程都占内存。

设计约束：

- 不自动禁用“成功但慢”的 MCP；只警告，避免微信侧行为悄悄偏离终端。
- 记录 `mcpCount`、`nativeMcpCount`、`mcpStartupMs`、`sessionNewMs`、`firstFrameMs`（已实现，`agents/config/mcp-perf.ts`）；`scripts/doctor.ps1` 汇总 `mcpCount/sessionNewMs/firstFrameMs` 并在异常时提示（阈值与代码里的常量保持一致），`nativeMcpCount/mcpStartupMs` 以日志为准。
- MCP 预检/跳过坏条目尚未实现（Phase 2）：当前只在“定义无法转成 ACP”时跳过并告警；起不来的 MCP 由 Agent 自己报错，WeMind 不替它探测或剔除。
- DSH 这类“坏 MCP 会回滚整个 session”的 Agent 要在日志与文档里明确提示风险；WeMind 不因此阻止启动，由用户决定是否保留该 MCP。
- 用户可用 `mcp.disable` 显式关闭重型 MCP；微信侧额外 MCP 用 `mcp.extra`。brain 的 `mcp.extra` 只是“可加载目录”，仍需显式 `加载`；worker 的 `mcp.extra` 默认生效。

---

## 9. 工作区设计

### 9.1 要求

- 绝对路径、已存在、是目录；显式指定时不自动创建任意路径。
- 本地磁盘，realpath 可解析；Windows 拒绝 UNC（`\\server\share` / `//server/share`），所有平台都拒绝显式网络挂载语义（例如 `file://host/...`）。
- 当前用户可读写；POSIX 默认目录 0700、文件 0600，Windows 用数据目录自身的 ACL（`chmod` 是 no-op，不能假装等价）。
- 不能是账号根目录（`<账号>/` 本身）、`DATA_DIR` 根、`brain-home`、`worker-home`、`agent-overrides`、`media`、`agent-sessions`、Agent 真实配置目录、系统目录或家目录根；也不能位于这些目录内部、包含 `DATA_DIR` 根，或落在其它账号的数据目录内。
- 路径稳定；`session/new` 的 `cwd` 是会话身份的一部分。
- 项目级技能/规则需要项目根时，用户应把工作区指到项目根。
- `external` 工作区不随账号删除；`managed` 工作区随账号清理。

### 9.2 默认布局

```text
~/.wemind/<账号>/
├── workspace/
│   ├── brain/       # brain 默认 managed 工作区
│   └── worker/      # worker 默认 managed 工作区
└── workspace.json   # 可选；首次 workspace set 时创建
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
| `workspace/{brain,worker}/` | 全部 | 默认 managed 工作区；账号启动时自动创建，0700 |
| `workspace.json` | 全部（按需） | brain / worker 的默认工作区覆盖；唯一权威；只在 `workspace set` 时创建 |
| `session-cwd.json` | 全部（按需） | `<agent>:<sessionId> → cwd`；恢复会话时校验；首次记录会话 cwd 时创建 |
| `agent-overrides/<agent>.json` | 全部（按需） | 微信侧 overlay，只支持 `mcp.disable` / `mcp.extra`；目录随账号创建，文件首次写入时生成 |
| `wechat-settings.json` | 全部 | 预留的账号级微信行为设置（回复风格等）；daemon 启动时若无则创建空 `{version:1}` |
| `env.json` | 可选（按需） | 非敏感环境快照（PATH/代理/locale），不含密钥 |
| `brain-mcps.json` | 仅 `sandbox` | brain 显式激活的 MCP 集；按 agent 分键；`direct` 不读 |
| `media/inbound/` | `direct` | 入站文件/视频/无转写语音；`sandbox` 仍放各自 home 下 |
| `brain-home/`、`worker-home/` | 仅 `sandbox` | 账号副本；`direct` 不创建 |
| `agent-sessions/` | 仅 `sandbox` | DSH 等 Agent 的派生会话配置；`direct` 用 Agent 真实会话库 |
| `brain-sessions.json`、`worker-sessions.json`、`session-registry.json` | 全部 | 会话指针与展示元数据，语义不变 |

`direct` 的新入站媒体统一写到 `<账号>/media/inbound/`；迁移时把旧 `brain-home/media/inbound/` 整体搬到新位置，失败则保留备份并告警。`sandbox` 模式保持现有 `<sandbox>/media/inbound/`，避免一次改动同时动两套路径。该路径变化必须同步更新 `AGENTS.md` §4.19、`media-store` 测试与数据目录速查。其余账号数据（token、state、tasks、control-inbox/out、日志）保持现状，详见 [速查：数据目录与环境变量](../使用指南/速查-数据目录与环境变量.md)。

### 9.3 会话绑定

- 新建 session 时把 `cwd` 传入 `session/new`。
- 已有 session 保持原 cwd；改默认工作区只影响下一条新会话。
- 设置/重置工作区时，微信与 CLI 都提示“需要新会话才能生效”。
- 恢复旧会话时使用该 session 记录的 cwd；如果 Agent 不接受新 cwd，则明确报错或新建，不静默搬家。
- 已新增 `<账号>/session-cwd.json` 记录 cwd；`brain-sessions.json` 的 string→string 格式保持兼容。
- 旧会话没有 cwd 记录时，优先用 Agent 自己保存的会话 cwd；两者都没有才回落到当前默认工作区，并在日志/回复里标注“旧会话 cwd 未知”。

### 9.4 worker 工作区

- 每个任务有自己的 `cwd`；`--cwd` 优先，其次任务创建时的默认工作区。
- 任务续跑使用 `tasks.json` 里保存的 cwd，不使用当前默认工作区。
- 并发任务共享 workspace 时，文件冲突由任务自身负责；可用不同 `--cwd` 隔离。

### 9.5 危险路径确认

以下路径拒绝或要求二次确认：

- 账号根、`DATA_DIR` 根、`brain-home`、`worker-home`、`agent-overrides`、`media`、`agent-sessions`；
- Agent 真实配置目录（如 `~/.kiro`、`~/.claude`）；
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

当前 `scripts/doctor.ps1` 会打印各 Agent 的 bin 路径与 `--version` 是否成功；逐 Agent 打印“解析来源（显式 / 快照 / 继承 PATH / fallback）”的 `wemind doctor` 是 Phase 2/3 预留，当前未实现。无论用户用 fnm、nvm、Volta、asdf、mise、corepack、conda 还是手工 PATH，都走同一套 PATH / `wemind env capture` 诊断，不需要在代码里枚举。

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

- 配置同源后，Agent 的会话库落在 Agent 真实配置目录；微信创建的 session 与终端 session 在同一个 Agent 会话库中。
- 终端 Agent 的 `session list` 应能看到微信产生的会话；具体显示名称/标题由 Agent 自己决定。
- WeMind 的 `brain-sessions.json` 仍是“微信当前用哪条 session”的权威；它不替代 Agent 的会话库。

### 11.2 会话键

- brain：`<agent>:<userId> → sessionId`。
- worker：`<agent>:task-<编号>@<userId> → sessionId`。
- 切换 Agent 不覆盖其他 Agent 的会话。
- 已实现 cwd 记录：`session-cwd.json`，键 `<agent>:<sessionId>`；`session-registry.json` 的 `cwd` 仅用于展示。

### 11.3 DSH 的处理

- `sandbox` 模式保留 `isolateSessions: true`，避免与 kiro/pi 共用沙箱根时的 `unsupported flat-file layout`。
- `direct` 关闭 `--patch`，让 DSH 使用真实 `~/.dsh` 会话库，终端可见微信会话。
- 如果 DSH 升级后出现会话布局冲突，回退 `sandbox` 并记录已知坑。

### 11.4 删除语义

- `删除会话` 仍只删 WeMind 的登记/指针，不删除 Agent 自己的历史（除非 Agent 支持 `session/delete` 且用户明确要求）。
- `wemind delete` 删除账号目录；不删除 Agent 真实配置目录、external workspace、Agent 会话库。
- 文档与回复必须写清楚“Agent 自己那份历史仍在它的存储里”。

---

## 12. 权限与 yolo

### 12.1 Agent 侧

| Agent | 免审批方式 |
|---|---|
| kiro v2 | `acp --trust-all-tools` |
| kiro v3 | `sandbox` 生成 `settings/permissions.yaml` allow-all（真实文件已有则尊重）；`direct` 用真实设置 |
| gemini | `--acp --approval-mode yolo --skip-trust` |
| copilot | `--allow-all-tools`（不启用完整 `--allow-all` 的路径/URL 放宽） |
| opencode | `sandbox` 生成 `opencode.json` 的 `"permission": "allow"`；`direct` 用真实配置 |
| DSH | `DSH_PERMISSION_MODE=danger-full-access` |
| qoder | `--acp --yolo` |
| cline | `--acp --auto-approve true` |
| pi | 无（默认不逐次审批） |
| claude-code | `session/set_mode {modeId:"bypassPermissions"}` |
| codex | `INITIAL_AGENT_MODE=agent-full-access` + `session/set_mode` |

### 12.2 宿主侧

- `session/request_permission` **默认 yolo**：自动选择 `allow_once` / `allow_always`；要恢复逐次拒绝，设 `WEMIND_ACP_AUTO_ALLOW=0`。
- 不是所有 Agent 的 yolo 都等价；Copilot 的路径/URL 限制、DSH/codex 的沙箱层仍需在接入文档中标注。
- 启动日志会打印实际启动参数（含 yolo / `bypassPermissions` 等）；`wemind doctor` 的逐 Agent 提示是 Phase 2/3 预留，当前以文档和日志为准。

---

## 13. 多账号与并发

### 13.1 多账号

- WeMind 账号数据继续按 `<账号>/` 隔离：token、state、session 指针、tasks、overlay、workspace、日志。
- Agent 真实配置、技能、记忆、会话库默认共享。
- 每个账号可有独立的 `agent-overrides/<agent>.json`、`workspace.json`，以及 **仅 `sandbox` 使用**的 `brain-mcps.json`。
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

如果某个 Agent 被实测不支持共享 Agent 真实配置目录：

1. 标记 `sharedHome: unsupported`；
2. 提示用户显式选择 `sandbox`（或使用独立 OS 用户/虚拟机），**不悄悄改变账号的默认 `direct`**；
3. 文档与 `scripts/doctor.ps1` 明确说明；`wemind doctor` 为 Phase 2/3 预留；
4. 不因为单个 Agent 影响其他 Agent 的 parity 默认。

---

## 14. 安全与护栏

必须保留：

- WeMind 自己生成/下发的 MCP 集按名字和定义双重排除 `wechat`；Agent 真实配置里的微信 MCP 在 `direct` 下只告警、不阻止启动，由用户自行删除；`sandbox` 复制配置时剔除，真实文件不动。
- 出站附件敏感文件 denylist、UNC/网络路径拒绝、NTFS 数据流拒绝、大小上限。
- 工作区不能是账号根、Agent 真实配置目录、系统目录；危险路径二次确认。
- 不把 API key/token 写入 overlay、env 快照；`sandbox` 若必须复制含密钥文件，按 0600 + 敏感文件 denylist + 告警处理，且不得进入 overlay。
- 写真实配置前备份；用 mtime/hash 做乐观并发校验，发现终端侧刚改过就拒绝覆盖并写 `.conflict-<时间>`；原子写。
- 启动日志/`doctor` 明确提示 yolo 与完整权限。

已知但接受的边界：

- 同一 OS 用户下，Agent 可通过 shell 读取账号目录/控制桥/任务目录；工作区不是安全边界。
- 需要更强隔离时，使用独立 OS 用户、容器或虚拟机，或 `sandbox` 模式。
- 硬链接无法从路径区分，属于已接受风险。

---

## 15. 迁移

### 15.1 新账号

- 默认 `homeMode = direct`。
- 创建 `<账号>/workspace/{brain,worker}`、`media/inbound`、`agent-overrides/` 目录与空的 `wechat-settings.json`；不主动写 `workspace.json` / `runtime.json`（缺省分别就是 managed / direct，账号目录搬家后不会留下失效绝对路径）。per-agent 的 `agent-overrides/<agent>.json` 只在首次执行 `wemind config wechat ...` 写入时按需生成，不预创建空文件。
- 不创建 `brain-home` / `worker-home`，除非用户选择 `sandbox`。

### 15.2 老账号

用户接受“迁移不了可以丢数据”，因此采用“尽力迁移、必须备份”。当前实现只有下面两步：

1. 先把 `brain-home/media/inbound/` 搬到 `<账号>/media/inbound/`；冲突文件跳过，失败则保留原目录并告警。
2. 检测到 `brain-home` / `worker-home` 时，重命名为 `brain-home.bak-<时间>` / `worker-home.bak-<时间>`，保留人工恢复点。

明确未实现、不要按旧方案理解：

- 不复制/迁移旧 Agent 会话文件，也不改写 `brain-sessions.json` / `worker-sessions.json`。旧沙箱会话在 `direct` 下可能无法 `load/resume`，此时如实报错，用户在微信发 `新会话` 即可。
- 不迁移 `brain-mcps.json`；该文件只在 `sandbox` 下有语义。
- 不生成 `workspace.json` / `session-cwd.json` / per-agent overlay；这些文件都按需创建。
- 没有 `wemind config migrate --rollback` 命令，也没有启动后的微信迁移通知；回滚只能人工把 `.bak-<时间>` 目录改回原名。

不自动删除备份；由用户确认后清理。

---

## 16. CLI 与微信交互

### 16.1 CLI

| 命令 | 作用 |
|---|---|
| `wemind config show [--key <key|label>]` | 显示 homeMode、真实配置目录、overlay 目录、workspace、env 快照键与 `sandbox` 的 MCP 激活集文件 |
| `wemind config home-mode [direct|sandbox]` | 查看/写入 `<账号>/runtime.json`；重启 daemon 后生效 |
| `wemind config reload [--key <key|label>]` | 经控制桥让常驻 brain 重建进程，空闲时执行 |
| `wemind config agent show|get|set|unset|edit <agent> [<键路径>] [值] [--file <相对路径>]` | 默认修改真实 Agent 配置；写入前备份并做并发校验 |
| `wemind config wechat show|edit <agent>` | 只读写微信侧 overlay 的 `mcp.disable` / `mcp.extra`，不碰真实文件 |
| `wemind workspace show|set <绝对路径>|reset [--role brain|worker] [--key <key|label>]` | 查看/设置/重置工作区；提示新会话生效 |
| `wemind mcp list|enable|disable|add|remove [--key <key|label>]` | 管理 **`sandbox` 下** brain 的 MCP 激活集与 overlay `disable`/`extra`；`direct` 下不维护激活集；worker 不通过该命令单独配置 |
| `wemind env capture|show|clear [--dry-run] [--key <key|label>]` | 捕获/查看/清除非敏感环境快照；`--dry-run` 只预览 |
| `wemind config promote` / `wemind doctor` | **Phase 2/3 预留**，当前未实现；不要写进用户说明当作现成命令 |

### 16.2 微信

- `加载 <MCP>` / `卸载 <MCP>`：`sandbox` 下操作 brain 激活集，只影响新建的 brain 会话，当前会话不变；`direct` 下原样作为消息交给 Agent，由 Agent 自己决定能否修改配置。
- 真实配置里没有的额外 MCP：用 `wemind config wechat edit <agent>` 或直接编辑 `<账号>/agent-overrides/<agent>.json` 写入 `mcp.extra`。微信聊天侧第一期只有 `微信配置 查看 <agent>`（只读）；`wechat_config` 工具是第三期预留。不要在聊天里让模型手写 JSON。
- `工作区` / `设置工作区 <路径>` / `重置工作区`：仅登录者；回复“需要新会话生效”。
- `微信配置 查看 <agent>`：确定性只读入口，避免自然语言歧义；修改入口是本机 CLI 或直接编辑文件。
- 自然语言“微信侧用模型 X”：overlay 当前不支持模型/权限/settings，只有 MCP 增删；第一期通过 `wemind config wechat edit` 落盘，第三期才评估 admin MCP 的 `wechat_config` 工具。不要把“自然语言直接调用工具”写成当前已实现能力。

---

## 17. 实施阶段

### Phase 0：设计定稿（已完成）

- 本文评审、确认命名、确认安全前提。
- 建立 Agent 能力矩阵与验收用例。

### Phase 1：核心 parity 模式（已实现，待逐 Agent 真机验收）

- `homeMode` 抽象（`direct` 默认 / `sandbox` 显式隔离）。
- `direct` 完全使用真实配置；`sandbox` 才有 MCP/yolo 生成文件。
- `sandbox` 下 brain 默认空 MCP、显式加载持久；worker 全量减 `wechat`。
- `workspace.json`、brain/worker 默认工作区、会话 cwd 绑定、变更提示。
- `agent-overrides`（仅 MCP 增删）、`wechat-settings.json`、`session-cwd.json` 与 `direct` 入站媒体路径。
- `env capture`（通用 PATH / 版本管理器 / 代理；不含密钥，不绑定 fnm）。
- 会话共享与终端可见（先验 kiro / opencode / qoder / gemini / claude-code）。
- 配置 reload / hash 检测 / 冲突备份。
- 老账号迁移：只实现搬入站媒体与旧 `brain-home`/`worker-home` 重命名备份；不迁移旧会话、`brain-mcps.json` 或 overlay。`config migrate --rollback` 尚未实现，回滚依靠 `.bak-*` 目录人工恢复。

### Phase 2：剩余 Agent 与体验补全（未开始）

- ✅ 已完成：MCP/首帧观测 + doctor 告警；Codex `config.toml` 只读 MCP 解析与 `wechat` 告警；`codex-acp 2.6.0` 全套探针复测。
- ✅ 已完成（握手级）：10 个预设全部通过 `brain check`（kiro / qoder 修复 PATH 后补跑）。
- ✅ 已完成（prompt 级）：早期临时配置下 9/10 跑通两轮真实对话（opencode / gemini / cline / pi / copilot / codex / kiro / claude-code / qoder，见 §18.2.1）；deepseek 已确认 `session/new` 跟随真实 profile 的 `- id: acp`，但其 provider 依赖（用户自己的模型网关）未就绪，prompt 未补跑。
- 待做：等用户自己把 DSH 的 provider 依赖准备好后补跑 deepseek；再扩到技能/记忆共享与会话可见性，并在 `direct` / `sandbox` 两种模式下各跑一遍。
- 待做：混合配置文件的三路合并；JSONC 注释与 YAML 的保留格式编辑（引入 `jsonc-parser` / `yaml` Document API 后开放）。
- 待做：各 Agent 并发/锁/会话库实测。

### Phase 3：体验与治理（未开始）

- 微信自然语言 `wechat_config` / `agent_config` admin MCP 工具（第一期只有 CLI 写入口与微信只读查看）。
- `config promote`、冲突提示、overlay diff。
- 多账号并发测试矩阵。
- 文档、CHANGELOG、接入文档同步。

---

## 18. 测试矩阵与验收

### 18.1 单元测试

- `AgentHomeResolver`：10 个 Agent 的 `direct` / `sandbox` 选择；`direct` 直接返回预设的真实配置目录（`realHome`），`sandbox` 才计算副本路径。
- `sandbox-inherit`：链接/复制/清单清理；kiro v3 `permissions.yaml` 不穿透 junction。
- `OverlayStore`：路径 patch、删除、数组替换、未知键告警。
- `McpPolicy`：brain 空集、显式加载持久、worker 全量、wechat 排除、disable/extra。
- `WorkspaceManager`：managed/external、危险路径、缺失路径、session cwd。
- `AgentConfigWriter`：备份、mtime/size/hash 冲突拒绝、密钥字面值拒绝、原子写、含注释 JSONC 拒绝。
- `MediaStore`：`direct` 走 `<账号>/media/inbound`，迁移与清理不越界。
- `EnvProvider`：白名单、密钥过滤、0600；快照覆盖 PATH 后能解析到任意安装方式的 Agent，未捕获变量仍继承；不依赖 fnm。
- `SessionBinder`：sessionId↔cwd、恢复不匹配、旧格式兼容。

### 18.2 每个 Agent 的 E2E

1. 终端改模型/设置 → 新微信会话使用新值。
2. 微信侧明确说“微信侧/仅微信”时改 overlay 的 MCP 增删 → 微信生效，真实配置不变；模型/权限/settings 不走 overlay。
3. 终端新增 skill/memory → 微信可用；微信写 memory → 终端可见。
4. yolo：常见工具无逐次询问；宿主边缘请求自动放行。
5. `sandbox` 下 brain 默认无 MCP；显式加载一个 → 所有新会话都有；卸载 → 消失。`direct` 下由真实配置决定。
6. `sandbox` 下 worker 默认全量 MCP 减 `wechat`；坏 MCP 只告警，由 Agent 自己处理。`direct` 下 worker 不额外下发，由 Agent 自己加载。
7. 工作区切到项目根 → 新会话看到项目 `AGENTS.md`/skills；旧会话不变。
8. 微信会话在终端 Agent 会话列表中可见。
9. daemon 重启后 session resume/load，cwd 正确。
10. 两个账号不同 overlay/workspace，同时运行不串数据。
11. 终端 + 微信 + 多 worker 并发，配置/会话库不损坏（按 Agent）。
12. 真实配置包含 `wechat` 时：`direct` 只告警、不阻止启动；`sandbox` 副本剔除、真实文件不动；WeMind 下发集永不包含 `wechat`。
13. 老账号迁移、备份与人工恢复（没有自动回滚命令）。
14. `direct` 入站文件/视频落到 `<账号>/media/inbound/`，prompt 中的绝对路径可读，30 天/1GB 清理仍生效。
15. 直接编辑 overlay 与微信自然语言修改都能触发 idle reload；改真实配置也能在下一条新会话生效。
16. `sandbox` 下对 ACP 传 MCP 的 Agent，实测“传空列表”确实不加载真实配置里的 MCP；若只是增量合并，说明该 Agent 的原生 MCP 不受 WeMind 控制，只做提示。`direct` 不承诺空集。

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

#### Prompt 级 E2E（同日，早期临时配置，真实 Agent 配置目录，临时账号目录）

> 记录于 2026-11-12；当时用的是早期临时配置（现已收敛为 `direct` / `sandbox`）。本表只保留“这些 Agent 曾在真实配置目录上跑通两轮 prompt”的实测事实。

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

1. **无 `homeEnvVar` 的 Agent env 拼错**：`claude-code` / `cline` / `qoder` 的 `env` 模板曾假设 `%HOME%` 是沙箱根，在直接使用真实配置目录时变成 `~/.claude/claude`、`~/.cline/cline`、`~/.qoder/qoder`。该问题已随配置来源收敛为 `direct` / `sandbox` 修复：`direct` 不注入预设 `env`，只保留 `envDefaults` 与凭据桥接。守卫：`brain-agents.test.ts`。
2. **模型设置失败不应打死整轮**：`applyAcpModel` 原来把 `session/set_config_option` 的失败重新抛出，Agent 升级后旧 model id 失效会让每条消息都失败。现在只记 `WARN`（附 `wemind brain set <agent> --model` 提示），继续用 `session/new` 的默认模型。守卫：`acp-connection.test.ts`。

**结论**：9/10 在真实配置基线上完成两轮 prompt（claude-code / qoder 修好环境后补跑通过）；只剩 deepseek 依赖用户自己的 provider 就绪。下一步是等该依赖可用后补跑 deepseek，并扩展到技能/记忆与会话可见性。

### 18.3 性能验收

- `sandbox` 下 brain 默认空 MCP，启动/首帧不应比现状明显变慢；`direct` 由真实配置决定，不承诺空集。
- worker 全量 MCP 允许变慢，但必须记录 `mcpCount` / `mcpStartupMs` / `sessionNewMs` / `firstFrameMs`（已实现）；异常只警告，不自动禁用。
- 具体阈值按 Agent 实测后写入接入文档，本文不预设硬指标。

---

## 19. 风险与开放问题

| 风险 / 问题 | 处理 |
|---|---|
| 终端与微信同时写同一配置文件 | `direct` 下 WeMind 运行期不自动写 Agent 文件（显式 `config agent` 写入口会备份并做并发校验）；需要隔离时用 `sandbox` |
| Agent 有全局锁/单实例限制 | 实测后标 `sharedHome: unsupported`，提示用户显式改用 `sandbox` |
| 会话库 SQLite/多进程并发 | 按 Agent 实测；必要时限制并发或隔离会话目录 |
| MCP 多导致启动/首帧变慢 | 记录指标、警告、允许 disable；不自动改变行为 |
| JSONC/YAML/TOML 格式与注释 | 第一期：JSON/无注释 JSONC 可写；含注释 JSONC 拒绝；YAML/TOML 只读。Phase 2 再接保留格式编辑器 |
| Windows 文件 symlink 权限 | 目录用 junction；文件用 hardlink/复制+watcher；必要时 `sandbox` |
| codex 无独立配置目录、原生 MCP 与 ACP MCP 双来源 | 原生 `config.toml` 由 Codex 加载；WeMind 只读解析用于列出/指标，只管理 ACP 下发的额外项，同名原生优先。原生含 `wechat` → 只告警（无法替它 unload），由用户自行删除 |
| Claude Code `settings.json` 含网关 token | `direct` 不复制该文件，Agent 自己读；`sandbox` 才复制，按 0600 + 敏感文件 denylist + 告警处理 |
| Copilot `--allow-all-tools` 仍可能触发路径/URL 审批 | 实测；若频繁则仅对该账号显式启用 `--allow-all`，默认不悄悄放宽网络访问 |
| DSH 坏 MCP 回滚 session | 当前不预检；坏 MCP 由 Agent 自己报错，日志提示风险，由用户决定是否保留 |
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
