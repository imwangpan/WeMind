# 接入 Claude Code（ACP 适配器）

> **最后核对**：2026-11-05 ｜ **状态**：✅ 已内置预设、**探针级实测**（ACP 握手 / 一轮 prompt / 强杀后 `session/load` / stdio MCP / `bypassPermissions`）；**真机微信单轮 E2E 已通过**（2026-10-31）；重启续聊 / MCP 加载 / 任务派发待真机复测。
>
> 实测环境：Windows 11、Node 24.21.0、`@agentclientprotocol/claude-agent-acp` **0.99.1**、Claude Code **2.1.314**。适配器是 pre-1.0，升级后请按 §8 重新跑探针。

---

## 0. 一句话

Claude Code 本身不实现 ACP，要经官方适配器 **`@agentclientprotocol/claude-agent-acp`** 桥接。WeMind 的内置预设 `claude-code` 已经把它接成「对话大脑 / 任务 worker」：

```powershell
npm i -g @agentclientprotocol/claude-agent-acp   # 全局安装（Node ≥22）
wemind brain set claude-code --restart           # 写入 brain.json 并重启 daemon
wemind brain check                               # 真机 ACP 握手（会补验 set_mode）
```

不想重启时，daemon 在跑且认控制桥：

```powershell
wemind brain switch claude-code
```

微信里也可以发 `切换大脑 claude-code`。

---

## 1. 为什么用全局安装，而不是 `npx`

内置预设**不再**用 `npx -y @agentclientprotocol/claude-agent-acp`。口径与 `codex` 一致，**完整的对照表与理由只在 [接入其它-ACP-Agent.md §5 适配器安装口径](接入其它-ACP-Agent.md) 一处**（daemon 常驻 + worker 每条任务起进程，`npx` 每次冷启动都要问 registry、离线不可用、版本随 latest 漂移）。

`npx` 只作为「不想装、且能接受每次联网」的兜底：

```powershell
wemind brain set claude-code --bin npx --args "-y @agentclientprotocol/claude-agent-acp" --shell
```

> 这条只是覆盖启动方式；预设里的 `CLAUDE_CONFIG_DIR` 沙箱、`mcpViaAcp`、`sessionMode` 仍然生效。

---

## 2. 适配器与认证

### 2.1 安装

```powershell
npm i -g @agentclientprotocol/claude-agent-acp
claude-agent-acp --version     # 0.99.1
```

- **Node ≥22**（适配器 `engines` 要求），**而且必须是运行 daemon 的那个 Node**：适配器是 daemon spawn 出来的子进程，继承 daemon 的 PATH 与 Node。发布包 `engines` 只声明 `>=20.19`，`agentProblem()` 也只查 PATH 上有没有 `claude-agent-acp`、**不查 Node 版本**——所以 Node 20 的 daemon 能通过 `wemind brain` 预检、却会在 spawn/握手时失败。
- 适配器依赖 `@anthropic-ai/claude-agent-sdk`，后者带一个平台原生 Claude Code 二进制（Windows：`@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`）。**不要用 `--omit=optional` 安装**，否则会报 `Claude native binary not found`。
- 已经装了独立 Claude Code 的话，可以让适配器直接用它：

  ```powershell
  $env:CLAUDE_CODE_EXECUTABLE = "C:\Users\<你>\...\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
  ```

  这是适配器**自己的**环境变量（`claudeCliPath()` 优先读它），不是 WeMind 发明的。和 `CODEX_PATH` 一样，它要设在 **daemon 进程的环境**里才影响微信大脑（`wemind start` 前在同一个 shell 里设，或写进服务定义，设完重启 daemon）——在别的窗口里设只对那个窗口有效。

### 2.2 认证

适配器把认证交给 Claude Code，支持：

- `claude` 登录（OAuth）：登录态在 `~/.claude/.credentials.json`（macOS 可能在 Keychain）；WeMind 会把 `.credentials.json` 同步进沙箱。
- 环境变量：`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`；自定义网关再加 `ANTHROPIC_BASE_URL`。这些变量要对 **daemon 进程**生效（§4.9：密钥不写进 agent 配置）。

**WeMind 不复制 `settings.json`**：这份文件经常把网关 token 放在 `env` 里；按仓库纪律，凭据由 daemon 环境提供，不写进 agent 配置。因此你在 Claude Code 里设的 `hooks` / `permissions` 也不会带进微信大脑——权限由 `sessionMode`（见 §3）负责。**模型不由 WeMind 下发**（预设没有 `model` 字段，`applyAcpModel()` 见 `!ag.model` 就直接返回），跟随 Claude Code 自身配置与 daemon 环境；要固定就 `wemind brain set claude-code --model "…"` 再 `wemind brain switch claude-code` 应用。

