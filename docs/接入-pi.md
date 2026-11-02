# 接入 pi coding agent（经 pi-acp 适配器，探针 + 真机 E2E）

> **适用版本**：WeMind 1.3.0 ｜ **最后核对**：2026-11-01 ｜ **实测环境**：Windows 11 + Node 24 + `pi-acp@0.0.34` + pi `1.4.0`
>
> **状态**：✅ 内置预设、ACP 探针全绿（`initialize` / `session/new` / prompt / 图片 / 强杀后 `session/load` / 工具调用 0 反向请求）；**微信真机 E2E 已通过（2026-11-01：brain 单轮、热切换 pi↔codex、微信「任务 pi：…」派发）**。
>
> [pi](https://github.com/earendil-works/pi)（`@earendil-works/pi-coding-agent`）本身**不带 ACP server**，经社区适配器 [pi-acp](https://www.npmjs.com/package/pi-acp)（bin `pi-acp`，内部 spawn `pi --mode rpc` 并在 ACP 与 pi RPC 之间桥接）接入。WeMind 内置预设名：**`pi`**。

---

## 1. 准备

```powershell
npm i -g @earendil-works/pi-coding-agent   # pi 本体（实测 1.4.0；Node ≥22）
pi                                          # 终端里先配好模型/登录（pi 自己的 Terminal Auth / API key）
npm i -g pi-acp                             # ACP 适配器（实测 0.0.34）
```

适配器要求 `pi` 在 PATH 上：**只装 `pi-acp` 不够**。WeMind 的 `requiresBins: ["pi"]` 会在 `wemind brain` / `wemind brain check` 里提前报「运行时 pi 缺失」，不会等 `session/new` 才抛适配器的内部错误。

## 2. 预设要点（`brain-agents.ts`）

| 项 | 值 | 说明 |
|---|---|---|
| 启动 | `pi-acp`（无参数），Windows shim 是 `.cmd` → `shell: true` | 适配器是 npm 全局装的**独立二进制**，非 npx |
| 运行时依赖 | `requiresBins: ["pi"]` | pi-acp 内部 spawn `pi --mode rpc`；只装适配器不够 |
| 沙箱 | `PI_CODING_AGENT_DIR` → brain/worker 沙箱根（pi 的配置目录 env，默认 `~/.pi/agent`） | 配置目录 = 沙箱根本身（同 kiro 布局） |
| 凭据同步 | `settings.json` / `auth.json` / `models.json` / `models-store.json`（新者胜、原样复制） | 默认模型/供应商、登录态、自定义供应商（如 magpie 本机网关）跟着用户日常配置走 |
| 记忆/技能继承 | `skills/`（junction）+ `AGENTS.md`（拷贝） | pi 读 `<agent-dir>/AGENTS.md` 作跨目录全局指令（官方 configuration.md） |
| 免审批 | **无需任何开关** | pi 默认不逐次审批（官方 security.md 明说），也没有需要切的 `session/set_mode` |
| 启动横幅 | `settingsDefaults: { quietStartup: true }` | pi-acp 把 pi 的启动信息（`## Context` / `## Skills` …）当 `agent_message_chunk` 发出来；用 pi 自己的 `quietStartup`（官方 settings.md）关掉。只补缺失键：用户显式设过就保留用户的值，真实配置不动 |
| 模型 | 预设不带 `model` → 跟随用户 pi 的默认（`settings.json` 的 `defaultProvider`/`defaultModel`） | 覆盖：`wemind brain set pi --model "<provider>/<model>"`（走 `session/set_config_option`，pi-acp 的 configId 就叫 `model`） |
| 恢复 | 默认 `load`（pi-acp `loadSession: true`） | 会话映射表在**真实 home** 的 `~/.pi/pi-acp/session-map.json`（适配器写死 `homedir()`，不随沙箱走）；会话文件本体仍在各自沙箱的 `sessions/` 下 |
| 自动探测 | **不在 `AUTO_PROBE_ORDER`** | 适配器类不参与 auto（装好适配器 ≠ 已登录/配好模型）；用 `wemind brain set\|switch pi`、一次性 `WEMIND_BRAIN=pi`，或微信「切换大脑 pi」显式选用 |
| MCP | `<沙箱根>/mcp.json`（kiro 格式 `{mcpServers:{名:{command,args,env}}}`），`mcpViaAcp: false` | `pi mcp list` 实测读 `<PI_CODING_AGENT_DIR>/mcp.json`（不是 `settings/mcp.json`）；pi-acp 只把 `session/new` 的 `mcpServers` 存进会话、从不读取，所以 WeMind 的动态 MCP 走配置文件 |

## 3. 探针实测结论（`scripts/acp-probe.mjs`，2026-10-30）

| 项 | 结果 |
|---|---|
| `initialize` | `protocolVersion: 1`；`loadSession: true`；`image: true`；mcpCapabilities http/sse 均否 |
| `session/new` | OK；`configOptions` 有 `model`（select，currentValue = 用户 pi 默认）与 `thought_level`（low/high） |
| prompt | 首帧 **0–3ms**；简单问答 4–7s；update 类型 `agent_message_chunk` / `agent_thought_chunk` / `session_info_update` / `usage_update` / `available_commands_update`，工具轮还有 `tool_call` / `tool_call_update`（有 activity 帧，心跳无忧） |
| 图片 | 接受（`end_turn`） |
| 反向请求 | **0**（不问权限、不用 fs/terminal 委托） |
| `ACP_HARD_KILL=1` 后 `session/load` | ✅ 上下文接上（PINEAPPLE） |
| 漂移检测（`ACP_TEST_TOOL=1`） | ✅ 工具强制 prompt → 3 次工具调用全部执行、标记文件落盘、**0 个 `session/request_permission`**（2026-11-01 复跑同结论；上游改审批默认时探针会红） |
| MCP | ✅ 配置路径：`pi mcp list` 能识别 `<PI_CODING_AGENT_DIR>/mcp.json` 里的 `mcpServers`（kiro 格式）；`session/new` 的 `mcpServers` 不被 pi-acp 使用（只存不读） |

## 4. 已知限制

- **启动横幅默认关掉**：pi-acp 会把 pi 的启动信息（`## Context` / `## Skills` …）当作 `agent_message_chunk` 发出来（源码 `setStartupInfo`；那是给 Zed 之类客户端看的启动面板），在微信里就成了新会话首答的前缀。预设用 pi 自己的 `quietStartup: true`（官方 settings.md）在沙箱 `settings.json` 里关掉；用户显式设过 `quietStartup` 就保留用户的值，真实 `~/.pi/agent/settings.json` 不动。
- **worker 沙箱按任务 agent 准备**：daemon 启动时只按默认任务大脑备一次 worker-home；派发到别的 agent（`wemind task --agent pi` / 微信「任务 pi：…」）时 `worker-pool.ts` 的 `acquire` 会在起进程前按**这条任务的 agent** 再跑一次 `ensureWorkerHome(ag)`——否则 pi 的 `settings.json` / `models.json` 没进沙箱，它会拿空配置跑（2026-11-01 真机踩过：任务输出异常）。
- **MCP 走配置文件**：WeMind 把激活集写进 `<沙箱根>/mcp.json`；pi 自己也会读真实 `~/.pi/agent/mcp.json`，但 WeMind **不复制**用户的 mcp.json（沙箱里的 MCP 视图由 WeMind 控制，`wechat` 永久排除）。`pi mcp list` 的 `exposure` 默认是 `codemode`；若某 server 显示 `disabled`/`failed`，先看 `pi mcp list --json` 的 `state`/`error`（连接失败与「不支持」是两回事）。
- **有 thought 与 tool 帧**（2026-11-01 复跑 `pi-acp@0.0.34` + pi 1.4.0）：除 `agent_message_chunk` 外还会发 `agent_thought_chunk`、`tool_call` / `tool_call_update`——早期探针曾记为「只有 message chunk」，以本机复跑为准；这些帧也给 15s 心跳提供了 activity。
- **沙箱隔离不完整（已核对适配器源码）**：`~/.pi/pi-acp/session-map.json`、`~/.pi/agent/prompts`、`~/.agents/skills` 由 pi-acp 从真实 `homedir()` 读取，不随 `PI_CODING_AGENT_DIR` 走；`settings.json` 是原样复制，里面的 `packages`/`extensions` 键也会带进沙箱。跨账号共享的只是映射/提示词等元数据，**会话本体与凭据副本仍在各账号沙箱内**；但如果你要求「沙箱里看不到日常 pi 的扩展」，目前需要上游支持或额外剥离（WeMind 不替 agent 改配置，§4.14）。
- **适配器定位是 MVP**（开发以 Zed 为主），上游小版本可能快速变化——升级 pi-acp 后建议重跑 `wemind brain check` 和 `ACP_TEST_TOOL=1` 的探针。
- **微信 E2E**：brain 单轮、热切换（pi↔codex，daemon 不重启、会话按 agent 接回）、微信「任务 pi：…」派发均已通过（2026-11-01）。

## 5. 审批机制与漂移预案（假如 pi 改了默认）

- **「不逐次审批」是「没有开关」而非「开着开关」**：pi 的工具调用本来就不走审批（官方 security.md 明说）；审批拦截在 pi 里是**扩展机制**（permission gate：`tool_call` handler 可 confirm/block，官方示例 `examples/extensions/permission-gate.ts`），不是内建模式。
- **`defaultProjectTrust`（ask/always/never，只能在 agent 目录 settings 设）管的是「项目本地配置/资源要不要加载」，不是工具审批**——两者别混淆。
- **pi-acp 不转发参数给 pi**（2026-10-30 源码核实：argv 只解析 `--terminal-login`）——「启动时塞 flag」当前不通；**别**给预设 args 塞 `--yolo` 类 flag（适配器不解析就是静默无效，同 claude-code/codex 的教训）。
- **若上游改成逐次审批，按序应对**：
  1. **宿主兜底（零改动，立即生效）**：`WEMIND_ACP_AUTO_ALLOW=1` 逐次自动放行 `session/request_permission`——局限：只覆盖 ACP 权限请求通道，本质是「每次自动点允许」。
  2. **审批若内建成 settings 键**：写进 pi 的 settings.json 即可——沙箱把真实配置**原样同步**，日常 pi 与微信大脑保持一致；只想微信大脑放开、日常保守 → 预设加 `settingsBase: "settings.json"`（qoder 同款机制，以真实文件为基底生成沙箱版）。
  3. **审批若走环境变量**：预设 `envDefaults` 注入（默认值语义：部署方可用同名变量收紧，父进程已设时不覆盖）。
  4. **若是 trust 询问卡住**（沙箱 cwd 是新目录 → 默认 ask）：预设加 `settingsDefaults: { defaultProjectTrust: "always" }`（只补沙箱副本，用户显式设过则保留）。
  5. **需要启动参数透传**：只能给 pi-acp 上游提 issue（MVP 项目迭代快）或等 pi 官方原生 ACP。
- **漂移检测（已实现）**：`ACP_TEST_TOOL=1` 跑探针——强制走一次真实工具调用（写标记文件），记录期间 `session/request_permission` 次数并用文件系统验证「真的执行到了最后一步」（只看 stopReason 分不出「拒绝了」和「没执行」）。开启时探针整体 ok 包含此断言：`permission=0 && fileWritten=true`。「免审批」类预设升级 agent 后重跑一次，agent 若开始先问，探针先红而不是微信第一条消息卡 30s 超时。

## 6. 验证记录

- 探针：§3 全绿（含强杀恢复、图片与漂移检测工具调用）。2026-11-01 本机复跑（`pi-acp@0.0.34` + pi 1.4.0）：`ok=true`、`contextKept=true`、图片无报错、`toolTest.ok=true`（3 次工具调用 / 0 权限请求 / 标记文件落盘）、反向请求为空。
- `wemind brain` / `wemind brain check`：2026-11-01 本机实测——`生效：name=pi bin=pi-acp.cmd args=[] shell=true home_env=PI_CODING_AGENT_DIR model=(agent 默认) session_mode=(无)`，`可选 agent` 含 pi，自动探测顺序仍不含 pi；`brain check` 握手成功（initialize + session/new，~2.1s）。
- 单测：`brain-agents.test.ts` 覆盖预设字段、`requiresBins`（pi-acp 已装但 pi 缺失）、安装提示、`AUTO_PROBE_ORDER` 不含 pi；`sandbox-pi.test.ts` 覆盖 settings/auth/models 同步、`quietStartup` 默认值与用户值保留、MCP 排除 `wechat`/disabled；`pool-spawn.test.ts` 覆盖「按这条任务的 agent 备 worker 沙箱」。
- 真机（2026-11-01）：worker 通道 `wemind task "只回复数字 2" --agent pi` → `prompt ok 7857ms` → 回复「2」；删掉 worker-home 里 pi 的 `settings.json`/`models.json` 后再次派发，`acquire` 按任务 agent 自动重建（`quietStartup: true`）。brain 通道：微信消息 → `session/load` → `prompt ok 9705ms` → 回复送达（启动横幅未混入回复）。热切换：`brain switch codex`（1.1s）→ `brain switch pi`（1.0s），daemon pid 不变，两个方向都 `session/load` 接回各自会话；未知 agent 被拒、`brain.json` 不变。热切换后微信再问一句 → `prompt ok 5006ms` → 回复「4」。微信「任务 pi：…」→ 任务 #27 → `prompt ok 6945ms` → 回复「3」。
