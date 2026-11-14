# 配方：新增 / 调试 MCP 挂载

> **最后核对**：2026-11-14
>
> 目标：让 brain 能在微信里通过「加载/卸载 MCP」动态获得工具，同时不破坏隔离、不引入 `wechat` 回环。

---

## 0. 先理解三条链路

```text
catalog（定义从哪来；一律读 Agent 的**真实**配置目录，不读 managed 副本）
  └─ 按 agent 各自约定读取（不要跨 agent 借文件）：
       kiro     ~/.kiro/settings/mcp.json                 { "mcpServers": { ... } }
       opencode ~/.config/opencode/opencode.json          { "mcp": { "servers": { ... } } }
       qoder    ~/.qoder/settings.json                    { "mcpServers": { ... } }
       cline    ~/.cline/data/settings/cline_mcp_settings.json   { "mcpServers": { ... } }
       gemini   ~/.gemini/settings.json                   { "mcpServers": { ... } }（JSONC）
       pi       ~/.pi/agent/mcp.json                      { "mcpServers": { ... } }
       DSH               ~/.dsh/profiles/acp/cordis.patch.yml 的 @deepseek-ai/dsh-mcp-client 条目（只读）
       claude-code       ~/.claude.json 的 mcpServers     （catalogFile 写成 `../.claude.json`，回到 realHome 上一层）
       copilot           ~/.copilot/mcp-config.json        （Agent 原生读取）
       codex             ~/.codex/config.toml（原生，只读）
  └─ 可用 WEMIND_MCP_CATALOG / WECHAT_MCP_CATALOG 覆盖

激活集（哪些允许给 brain）
  └─ <数据目录>/brain-mcps.json  { "version": 2, "active": { "<agent>": ["name", ...] } }（仅 managed）
  └─ 微信指令「加载 <名>」/「卸载 <名>」修改；按 agent 分键，wechat 永久禁止

transport（怎么让 agent 看到）
  └─ brain：`managed` 下文件式 Agent 由 applyBrainCopy() 写副本配置；mcpDelivery=acp 的 Agent（DSH / claude-code / copilot / codex）走 session/new|resume，传激活集
  └─ `direct`：所有 MCP 都由 Agent 自己读真实配置；WeMind 不重发 catalog，只补 overlay.mcp.extra；`加载/卸载` 原样转给 Agent
  └─ worker：`managed` 下 applyWorkerCopy() 继承全量（排除 wechat + WEMIND_WORKER_MCP_EXCLUDE）；`direct` 由 Agent 自己加载

微信独享增删（不改真实配置）
  └─ <账号>/agent-overrides/<agent>.json 的 mcp.extra / mcp.disable
  └─ `managed` 全量生效；`direct` 只有 acpMcpServers 的 Agent 能收到 extra（其余仍由 Agent 自己的配置决定）
  └─ `managed` 的 curated 集里 mcp.disable 最后生效；wechat 永远进不了 curated 集
```

> 注意「catalog 读真实、transport 写副本」：`managed` 下 `加载 <名>` 只把定义**写进 WeMind 生成的副本配置**（brain 默认空、worker 全量），真实配置文件一律不动；`direct` 下不生成任何副本，`加载/卸载` 原样转给 Agent。

关键代码：

| 文件                                                          | 作用                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/wechat-daemon/src/agents/config/overlay.ts`         | 微信独享 `mcp.extra` / `mcp.disable`                                          |
| `packages/wechat-daemon/src/agents/managed/mcp-brain.ts`    | brain 副本、catalog、激活集、`加载/卸载`                                      |
| `packages/wechat-daemon/src/agents/managed/mcp-worker.ts` | worker 全量继承、排除集                                                       |
| `packages/wechat-daemon/src/agents/managed/mcp-adapters.ts`   | 按文件格式的 MCP 适配器：路径、读写、剥离、ACP 转换、原生只读（Codex TOML）   |
| `packages/wechat-daemon/src/agents/managed/agent-mcp.ts`      | MCP 格式纯函数（顶层 `mcpServers` / 嵌套 `mcp.servers` / HTTP）与 wechat 判定 |
| `packages/wechat-daemon/src/cli/subcommands/cli-config.ts`    | `wemind mcp list/enable/disable/add/remove` 的 CLI 入口（`config mcp` 只是兼容别名） |
| `packages/wechat-daemon/src/index.ts`                         | 指令拦截；加载/卸载后 `restart()`                                             |
| `packages/wechat-daemon/src/acp/acp-brain.ts`                 | 重启 ACP，重建后恢复 session                                                  |

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
      "env": { "TOKEN": "..." },
    },
  },
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
        "environment": { "TOKEN": "..." },
      },
    },
  },
}
```

### DSH