---

## 3. 预设做了什么（`brain-agents.ts`）

```ts
"claude-code": {
  name: "claude-code",
  bin: "claude-agent-acp",
  binWin: "claude-agent-acp.cmd",   // npm 全局在 Windows 产出 .cmd shim
  args: [],
  shell: true,
  env: { CLAUDE_CONFIG_DIR: `%HOME%${path.sep}claude` },
  realHome: path.join(os.homedir(), ".claude"),
  inheritDirs: ["skills", "agents", "commands"],
  inheritFiles: ["CLAUDE.md"],
  configSubdir: "claude",
  // 真实 ~/.claude.json 与 realHome 同级；path.join 后得到 ~/.claude/../.claude.json
  catalogFile: path.join("..", ".claude.json"),
  credentialFiles: [".credentials.json"],
  mcpViaAcp: true,
  sessionMode: "bypassPermissions",
}
```

逐项说明：

- **`bin` 不再写 `npx`**：全局适配器本体就是 ACP server，`args` 为空。`shell: true` 是因为 Windows 上 npm 产出的是 `.cmd` shim。
- **沙箱**：`CLAUDE_CONFIG_DIR` 指到 `<BRAIN_HOME>/claude`。实测（Claude Code 2.1.314）它会连 `~/.claude.json` 一起搬进该目录——所以用户级 MCP 不会漏进大脑，隔离是完整的。
- **记忆/技能**：`CLAUDE.md` 拷贝进沙箱；`skills/`、`agents/`、`commands/` 用 junction/symlink 与日常使用共享。`settings.json`、`plugins/` 不继承（插件可自带 MCP）。
- **MCP 走 ACP**：`mcpViaAcp: true`，激活集随 `session/new|load` 的 `mcpServers` 下发，不写配置文件。目录取真实 `~/.claude.json` 的 `mcpServers`（`catalogFile` 用 `..` 回到 home）；`wechat` 永久禁止。
- **免审批**：`sessionMode: "bypassPermissions"`。适配器**不解析** `--dangerously-skip-permissions` 之类的 CLI flag；WeMind 在 `session/new|load|resume` 之后调用 `session/set_mode`。实测该模式下 MCP 工具调用**不再发** `session/request_permission`。
- **图片**：预设不设 `images: false`，即按支持图片处理；适配器 `initialize` 的 `promptCapabilities.image = true`。
- **恢复**：预设不设 `restore`，即先 `session/load`，失败再 `session/resume`，最后 `session/new`。实测 `loadSession: true`。

---

## 4. 探针实测（2026-10-30/31，claude-agent-acp 0.99.1）

用 [`scripts/acp-probe.mjs`](../../scripts/acp-probe.mjs)（另起一个临时 `CLAUDE_CONFIG_DIR`，不碰真实配置）：

| 项目 | 结果 |
|---|---|
| `initialize` 能力 | `loadSession: true`；`sessionCapabilities` 含 `resume / close / delete / fork / list / additionalDirectories / systemPrompt`（按条件还有 `subagents`）；`promptCapabilities.image: true`、`embeddedContext: true`；`mcpCapabilities: { http: true, sse: true }`（**没有声明 stdio，但实测 stdio 可用**） |
| `session/new` | 成功；`modes` = `default / acceptEdits / plan / auto / bypassPermissions`；`configOptions` = `mode / model / effort / ultracode`（`fast` 仅当前模型支持快速模式时出现，`agent` 仅配置了自定义 agent 时出现） |
| `session/set_mode` | `bypassPermissions` → `{}`（成功）；随后 MCP 工具调用**0 反向请求** |
| MCP（stdio） | 可用：假 MCP 的 `echo` 工具以 `mcp__probe__echo` 暴露并被模型真实调用（`ECHO:hello`）；不设 `bypassPermissions` 时会发 `session/request_permission`，宿主默认拒绝即失败——**这是 WeMind 默认 deny 的正常表现** |
| 强杀后恢复 | `session/load` 成功；PINEAPPLE 上下文保留 |
| 反向请求 | `bypassPermissions` 下为 0；`default` 模式下 MCP 工具调用会触发 `session/request_permission` |
| 耗时 | `session/new` ~1.2s、`session/load` ~1.0s、首帧 2–246ms、**首段正文 7.9–11.9s**；一轮 prompt 8–12s |
| 图片 | 能力声明为 true；本机用网关时 1×1 PNG 被上游以 `400 WorkBuddy: … replace the image` 拒绝——**不是适配器/WeMind 的问题**，换正常模型/网关再验 |
| `session/delete` | 能力声明有；WeMind 仍按「只删登记项、不动 agent 侧存档」设计（与其它 agent 保持一致） |

