---
description: 用本机 JSON 定义一个 WeMind 还没内置的 ACP Agent。
---

# 自定义 Agent

内置 10 个预设不够用时，可以先加一个**本机定义**，不用改 WeMind 源码，也不用等发版。

## 先判断能不能接

你的 Agent 必须：

1. 有可执行入口（PATH 上的命令或绝对路径）；
2. 能进入 **ACP over stdio** 模式；
3. 至少支持 `initialize`、`session/new`、流式 `session/prompt`；
4. 自己完成登录/模型配置，daemon 启动时不需要人工点。

只有 HTTP API、没有 CLI 的模型（OpenAI/Anthropic/Ollama 裸 API）目前接不了。

## 最小定义

在 `~/.wemind/.agents/my-agent.json` 写：

```json
{
  "schemaVersion": 1,
  "name": "my-agent",
  "bin": "my-agent",
  "args": ["acp"],
  "shell": false,
  "acpMcpServers": false,
  "mcpDelivery": "config",
  "notes": ["本机自定义 Agent"]
}
```

字段含义：

| 字段 | 作用 |
| --- | --- |
| `schemaVersion` | 目前是 `1` |
| `name` | 命令里用的名字，必须和文件名一致 |
| `bin` / `binWin` | 可执行文件；Windows 的 `.cmd` 用 `binWin` |
| `args` | 进入 ACP 模式的参数 |
| `shell` | Windows `.cmd`/`.bat` 通常要 `true`；原生可执行文件用 `false` |
| `envDefaults` | 启动时注入的环境变量 |
| `realHome` / `homeEnvVar` | Agent 真实配置目录；`managed` 才把 `homeEnvVar` 指向副本 |
| `catalogFile` | MCP 配置文件名，供只读解析 |
| `acpMcpServers` | 是否接受 ACP `session/new` 里的 `mcpServers` |
| `mcpDelivery` | `acp` 或 `config`；决定 MCP 怎么投递 |
| `adapter` | 需要桥接时指向 adapter 模块 |
| `notes` | 给人看的说明，不参与运行 |

完整字段用：

```bash
wemind agent spec
```

## 校验

```bash
wemind agent check ~/.wemind/.agents/my-agent.json --schema
wemind agent check ~/.wemind/.agents/my-agent.json
```

- `--schema` 只校验 JSON 结构和未知字段。
- 不带 `--schema` 会真起一次 ACP 握手；失败会杀进程并清理管道。
- 想再发真实 prompt，加 `--deep`。

## 安装与替换

```bash
wemind agent add ./my-agent.json
wemind agent list
wemind agent remove my-agent
```

- 同名本机定义会**整条替换**内置定义。
- 坏定义会按文件名遮住同名内置，不会静默回退。
- `agent add` 会把定义包复制到 `~/.wemind/.agents/`；如果带相对 adapter，也一起复制，并在 `.sources.json` 记来源。
- `agent remove` 只移除本机定义，不影响内置。

## 需要适配器时

如果 Agent 有 CLI 但不直接说 ACP，需要写一个 adapter。定义里写：

```json
{
  "adapter": {
    "module": "my-adapter",
    "apiVersion": 1
  }
}
```

模块默认导出：

```js
export default {
  apiVersion: 1,
  // 只补文件格式 / spawn 前准备
}
```

限制：

- CJS 同步加载；ESM 由 CLI/daemon 启动时预加载。
- 未知顶层/嵌套键、`apiVersion` 不符、`mcp` 缺方法都会 fail-closed。
- 插件**不能**替换会话恢复、回合帧、静默等待、权限应答或任何反向请求；这些是 WeMind 的核心协议层。

## 常见失败

**`agent check` 超时**：`args` 没让 Agent 进 ACP 模式，或 `bin` 不对。先手动跑 `my-agent acp`，确认它输出 JSON-RPC 帧。

**能握手但微信不回**：看 `wemind log --errors`；可能是没有 activity 帧、反向请求没人应答，或模型没配置。

**Windows 报 ENOENT**：`.cmd` 要设 `binWin` 和 `shell: true`；不要依赖当前目录解析裸命令名。
