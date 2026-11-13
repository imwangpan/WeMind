# 接入 Kiro CLI（原生 ACP；v2 真机 / v3 探针级）

> **2026-11-13 口径**：默认 `homeMode=direct`，WeMind 在 daemon 启动/运行期不自动写 Agent 配置（显式 `wemind config agent ...` 例外），Agent 直接读真实 home，并与终端共享配置、技能、记忆与会话库；本文涉及 `brain-home` / `worker-home` 的描述仅适用于显式 `homeMode=sandbox`。

> **最后核对**：2026-11-12 ｜ **实测环境**：Windows 11 + kiro-cli 2.37.1（v2）；v3 用临时 `KIRO_HOME` + `acp.agentEngine=v3` 验证
>
> **状态**：✅ 内置预设。v2（2.37.1）已实测，`wemind brain check` 通过（2026-11-03）；v3 探针级验证过握手（3812ms，2026-11-03）；**v3 的微信真机单轮待复测**。
>
> kiro-cli 原生实现 ACP，不需要适配器。WeMind 内置预设名：**`kiro`**。

---

## 1. 准备

```powershell
kiro-cli --version      # 本机实测 2.37.1
kiro-cli acp --help     # 2.37.1 原文：v2 when neither is set
```

- 二进制：`kiro-cli`（Windows 上是 `kiro-cli.exe`）。预设默认按这个二进制名解析，安装由用户自己完成。
- 配置目录：`KIRO_HOME`；`direct`（默认）不注入，直接用真实 `~/.kiro`；`sandbox` 下才指向账号沙箱。真实 `~/.kiro` 不被写入。
- WeMind 侧用 `wemind brain check` 做真实 ACP 握手：

```powershell
wemind brain set kiro       # 写入 <数据目录>/brain.json
wemind brain check          # initialize + session/new
```

> daemon 在跑时，磁盘上的改动用 `wemind brain switch kiro` 应用（不重启 daemon）。

## 2. 预设要点（`brain-agents.ts`）

| 项 | 值 | 说明 |
|---|---|---|
| 启动（v2） | `kiro-cli acp --trust-all-tools` | 预设 `args` 原样；v3 会被 `kiroEngine` 逻辑改写（见 §3） |
| 二进制 | `kiro-cli`；Windows `kiro-cli.exe` | 直接起 `.exe`，预设不设 `shell` |
| 配置目录 | `homeEnvVar: "KIRO_HOME"`，`configSubdir` 为空 | `direct` 不注入、用真实 `~/.kiro`；`sandbox` 下 `KIRO_HOME` 指向沙箱根，配置目录就是该根本身 |
| 真实配置 | `realHome: ~/.kiro` | 继承清单从这里取；真实文件一律不改 |
| 记忆 / 技能继承 | `inheritDirs: steering, memories, skills, agents, powers, tasks, extensions` | 与日常 kiro 的这七类目录共享 |
| 引擎 | `kiroEngine: true` | 启用 v2 / v3 判定、启动参数改写与 `sandbox` 的 `permissions.yaml` |
| 自动探测 | `AUTO_PROBE_ORDER` 最后一位 | `opencode → cline → qoder → gemini → deepseek → kiro` |

## 3. v2 / v3 引擎判定与免审批

判定顺序（`resolveKiroV3`，2026-11-03 支持 v3）：

1. 启动参数里的 `--agent-engine`（`v2` / `v3`，含 `--agent-engine=v3` 写法）：取到的值为 `v3` 时走 v3，否则按 v2。
2. 真实 `~/.kiro/settings/cli.json` 的 `acp.agentEngine`：值为 `v3` 时走 v3，否则按 v2。
3. `kiro-cli --version` 主版本 ≥3：走 v3（**假设 / 待实测**，只作兜底，防未来大版本把默认切到 v3 后仍带 v2 专属参数而握手超时）。
4. 其余：v2。

判定为 v3 时 WeMind 自动：

- 剔除 v2 专属的整会话信任参数 `--trust-all-tools` / `-a` / `--trust-tools`（含 `--trust-tools=...`）；v3 拒绝这批参数，带上会连 `initialize` 都不回；
- 启动参数里没有 `--agent-engine` 时补 `--agent-engine v3`；
- 在 `sandbox` 的 `settings/permissions.yaml` 写入 allow-all 规则（文件不存在时）：