> **能力字段不可信**：`mcpCapabilities` 没写 `stdio`，实测却能连 stdio MCP。`image` / `restore` / `mcpViaAcp` 全部来自 agent 配置字段，**不来自 `initialize` 自动解析**——升级适配器后必须重新探针（§8）。

---

## 5. 验证

### 5.1 不经过微信

```powershell
wemind brain set claude-code --restart
wemind brain            # 生效行应显示 bin=claude-agent-acp(.cmd)、args=[]、session_mode=bypassPermissions
wemind brain check      # 真机握手；结论里应带 mode=bypassPermissions
```

本机实测输出：

```text
生效：name=claude-code  bin=claude-agent-acp.cmd  args=[]  shell=true  home_env=(无)  model=(agent 默认)  session_mode=bypassPermissions
可用：✅ ...\claude-agent-acp.cmd
大脑自检（claude-code，bin=claude-agent-acp.cmd）：ACP 握手成功（initialize + session/new，sessionId=…，mode=bypassPermissions）（1987ms）
```

> `home_env=(无)` **不代表没有沙箱**——它只反映预设的 `homeEnvVar` 字段（claude-code 没设）。沙箱目录在 `env` 里：`CLAUDE_CONFIG_DIR=<BRAIN_HOME>/claude`。codex 同样是 `(无)`，而它**确实没有沙箱配置目录**（只有 cwd 指向沙箱根，见 [接入-Codex.md](接入-Codex.md) §4.5）。

### 5.2 经过微信（2026-10-31 单轮已通过）

已实测：真机微信发一条消息 → `daemon.log` 出现 `spawn claude-code acp`（`claude-agent-acp.cmd args=[]`）→ `initialized` → `session/new` → `set_mode`（`bypassPermissions`）→ `prompt ok 5381ms` → `replied`（回复真的送达）。旧进程留下的空会话（从未跑过回合）在重启后 `session/load`/`resume` 会回 `-32002 Resource not found`，daemon 按预期回退 `session/new`，不影响答复。

仍待真机复测：

1. 杀 daemon 再起，追问上一轮 → 上下文还在（`session/load`）；
2. `加载 <MCP 名>` → 下条消息生效；`wechat` 仍被拒；
3. 派一条任务（`任务 claude-code：…`）→ 跑通、结果送达；
4. 长任务 >30s → 不因首帧误杀；进度不刷屏。

---

## 6. 常见问题与限制

