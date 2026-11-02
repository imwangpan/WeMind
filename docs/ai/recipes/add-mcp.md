# 配方：新增 / 调试 MCP 挂载

> **适用版本**：WeMind 1.3.0 ｜ **最后核对**：2026-11-02
>
> 目标：让 brain 能在微信里通过「加载/卸载 MCP」动态获得工具，同时不破坏隔离、不引入 `wechat` 回环。

---

## 0. 先理解三条链路

```text
catalog（定义从哪来）
  └─ 按 agent 各自约定读取（不要跨 agent 借文件）：
       kiro     ~/.kiro/settings/mcp.json                 { "mcpServers": { ... } }
       opencode ~/.config/opencode/opencode.json          { "mcp": { "servers": { ... } } }
       qoder    ~/.qoder/settings.json                    { "mcpServers": { ... } }
       cline    ~/.cline/data/settings/cline_mcp_settings.json / CLINE_MCP_SETTINGS_PATH
       gemini   <沙箱>/.gemini/settings.json              { "mcpServers": { ... } }（JSONC）
       pi       <沙箱根>/mcp.json                         { "mcpServers": { ... } }
       DSH、claude-code  ACP session/new 的 mcpServers   （无文件式 catalog 时用 WEMIND_MCP_CATALOG）
       codex    ❌ 适配器 mcpCapabilities.acp=false，stdio MCP 不可用
  └─ 可用 WEMIND_MCP_CATALOG / WECHAT_MCP_CATALOG 覆盖

激活集（哪些允许给 brain）
  └─ <数据目录>/brain-mcps.json  { "active": ["name", ...] }
  └─ 微信指令「加载 <名>」/「卸载 <名>」修改；wechat 永久禁止

transport（怎么让 agent 看到）
  └─ brain：applySandbox() 写沙箱配置文件（文件式 MCP 的 agent），或 mcpViaAcp 传 session/new|resume（DSH / claude-code，已实现）
  └─ worker：applyWorkerSandbox() 继承全量（排除 wechat + WEMIND_WORKER_MCP_EXCLUDE）
```

关键代码：

| 文件 | 作用 |
|---|---|
| `packages/wechat-daemon/src/mcp-sandbox.ts` | brain 沙箱、catalog、激活集、`加载/卸载` |
| `packages/wechat-daemon/src/worker-sandbox.ts` | worker 全量继承、排除集 |
| `packages/wechat-daemon/src/agent-mcp.ts` | 文件式 MCP 格式（kiro / opencode / HTTP）的读/写/转换 |
| `packages/wechat-daemon/src/index.ts` | 指令拦截；加载/卸载后 `restart()` |
| `packages/wechat-daemon/src/acp-brain.ts` | 重启 ACP，重建后恢复 session |

---

## 1. 加一个 MCP（用户视角）

### kiro

```jsonc
// ~/.kiro/settings/mcp.json
{
  "mcpServers": {
    "my-tool": {
      "command": "node",
      "args": ["D:/tools/my-tool/server.js"],
      "env": { "TOKEN": "..." }
    }
  }
}
```

### opencode

```jsonc
// ~/.config/opencode/opencode.json
{
  "mcp": {
    "servers": {
      "my-tool": {
        "type": "local",
        "command": ["node", "D:/tools/my-tool/server.js"],
        "environment": { "TOKEN": "..." }
      }
    }
  }
}
```

### DSH

> **状态：已实现并实测（2026-10-29 复核）。** `deepseek` 配置里的 `mcpViaAcp: true`——不写 MCP 配置文件，激活集经 `toAcpMcpServers()` 转成 ACP 声明随 `session/new|resume` 下发；worker 同理继承全量（除排除集）。`addMcp` 会预校验定义（无 command/url 拒绝加载；结构不认识/残缺的条目跳过并记日志，不拖挂整个会话）。**stdio 已真机实测可用；HTTP 由 agent 声明可用（`mcpCapabilities.http:true`）但未单独真机实测；SSE 不被 ACP 支持**（`toAcpMcpServers` 只输出 stdio / `type:"http"`）。claude-code 同样走 `mcpViaAcp`；codex 的适配器声明 `mcpCapabilities.acp=false`，保持 `mcpViaAcp: false`。