> **状态：已实现并实测（2026-10-29 复核，2026-11-13 校正）。** DSH 自己读 profile YAML 里的 `@deepseek-ai/dsh-mcp-client` 条目；WeMind 只读解析用于列出/指标/微信检测。`managed` 下副本里的 MCP 条目全部剥离，再按 brain 激活集 / worker 全量集经 `session/new|resume` 下发（`acpMcpServers: true` + `mcpDelivery: "acp"`）。`addMcp` 会预校验定义（无 command/url 拒绝加载；结构不认识/残缺的条目跳过并记日志，不拖挂整个会话）。**stdio 已真机实测可用；HTTP 由 agent 声明可用（`mcpCapabilities.http:true`）但未单独真机实测；SSE 不被 ACP 支持**（`toAcpMcpServers` 只输出 stdio / `type:"http"`）。claude-code / copilot / codex 同样走 ACP 投递；Codex 原生 `~/.codex/config.toml` 仍由 Codex 自己加载且同名优先，`direct` 不重发。

DSH 的 MCP 写在 profile 用户层；`WEMIND_MCP_CATALOG` 仍可覆盖「微信侧可选目录」的来源（JSON 格式会按 JSON 解析）：

```powershell
$env:WEMIND_MCP_CATALOG = "D:\wemind-data\mcp-catalog.json"
```

文件仍是 kiro 格式（`mcpServers`），由 WeMind 转成 ACP：

```jsonc
{
  "mcpServers": {
    "my-tool": { "command": "node", "args": ["D:/tools/my-tool/server.js"] },
  },
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

- 仅当回复里 `changed=true`（激活集真变了）时，`applyBrainCopy` 后才出现 ACP 重启：`acp exited` → `spawn ...` → `initialized` → `session/load|resume`；重复加载已激活项或卸载未激活项都不重启；
- 如果 MCP 启动失败，kiro/opencode 通常在下一次 ACP 启动时报错；DSH 的 `session/new` 会回滚整个会话。

---

## 3. 排错

| 现象                         | 检查                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `MCP` 列表为空               | `catalog` 路径是否存在；`WEMIND_MCP_CATALOG` 是否指对；格式是否是该 agent 的格式        |
| 加载后工具不出现             | 是否 `restart()`；会话是否 `load/resume` 成功；agent 是否需要「新会话」                 |
| 加载 `wechat` 被拒           | 预期行为（防它把消息发回自己）；不要绕过                                                |
| worker 没有工具              | worker 是「全量继承除排除集」，看 `WEMIND_WORKER_MCP_EXCLUDE`；`disabled:true` 会被跳过 |
| DSH 报 `-32602`/会话创建失败 | MCP 定义不合法或起不来；官方 `session/new` 会回滚整会话，先删坏条目                     |
| Windows 起不来               | `.cmd`/`npx` 要 `shell:true`；命令/参数要按 `spawnAgent` 规则引号                       |

---

## 4. 安全

- brain 默认免审批（内置预设各用自己 agent 的机制，见 `brain-presets.ts` 与 `docs/接入方案/接入其它-ACP-Agent.md` §5）；**加载一个 MCP = 对登录者（唯一能发消息的人）开放该工具的全部能力**。
- `allowFrom` 是**兜底**发件人闸门（默认拒绝，正常只含登录者一个 userId），不要为了省事关掉；平台本身只投递登录者的消息，这个白名单防的是发送范围变化/别的入口。
- worker 继承全量 MCP，风险更高；不要把 worker 的 cwd 指到敏感目录。
- `wechat` 永久禁止：同一 token 长轮询会与 daemon 抢消息/回环。
- MCP 定义里不要写明文密钥到仓库；用环境变量或本机配置。

---

## 5. DSH 的 ACP MCP 投递（已实现，2026-11-13 校正）

- `acpMcpServers` 是纯能力；`mcpDelivery: "acp"` 表示 `managed` 下由 WeMind 把激活集转成 ACP `mcpServers`，在 `session/new` / `session/resume` 传入（`deepseek`、`claude-code`、`copilot`、`codex`）；
- `direct` 不重发真实 catalog：Agent 自己加载的 MCP 不会被 WeMind 再传一遍；
- `toAcpMcpServers()`：两种 JSON 键路径 → `{ name, command, args, env }` / `{ name, type:"http", url, headers }`；
- 官方不支持 SSE；HTTP 已声明（未单独真机实测）；stdio 已真机实测；
- 坏条目预校验：无 command/url 的条目拒绝加载，结构残缺的条目跳过并记日志——官方 `session/new` 失败会回滚整个会话，所以不能让一条坏定义拖挂全部；
- 能力字段不自动适配：`initialize` 回包目前不被解析，`acpMcpServers` / `mcpDelivery` 是**人工写进预设**的结论；接新 agent 时用探针实测 stdio/HTTP，不要只按 capabilities 声明推断。

---

## 6. 参考

- [`docs/repowiki/06-ACP-大脑与副本.md`](../../repowiki/06-ACP-大脑与副本.md) §6.3
- [`docs/接入方案/接入-OpenCode.md`](../../接入方案/接入-OpenCode.md) §3.4 Step 3
- [`docs/接入方案/接入-DeepSeek.md`](../../接入方案/接入-DeepSeek.md) §5.3 M3