| 现象 | 原因 / 处理 |
|---|---|
| `找不到大脑「claude-code」的适配器「claude-agent-acp」` | 没全局安装。`npm i -g @agentclientprotocol/claude-agent-acp`；装完仍找不到就 `wemind brain set claude-code --bin "<绝对路径>"` |
| `Claude native binary not found for win32-x64` | 适配器的 optional 依赖没装上（常见于 `--omit=optional` / 网络中断）。重装时不要 omit optional；或设 `CLAUDE_CODE_EXECUTABLE` 指向本机 `claude` |
| `session/new` 报认证失败 | 没登录且 daemon 环境没有 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`；先 `claude` 登录，或把变量放到 daemon 环境 |
| `bypassPermissions` 没生效（日志「跳过」） | 以 root 运行且没设 `IS_SANDBOX=1`，适配器不提供该模式；WeMind 会跳过 `set_mode`，权限请求回到应答器（默认拒绝） |
| 工具调用被拒 | `WEMIND_ACP_SESSION_MODE=0` 关掉了 `set_mode`，或模式不可用；恢复默认或设 `WEMIND_ACP_AUTO_ALLOW=1`（逐次放行，不是放宽沙箱） |
| 连接慢 / 第一次回复慢 | 首次要起 SDK 与原生 Claude Code；实测首段正文 8–12s。npx 会更慢 |
| `claude-agent-acp` 升级后行为变了 | 适配器 pre-1.0，能力/字段可能漂移；按 §8 重跑探针并更新 `brain-agents.ts` 注释与本文 |

### 6.1 限制

已确认的限制（均来自上文实测与预设配置）：

- **必须全局安装，且 Node ≥22**：适配器是 daemon spawn 出来的子进程，继承 daemon 的 PATH 与 Node；`agentProblem()` 只查 PATH 上有没有 bin、**不查版本**，所以 Node 20 的 daemon 能通过 `wemind brain` 预检、却会在 spawn/握手时失败（§2.1）。
- **`settings.json` / `plugins/` 不进沙箱**：你在 Claude Code 里设的 `hooks` / `permissions` 不会带到微信大脑，权限统一由 `sessionMode` 负责（§2.2、§3）。
- **模型不由 WeMind 下发**：预设没有 `model` 字段，跟随 Claude Code 自身配置与 daemon 环境；要固定需 `wemind brain set claude-code --model "…"` 并应用（§2.2）。
- **`bypassPermissions` 是全量放行**：消息一旦被 daemon 接受，AI 就能在运行 daemon 的机器上执行工具（含 shell / 写文件）；唯一能收紧的开关是 `WEMIND_ACP_SESSION_MODE=0`（§7）。
- **首轮回复慢**：首次要起 SDK 与原生 Claude Code，实测首段正文 7.9–11.9s、一轮 prompt 8–12s（§4）。
- **适配器是 pre-1.0**：能力/字段可能漂移，升级后必须按 §8 重新探针并同步预设注释与本文。

---

## 7. 安全

- `bypassPermissions` = 接受所有权限：**消息一旦被 daemon 接受，AI 就能在运行 daemon 的机器上执行工具（含 shell / 写文件）**。这是「微信远程干活」的前提；唯一的闸是微信侧「只有登录者能发」+ `allowFrom` 兜底。
- 想收紧：`WEMIND_ACP_SESSION_MODE=0`（关掉 `set_mode`，回到 Claude Code 自己的审批流程；宿主应答器默认拒绝权限请求）。**这是唯一能收紧的开关**。
- `WEMIND_ACP_AUTO_ALLOW=1` **不是收紧手段，是放宽**：它让宿主对每一次 `session/request_permission` 自动选 `allow_once`/`allow_always`（`acp-reverse.ts`），效果接近 `bypassPermissions`。只在「工具调用一直被拒、确实要放宽」时用。
- 沙箱里**没有** `settings.json` / `plugins/`；`wechat` MCP 永远不进大脑沙箱（防回环）。

---

## 8. 升级适配器后重新探针

```powershell
# 1) 临时 home，避免污染真实 ~/.claude
$env:CLAUDE_CONFIG_DIR = "$env:TEMP\claude-acp-probe"
$env:ACP_BIN = "claude-agent-acp"
$env:ACP_ARGS = "[]"
$env:ACP_SHELL = "1"
$env:ACP_HOME_ENV = "CLAUDE_CONFIG_DIR"
$env:ACP_HOME = "$env:TEMP\claude-acp-probe"
$env:ACP_PROMPT = "Remember the secret word: PINEAPPLE. Reply with exactly: STORED"
$env:ACP_SECOND = "What was the secret word? Reply with just the word."
$env:ACP_HARD_KILL = "1"
node scripts/acp-probe.mjs
```

重点看：

- `initialize` 的 `loadSession` / `promptCapabilities.image` / `mcpCapabilities`；
- `session/new` 的 `modes.availableModes` 是否还有 `bypassPermissions`；
- `prompt1` 是否成功、首段正文耗时；
- 强杀后 `session/load` 是否还能答出 `PINEAPPLE`；
- 有 MCP 需求时用 `ACP_TEST_MCP='[{"name":"probe","command":"node","args":["<最小 MCP server>"],"env":[]}]'` 验证 stdio。

结论有变化时，同一次提交更新 `brain-agents.ts` 的预设注释、`docs/接入方案/接入其它-ACP-Agent.md` §5 与本文。

---

## 9. 参考

- 适配器：[`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp)（旧包 `@zed-industries/claude-code-acp` 已弃用）
- 通用 ACP 指南：[`docs/接入方案/接入其它-ACP-Agent.md`](接入其它-ACP-Agent.md)
- 探针：[`scripts/acp-probe.mjs`](../../scripts/acp-probe.mjs)
- 配方：[`docs/ai/recipes/add-acp-agent.md`](../ai/recipes/add-acp-agent.md)

---

## 10. 待实测

以下为正文与状态行已列出、尚未真机复测的项：

1. **重启续聊**：杀 daemon 再起，追问上一轮 → 上下文还在（`session/load`）（§5.2）。
2. **MCP 加载**：`加载 <MCP 名>` → 下条消息生效；`wechat` 仍被拒（§5.2）。
3. **任务派发**：派一条任务（`任务 claude-code：…`）→ 跑通、结果送达（§5.2）。
4. **长任务**：>30s 不因首帧误杀；进度不刷屏（§5.2）。
5. **图片**：能力声明 `image: true`，本机用网关时 1×1 PNG 被上游以 `400 WorkBuddy: … replace the image` 拒绝，需换正常模型/网关再验（§4）。
