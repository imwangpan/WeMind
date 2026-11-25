---
description: WeMind 能接哪些 AI Agent、接入条件，以及怎么检查。
---

# Agent 总览

WeMind 不自己实现 AI，它把微信接给你本机已有的 Agent。能不能接，不看“名气”，看四件事。

## 四个条件

1. **有可执行入口**：能在本机启动，最好有非交互模式。
2. **说 ACP，或有适配器**：原生 ACP，或 WeMind 自带的 adapter。
3. **覆盖最小方法集**：至少能初始化、新建/恢复会话、发消息、收流式事件。
4. **能完成认证**：不需要人在终端里一直点登录。

> “支持 ACP”不等于能用。`session/load`、图片输入、MCP 传输、反向请求都是可降级项，各家差别很大。

## 内置 10 个预设

| Agent | 接入 | 自动探测 | 备注 |
| --- | --- | --- | --- |
| OpenCode | 原生 ACP | 是 | 长期真机使用 |
| Cline | 原生 ACP | 是 | 长期真机使用 |
| Qoder | 原生 ACP | 是 | 长期真机使用 |
| Gemini | 原生 ACP | 是 | 真机 E2E |
| DeepSeek Harness | 原生 ACP | 是 | 长期真机使用 |
| Kiro | 原生 ACP | 是 | 长期真机使用 |
| Copilot | 原生 ACP | 否 | 安装不代表已登录，需显式选 |
| Claude Code | 适配器 | 否 | 需显式选 |
| Codex | 适配器 | 否 | 需显式选 |
| Pi | 适配器 | 否 | 需显式选 |

自动探测只在首次没有指定大脑时用，顺序是 OpenCode → Cline → Qoder → Gemini → DeepSeek → Kiro。装没装、登没登录，仍以 `wemind brain check` 为准。

## 检查

```bash
wemind agent list
wemind agent show codex --explain
wemind agent check codex
wemind brain check
```

- `agent check` 默认做真实 ACP 握手；`--schema` 只校验定义数据；`--deep` 再发一条真实 prompt。
- `brain check` 用当前大脑做同样的握手，结束后会杀进程、清理管道。
- 失败时先看 `wemind log --errors`，再看 Agent 自己的登录状态。

## direct 与 managed

| 模式 | Agent 配置 | MCP |
| --- | --- | --- |
| `direct`（默认） | 完全用 Agent 真实配置；WeMind 只读 | 用 Agent 原生配置；WeMind 不重发 catalog |
| `managed` | WeMind 维护 `brain-home` / `worker-home`，按账号隔离 | WeMind 维护激活集，永久排除 `wechat` |

切换：

```bash
wemind config home-mode
wemind config home-mode managed
```

第一次用建议 `direct`：你平时怎么用这个 Agent，微信里就怎么用。等需要隔离/托管 MCP 时再切 `managed`。

## 加自己的 Agent

内置不够用时，可以写一个本机定义，不必改 WeMind 源码：

- [自定义 Agent](./custom.md)
- `wemind agent add <包|文件>`
- `wemind agent check <名字|文件>`

## 常见失败

**`brain check` 超时**：Agent 没进 ACP 模式，或启动参数被 `--args` 整段替换漏了。用 `--extra-args` 只追加。

**Agent 能跑但微信没回复**：看 daemon 是否在跑、是否同时开了 MCP 形态、是否被白名单拦住。

**Copilot 装了但不能用**：它不参与自动探测，必须显式 `wemind brain set copilot`，并确认已登录。

**图片发过去报错**：该 Agent 可能不支持 image block；这属于可降级项，不代表整个 Agent 不能用。