DSH 的 ACP 走 `session/new` 的 `mcpServers`，没有 kiro 式文件。用中立 catalog：

```powershell
$env:WEMIND_MCP_CATALOG = "D:\wemind-data\mcp-catalog.json"
```

文件仍是 kiro 格式（`mcpServers`），由 WeMind 转成 ACP：

```jsonc
{
  "mcpServers": {
    "my-tool": { "command": "node", "args": ["D:/tools/my-tool/server.js"] }
  }
}
```

> 不要要求 DSH 去读 `~/.kiro/settings/mcp.json`。每个 agent 只读自己的配置；DSH 的 transport 是 ACP，不是文件。

---

## 2. 验证

```powershell
npm run build
wemind brain set <agent 名> --restart
wemind brain check
```

微信里：

```text
MCP                 # 列出可选与已激活
加载 my-tool        # 加入激活集
<发一条需要该工具的消息>
卸载 my-tool
```

看 `~/.wemind/<账号>/daemon.log`：

- `applySandbox` 后应出现 ACP 重启：`acp exited` → `spawn ...` → `initialized` → `session/load|resume`；
- 如果 MCP 启动失败，kiro/opencode 通常在下一次 ACP 启动时报错；DSH 的 `session/new` 会回滚整个会话。

---

## 3. 排错

| 现象 | 检查 |
|---|---|
| `MCP` 列表为空 | `catalog` 路径是否存在；`WEMIND_MCP_CATALOG` 是否指对；格式是否是该 agent 的格式 |
| 加载后工具不出现 | 是否 `restart()`；会话是否 `load/resume` 成功；agent 是否需要「新会话」 |
| 加载 `wechat` 被拒 | 预期行为（防它把消息发回自己）；不要绕过 |
| worker 没有工具 | worker 是「全量继承除排除集」，看 `WEMIND_WORKER_MCP_EXCLUDE`；`disabled:true` 会被跳过 |
| DSH 报 `-32602`/会话创建失败 | MCP 定义不合法或起不来；官方 `session/new` 会回滚整会话，先删坏条目 |
| Windows 起不来 | `.cmd`/`npx` 要 `shell:true`；命令/参数要按 `spawnAgent` 规则引号 |

---

## 4. 安全

- brain 默认免审批（内置预设各用自己 agent 的机制，见 `brain-agents.ts` 与 `docs/接入其它-ACP-Agent.md` §5）；**加载一个 MCP = 对登录者（唯一能发消息的人）开放该工具的全部能力**。
- `allowFrom` 是**兜底**发件人闸门（默认拒绝，正常只含登录者一个 userId），不要为了省事关掉；平台本身只投递登录者的消息，这个白名单防的是发送范围变化/别的入口。
- worker 继承全量 MCP，风险更高；不要把 worker 的 cwd 指到敏感目录。
- `wechat` 永久禁止：同一 token 长轮询会与 daemon 抢消息/回环。
- MCP 定义里不要写明文密钥到仓库；用环境变量或本机配置。

---

## 5. DSH 的 `mcpViaAcp`（已实现，2026-11-02 核对）

- `mcpViaAcp`：把激活集转成 ACP `mcpServers`，在 `session/new` / `session/resume` 传入（`deepseek`、`claude-code` 预设为 `true`）；
- `toAcpMcpServers()`：kiro/opencode 格式 → `{ name, command, args, env }` / `{ name, type:"http", url, headers }`；
- 官方不支持 SSE；HTTP 已广告（未单独真机实测）；stdio 已真机实测；
- 坏条目预校验：无 command/url 的条目拒绝加载，结构残缺的条目跳过并记日志——官方 `session/new` 失败会回滚整个会话，所以不能让一条坏定义拖挂全部；
- 能力字段不自动适配：`initialize` 回包目前不被解析，`mcpViaAcp` 是**人工写进预设**的结论；接新 agent 时用探针实测 stdio/HTTP，别照抄声明。

---

## 6. 参考

- [`docs/repowiki/06-ACP-大脑与沙箱.md`](../../repowiki/06-ACP-大脑与沙箱.md) §6.3
- [`docs/接入-OpenCode.md`](../../接入-OpenCode.md) §3.4 Step 3
- [`docs/接入-DeepSeek.md`](../../接入-DeepSeek.md) §5.3 M3