```yaml
rules:
  - capability: all
    effect: allow
```

真实设置里已有这份文件就原样同步，**不覆盖用户规则**。它等价于 v2 的整会话信任。

注意事项：

- `--agent-engine` 还接受 `v1`：未验证，WeMind 按 v2 处理（保留 v2 参数）。
- `chat.agentEngine` **不影响** `acp`（官方文档原话），不能拿它推断——本机 `~/.kiro/settings/cli.json` 就是 `chat.agentEngine: "v3"` 而 `acp` 仍是 v2。
- `session/new` 的 `_meta.kiro.policyPreset` 是**假的**：2026-11-03 实测 `["allow-all"]` / `["allow_all"]` / `["trust-all"]` / `["all"]` 等写法都不生效——权限请求照发、写文件仍被拒。不要照它实现。

## 4. 探针实测结论

| 项 | 结果 |
|---|---|
| v2 `wemind brain check`（2.37.1） | ✅ 握手通过（initialize + session/new，2026-11-03） |
| v3 握手（临时 `KIRO_HOME` + `acp.agentEngine=v3`） | ✅ 通过，3812ms（2026-11-03） |
| v3 微信真机单轮 | 待复测（见 §7） |

复跑方式：

```powershell
# v2：预设默认
wemind brain set kiro
wemind brain check

# v3：显式指定引擎（启动参数优先于 settings/cli.json）
wemind brain set kiro --args "acp --agent-engine v3"
wemind brain check
```

也可以不写 `--args`，改真实 `~/.kiro/settings/cli.json` 的 `"acp.agentEngine": "v3"`（WeMind 读真实设置；`chat.agentEngine` 与它无关）。

## 5. 已知限制

- **v2 / v3 的参数不兼容**：v3 拒绝 `--trust-all-tools` / `-a` / `--trust-tools`，带上会连 `initialize` 都不回（表现为握手超时）。不要给 v3 手动补这批参数，免审批交给 `sandbox` 的 `settings/permissions.yaml`。
- **引擎判定看 `acp.agentEngine`，不看 `chat.agentEngine`**：后者只影响交互式 chat，官方文档明确它不影响 `acp`；拿它推断会判错。
- **「CLI 主版本 ≥3 默认 v3」是假设 / 待实测**：2.37.1 的 `kiro-cli acp --help` 只写了「v2 when neither is set」；这条规则仅作未来版本的兜底。
- **`--agent-engine v1` 未验证**：WeMind 按 v2 处理，保留 v2 参数。
- **`_meta.kiro.policyPreset` 是假方案**：多种写法实测都不生效（权限请求照发、写文件仍被拒），v3 免审批的权威位置是 agent 自己的 permissions 策略文件，不是 ACP 元数据。
- **`permissions.yaml` 不覆盖用户规则**：真实设置里已有这份文件时原样链接/同步；WeMind 只在文件缺失时补 allow-all。

## 6. 验证

已记录的结果：

- v2（2.37.1，2026-11-03）：`wemind brain check` 通过。
- v3（2026-11-03）：临时 `KIRO_HOME` + `acp.agentEngine=v3` 握手通过（3812ms）。

手工核对：

1. `wemind brain`：确认 `bin=kiro-cli.exe`；v2 时 `args=[acp --trust-all-tools]`，v3 时 `args` 里没有 v2 信任参数且有 `--agent-engine v3`。
2. `wemind brain check`：握手成功。
3. v3 `sandbox`：`settings/permissions.yaml` 存在 allow-all 规则（真实设置已有则内容与真实文件一致）。
4. v3 微信真机单轮：待复测（见 §7）。

## 7. 待实测

- **微信真机单轮（v3）**：只验证过握手（临时 `KIRO_HOME` + `acp.agentEngine=v3`，3812ms），真机微信单轮待复测。
- **「CLI 主版本 ≥3 默认 v3」**：假设 / 待实测，仅作兜底。
- **`--agent-engine v1`**：未验证，WeMind 按 v2 处理（保留 v2 参数）。
- **其余 ACP 能力（会话恢复、图片、MCP、反向请求等）**：本文未记录本机实测结论；升级 kiro 或需要依赖某项能力时，先用一次真实 prompt 复验。
