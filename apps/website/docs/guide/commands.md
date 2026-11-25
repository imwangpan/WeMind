---
description: WeMind CLI 常用命令：账号、大脑、会话、任务、配置、MCP、自启。
---

# 命令速查

安装包是 `@wemind/cli`，命令是 `wemind`。这两个名字不一样：`npx` 按包名解析，所以临时运行要写 `npx -y @wemind/cli`，不能写 `npx wemind`。

```bash
wemind help            # 全部命令
wemind <命令> --help   # 某个命令的参数
```

## 账号与进程

| 命令 | 作用 |
| --- | --- |
| `wemind login --label 工作号 --start` | 扫码登录，并启动这个账号 |
| `wemind list` | 列出账号、label、运行状态 |
| `wemind start [key\|label]` | 启动指定账号；`--all` 启动全部 |
| `wemind stop [key\|label]` | 停止指定账号 |
| `wemind log [key\|label] [--lines N] [--errors]` | 看日志；`--errors` 只看错误/警告及上下文 |
| `wemind label <key> 新名字` | 改 label |
| `wemind set-default <key\|label>` | 设置默认账号 |
| `wemind logout` / `wemind delete` | 退出登录 / 删除账号数据 |
| `wemind adopt` | 接管一个已有的登录会话 |
| `wemind allowlist` / `wemind allow` / `wemind revoke` | 查看/添加/移除登录者白名单 |

## 大脑与 Agent

| 命令 | 作用 |
| --- | --- |
| `wemind brain` | 看当前对话大脑 |
| `wemind brain check` | 真实 ACP 握手，检查 Agent 能不能用 |
| `wemind brain set <agent>` | 换大脑，写入磁盘，重启仍生效 |
| `wemind brain switch <agent>` | 让运行中的 daemon 立即换；失败退回原来的 |
| `wemind brain handoff` | 生成交接摘要 |
| `wemind brain set <agent> --extra-args "..."` | 只追加启动参数，保留预设的 ACP 参数 |
| `wemind agent list` | 列出内置/本机 Agent 定义 |
| `wemind agent show <agent> [--explain]` | 看定义和来源 |
| `wemind agent spec` | 看定义字段规格 |
| `wemind agent check <agent\|文件>` | 校验定义；默认做真实握手 |
| `wemind agent probe <bin> ...` | 探测一个可执行文件能不能接 ACP |
| `wemind agent add <包\|文件>` / `remove` | 安装/移除本机定义 |

> `--extra-args` 是追加，`--args` 是整段替换。手动替换时如果漏掉 ACP 模式参数，握手会超时。

## 会话

| 命令 | 作用 |
| --- | --- |
| `wemind session list` | 当前账号的会话列表 |
| `wemind session new [名字]` | 新建会话 |
| `wemind session resume <序号\|名字\|id前缀>` | 恢复旧会话（严格恢复） |
| `wemind session rename <序号\|名字> <新名字>` | 重命名 |
| `wemind session delete <序号>` | 删除 |

## 任务

| 命令 | 作用 |
| --- | --- |
| `wemind task "正文" [--cwd 目录] [--agent 名]` | 派发任务 |
| `wemind task-status [编号]` | 看任务状态/输出 |
| `wemind task-list` | 列任务 |
| `wemind task-reply [编号] "正文"` | 回复任务 |
| `wemind task-stop [编号\|all]` | 结束任务 |
| `wemind task-resume-all` | 重启后继续所有「待继续」任务 |

## 配置、MCP、工作区

| 命令 | 作用 |
| --- | --- |
| `wemind config show` | 看当前配置 |
| `wemind config home-mode` | 看/切 `direct` 或 `managed` |
| `wemind config reload` | 重读 Agent 配置，重启大脑 |
| `wemind config agent ...` | 改 Agent 原生配置 |
| `wemind config wechat ...` | 改微信独享配置 |
| `wemind config reply-style ...` | 改回复风格 |
| `wemind mcp list\|enable\|disable\|add\|remove` | 管理 managed 模式的 MCP 激活集 |
| `wemind workspace show\|set\|reset` | 看/设/重置默认工作区 |
| `wemind env capture\|show\|clear` | 保存/查看/清除非敏感环境快照 |

## 自启与版本

| 命令 | 作用 |
| --- | --- |
| `wemind autostart install` | 安装开机自启 |
| `wemind autostart status` | 看自启状态 |
| `wemind autostart uninstall` | 卸载自启 |
| `wemind version` | 版本 |

## 一个最小日常

```bash
wemind list
wemind log --errors
wemind brain
wemind session list
wemind task-list
```
