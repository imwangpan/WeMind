# 接入 Claude Code（ACP 适配器）

> **适用版本**：WeMind 1.2.0 ｜ **最后核对**：2026-10-31 ｜ **状态**：✅ 已内置预设、**探针级实测**（ACP 握手 / 一轮 prompt / 强杀后 `session/load` / stdio MCP / `bypassPermissions`）；**真机微信 E2E 未做**。
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

内置预设**不再**用 `npx -y @agentclientprotocol/claude-agent-acp`。口径与 `codex` 一致：

| | 全局安装（推荐） | `npx -y <包>` |
|---|---|---|
| 启动 | PATH 上的 `claude-agent-acp`，直接起 | 每次启动先问 registry；包/二进制不在缓存时要现下 |
| 离线 | ✅ 装好后不依赖网络 | ❌ 冷缓存时不可用 |
| 版本 | 由 `npm i -g` 固定，可复现 | 默认取 latest，静默漂移 |
| daemon 场景 | 常驻只起一次；worker 每条任务起进程也快 | 每条任务都可能撞上解析/下载/锁 |
| 出问题时 | `npm ls -g` / `where claude-agent-acp` 一眼可见 | 藏在 npm `_npx` 缓存里，难排查 |

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

- **Node ≥22**（适配器 `engines` 要求；仓库本身的 Node 下限仍是 20）。
- 适配器依赖 `@anthropic-ai/claude-agent-sdk`，后者带一个平台原生 Claude Code 二进制（Windows：`@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`）。**不要用 `--omit=optional` 安装**，否则会报 `Claude native binary not found`。
- 已经装了独立 Claude Code 的话，可以让适配器直接用它：

  ```powershell
  $env:CLAUDE_CODE_EXECUTABLE = "C:\Users\<你>\...\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
  ```

  这是适配器**自己的**环境变量（`claudeCliPath()` 优先读它），不是 WeMind 发明的。

### 2.2 认证

适配器把认证交给 Claude Code，支持：

- `claude` 登录（OAuth）：登录态在 `~/.claude/.credentials.json`（macOS 可能在 Keychain）；WeMind 会把 `.credentials.json` 同步进沙箱。
- 环境变量：`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`；自定义网关再加 `ANTHROPIC_BASE_URL`。这些变量要对 **daemon 进程**生效（§4.9：密钥不写进 agent 配置）。

**WeMind 不复制 `settings.json`**：这份文件经常把网关 token 放在 `env` 里；按仓库纪律，凭据由 daemon 环境提供，不写进 agent 配置。因此你在 Claude Code 里设的 `hooks` / `permissions` 也不会带进微信大脑——WeMind 用 `sessionMode`（见 §3）负责权限，用模型配置负责模型。

---

## 3. 预设做了什么（`brain-agents.ts`）

```ts
"claude-code": {
  bin: "claude-agent-acp",
  binWin: "claude-agent-acp.cmd",   // npm 全局在 Windows 产出 .cmd shim
  args: [],
  shell: true,
  env: { CLAUDE_CONFIG_DIR: "%HOME%/claude" },
  configSubdir: "claude",
  realHome: "~/.claude",
  inheritDirs: ["skills", "agents", "commands"],
  inheritFiles: ["CLAUDE.md"],
  catalogFile: "../.claude.json",    // 真实 ~/.claude.json 与 realHome 同级（realHome + ".."）
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

用 [`scripts/acp-probe.mjs`](../scripts/acp-probe.mjs)（另起一个临时 `CLAUDE_CONFIG_DIR`，不碰真实配置）：

| 项目 | 结果 |
|---|---|
| `initialize` 能力 | `loadSession: true`；`sessionCapabilities.resume / close / delete / fork / list`；`promptCapabilities.image: true`、`embeddedContext: true`；`mcpCapabilities: { http: true, sse: true }`（**没有声明 stdio，但实测 stdio 可用**） |
| `session/new` | 成功；`modes` = `default / acceptEdits / plan / auto / bypassPermissions`；`configOptions` = `mode / model / effort / ultracode` |
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

### 5.2 经过微信（尚未完成，待真机）

1. 发一条消息 → `daemon.log` 出现 `spawn claude-code acp` → `initialized` → `session/new`（或 `session/load`）→ `prompt ok`；
2. 杀 daemon 再起，追问上一轮 → 上下文还在（`session/load`）；
3. `加载 <MCP 名>` → 下条消息生效；`wechat` 仍被拒；
4. 派一条任务（`任务 claude-code：…`）→ 跑通、结果送达；
5. 长任务 >30s → 不因首帧误杀；进度不刷屏。

---

## 6. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `找不到大脑「claude-code」的适配器「claude-agent-acp」` | 没全局安装。`npm i -g @agentclientprotocol/claude-agent-acp`；装完仍找不到就 `wemind brain set claude-code --bin "<绝对路径>"` |
| `Claude native binary not found for win32-x64` | 适配器的 optional 依赖没装上（常见于 `--omit=optional` / 网络中断）。重装时不要 omit optional；或设 `CLAUDE_CODE_EXECUTABLE` 指向本机 `claude` |
| `session/new` 报认证失败 | 没登录且 daemon 环境没有 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`；先 `claude` 登录，或把变量放到 daemon 环境 |
| `bypassPermissions` 没生效（日志「跳过」） | 以 root 运行且没设 `IS_SANDBOX=1`，适配器不提供该模式；WeMind 会跳过 `set_mode`，权限请求回到应答器（默认拒绝） |
| 工具调用被拒 | `WEMIND_ACP_SESSION_MODE=0` 关掉了 `set_mode`，或模式不可用；恢复默认或设 `WEMIND_ACP_AUTO_ALLOW=1`（逐次放行，不是放宽沙箱） |
| 连接慢 / 第一次回复慢 | 首次要起 SDK 与原生 Claude Code；实测首段正文 8–12s。npx 会更慢 |
| `claude-agent-acp` 升级后行为变了 | 适配器 pre-1.0，能力/字段可能漂移；按 §8 重跑探针并更新 `brain-agents.ts` 注释与本文 |

---

## 7. 安全

- `bypassPermissions` = 接受所有权限：**消息一旦被 daemon 接受，AI 就能在运行 daemon 的机器上执行工具（含 shell / 写文件）**。这是「微信远程干活」的前提；唯一的闸是微信侧「只有登录者能发」+ `allowFrom` 兜底。
- 想收紧：`WEMIND_ACP_SESSION_MODE=0`（关掉 `set_mode`，回到 Claude Code 自己的审批流程；宿主默认拒绝权限请求）或 `WEMIND_ACP_AUTO_ALLOW=1`（逐次放行一次性权限）。
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

结论有变化时，同一次提交更新 `brain-agents.ts` 的预设注释、`docs/接入其它-ACP-Agent.md` §5 与本文。

---

## 9. 参考

- 适配器：[`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp)（旧包 `@zed-industries/claude-code-acp` 已弃用）
- 通用 ACP 指南：[`docs/接入其它-ACP-Agent.md`](接入其它-ACP-Agent.md)
- 探针：[`scripts/acp-probe.mjs`](../scripts/acp-probe.mjs)
- 配方：[`docs/ai/recipes/add-acp-agent.md`](ai/recipes/add-acp-agent.md)
