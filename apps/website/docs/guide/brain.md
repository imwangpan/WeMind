---
description: 选择、切换和检查 WeMind 的对话大脑与任务大脑。
---

# 切换大脑

“大脑”就是当前接微信的 Agent。你可以随时换一个，微信入口不变。

## 看当前是谁

```bash
wemind brain
wemind agent list
```

微信里：

```text
AI
AI 列表
```

会列出可选 Agent、当前对话大脑、默认任务大脑。

## 内置 Agent

WeMind 内置 10 个预设：

| Agent | 接入方式 | 参与自动探测 |
| --- | --- | --- |
| OpenCode | 原生 ACP | 是 |
| Cline | 原生 ACP | 是 |
| Qoder | 原生 ACP | 是 |
| Gemini | 原生 ACP | 是 |
| DeepSeek Harness | 原生 ACP | 是 |
| Kiro | 原生 ACP | 是 |
| Copilot | 原生 ACP | 否，需显式选用 |
| Claude Code | 适配器 | 否，需显式选用 |
| Codex | 适配器 | 否，需显式选用 |
| Pi | 适配器 | 否，需显式选用 |

“内置”只代表 WeMind 认识它，不代表你机器上一定装了、登录了。能不能用，以 `wemind brain check` 为准。

## 换大脑

写入磁盘，重启后仍生效：

```bash
wemind brain set codex
```

让正在跑的 daemon 立即换：

```bash
wemind brain switch codex
```

- `switch` 不重启 daemon，不打断在途回合。
- 失败会自动退回原来那个。
- 正在切换时又发一次，会返回失败，不会叠两次切换。

微信里（仅登录者）：

```text
切换大脑 codex
/brain codex
```

## 只追加参数

```bash
wemind brain set opencode --extra-args "--log-level debug"
```

`--extra-args` 只追加，保留预设的 ACP 模式参数；`--args` 是整段替换，漏掉 ACP 参数会握手超时。

## 检查能不能用

```bash
wemind brain check
wemind agent check codex
```

`brain check` 会：

1. 找到 Agent 的可执行入口；
2. 真起一次 ACP 握手；
3. 看它是否覆盖 WeMind 需要的最小方法集；
4. 结束后杀掉进程，不留后台。

`agent check --schema` 只做数据校验，不启动进程；`--deep` 还会发真实 prompt。

## 任务大脑

对话大脑和任务大脑可以分开：

```bash
wemind brain set codex                  # 对话大脑
wemind brain set opencode --worker      # 任务大脑
```

微信里：

```text
切换任务大脑 opencode
/task opencode
```

任务大脑的切换只在本次运行内生效，不写 `brain.json`；重启回到配置值。

## direct 与 managed

| 模式 | 行为 |
| --- | --- |
| `direct`（默认） | 完全按 Agent 的真实配置运行；WeMind 只读，不自动写 |
| `managed` | WeMind 维护 `brain-home` / `worker-home`，按账号隔离 MCP 和配置 |

```bash
wemind config home-mode
wemind config home-mode managed
```

只有 `managed` 才由 WeMind 托管 MCP 激活集；`direct` 下要改 MCP，请改 Agent 自己的配置。

## 交接

换大脑前，可以先生成一份交接摘要：

```bash
wemind brain handoff
```

微信里：

```text
交接
/handoff
```

摘要包含目标、已确认结论、未决问题、关键事实；切到新大脑后，第一条消息会自动带上，答完即用掉。

## 排查

- **切换失败**：看 `wemind log --errors`。常见原因是 Agent 没装、没登录、缺 ACP 模式参数。
- **切完没反应**：确认 `wemind list` 里 daemon 在跑；`switch` 只对运行中的 daemon 生效。
- **`brain check` 卡住**：先 `wemind agent check <agent> --schema` 排除定义问题，再看是不是 Agent 自身要交互登录。
