---
description: WeMind 常用的数据目录、账号、运行期与 ACP 环境变量。
---

# 环境变量

WeMind 的变量分几类：数据目录、账号、运行期调参、ACP。**大多数变量只需要在排查或临时实验时设**，不要把所有变量都写进 shell profile。

## 数据目录

| 变量 | 作用 |
| --- | --- |
| `WEMIND_HOME` | 改 WeMind 根目录，默认 `~/.wemind`；跨平台官方方式 |
| `WECHAT_DATA_DIR` | 只对 `wemind daemon` 直跑有效；`wemind start` 按账号 key 寻址，会忽略它 |
| `WEMIND_AGENTS_DIR` | 改 Agent 定义目录，默认 `~/.wemind/.agents`；单机共享，不随账号删除 |

优先级从高到低：`WECHAT_DATA_DIR`（仅 daemon 直跑）→ `WEMIND_HOME` → 默认 `~/.wemind`。

> 用 `wemind start` / 开机自启时，启动器会主动丢弃 `WECHAT_DATA_DIR`，避免串账号。要改根目录，用 `WEMIND_HOME`。

## 账号与运行

| 变量 | 作用 |
| --- | --- |
| `WECHAT_ACCOUNT` | 启动器内部指定账号 key；一般不用手设 |
| `WEMIND_HOME_MODE` | 一次性覆盖 `direct` / `managed`；持久值仍看 `wemind config home-mode` |
| `WEMIND_LOG_LEVEL` | `debug` 才输出 debug 日志 |
| `WEMIND_ACP_AUTO_ALLOW` | 默认 `1`（yolo，自动允许权限请求）；设 `0` 恢复逐次拒绝 |
| `WECHAT_TOOL_PROGRESS_ITEMS` | 设 `1` 才发结构化工具进度 item；默认发文本 |

## 大脑与 ACP

| 变量 | 作用 |
| --- | --- |
| `WEMIND_BRAIN` | 一次性指定 Agent，如 `codex` / `opencode` / `auto` |
| `WEMIND_BRAIN_BIN` | 覆盖可执行文件路径 |
| `WEMIND_BRAIN_ARGS` | 整段替换 ACP 启动参数 |
| `WEMIND_BRAIN_EXTRA_ARGS` | 追加 ACP 启动参数；只加开关时用它 |
| `WEMIND_BRAIN_HOME_ENV` | 覆盖 Agent 配置目录环境变量名（仅 managed 指向副本） |
| `WEMIND_ACP_SESSION_MODE` | 覆盖/关闭预设的 `session/set_mode`；`0`/`false`/`off`/`no` 关闭 |
| `WEMIND_WORKER_MCP_EXCLUDE` | managed worker 额外排除的 MCP 名，逗号分隔 |

`WEMIND_BRAIN*` 是**一次性覆盖**，不要写进 profile；持久切换用 `wemind brain set`。

## 媒体与任务

| 变量 | 作用 |
| --- | --- |
| `WEMIND_MEDIA_RECIPIENT_TTL_MS` | 收件人模式滑动 TTL，默认 `180000`（3 分钟） |
| `WEMIND_MEDIA_FLUSH_DEBOUNCE_MS` | 附件队列安静等待，默认 `700`；`0` 关闭 |

> 媒体/任务的变量名以当前版本为准；升级后先看 `wemind version` 和 release notes。

## 代理与网络

daemon 需要访问微信 iLink 服务。公司网络/代理环境下，建议用：

```bash
wemind env capture
wemind env show
```

把 `PATH`、`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`、locale 等非敏感变量保存下来，供自启/后台进程使用。**不要把 token、API key 写进 `env capture`。**

## 查看与清理

```bash
wemind env show
wemind env clear
```

`env clear` 会区分“已删除”和“本来不存在”，不会假装成功。

## 不要做的事

- 不要把 `WECHAT_DATA_DIR` 和 `wemind start` 混用，后者不认它。
- 不要把 `WEMIND_BRAIN*` 写进 profile；那会把临时选择变成隐式默认。
- 不要把 `DEEPSEEK_API_KEY` 等密钥写进 Agent 定义或仓库；由 daemon 进程环境提供。
