---
description: wemind CLI 的 28 个子命令索引与常用参数。
---

# CLI 子命令

安装包是 `@wemind/cli`，命令是 `wemind`。子命令列表由代码生成，下面按用途分组。

## 账号与进程

```bash
wemind login [--label 名] [--start]
wemind list
wemind start [key|label] [--all]
wemind stop [key|label]
wemind log [key|label] [--lines N] [--errors] [--file N]
wemind label <key> <新名字>
wemind set-default <key|label>
wemind logout
wemind delete
wemind adopt
wemind allowlist
wemind allow <userId>
wemind revoke <userId>
```

| 命令 | 说明 |
| --- | --- |
| `login` | 扫码登录并保存账号；`--start` 登录后直接启动 |
| `list` | 账号、label、运行状态 |
| `start` / `stop` | 启停指定账号；`--all` 启动全部 |
| `log` | 看 `daemon.log`；`--errors` 过滤 ERROR/WARN 并带上下文 |
| `adopt` | 接管已有登录会话 |
| `allowlist` / `allow` / `revoke` | 登录者白名单 |

## 大脑与 Agent

```bash
wemind brain
wemind brain check [key|label]
wemind brain set <agent|auto> [--bin X] [--args "..."] [--extra-args "..."] [--shell|--no-shell] [--model X] [--restart]
wemind brain switch <agent>
wemind brain handoff
wemind brain set <agent> --worker
wemind agent list
wemind agent show <agent> [--explain]
wemind agent spec
wemind agent probe <bin> [参数...]
wemind agent check <agent|文件> [--schema] [--deep]
wemind agent add <包|文件>
wemind agent remove <agent>
```

- `set` 写 `brain.json`；`switch` 让运行中的 daemon 立即换。
- `--extra-args` 追加，`--args` 整段替换。
- `agent check` 默认真实握手；`--schema` 只校验数据。

## 会话

```bash
wemind session list
wemind session new [名字]
wemind session resume <序号|名字|id前缀>
wemind session rename <序号|名字> <新名字>
wemind session delete <序号>
```

## 任务

```bash
wemind task "正文" [--cwd 目录] [--agent 名]
wemind task-status [编号]
wemind task-list
wemind task-reply [编号] "正文"
wemind task-stop [编号|all]
wemind task-resume-all
```

## 配置与 MCP

```bash
wemind config show
wemind config home-mode [direct|managed]
wemind config reload
wemind config agent ...
wemind config wechat ...
wemind config reply-style ...
wemind mcp list
wemind mcp enable <name>
wemind mcp disable <name>
wemind mcp add <name> -- <command> [args...]
wemind mcp remove <name>
```

`mcp` 只管理 `managed` 模式的激活集。`direct` 下请改 Agent 自己的 MCP 配置。

## 工作区与环境

```bash
wemind workspace show
wemind workspace set <路径> [--role brain|worker]
wemind workspace reset [--role brain|worker]
wemind env capture
wemind env show
wemind env clear
```

## 自启与版本

```bash
wemind autostart install [--key <key>|--label 名]
wemind autostart status
wemind autostart uninstall
wemind version
```

## 退出码与日志

- CLI 用户输出走 stdout，纯文本无前缀；运行日志走 stderr，格式 `[wemind/<scope>][INFO|WARN|ERROR] ...`。
- 出错时先看 `wemind log --errors`；它是一次性快照，没有 `--follow`。
- 需要实时跟日志，用 `tail -f` / `Get-Content -Wait`，或 PM2 的 `pm2 logs wemind-<key>`。
