---
description: 让 WeMind daemon 在登录后自动启动，并避免两套自启同时抢 token。
---

# 开机自启

`wemind autostart` 负责让 daemon 在登录后自己起来。它不负责登录微信；第一次仍要 `wemind login` 扫码。

## 命令

```bash
wemind autostart install
wemind autostart status
wemind autostart uninstall
```

指定账号：

```bash
wemind autostart install --key <key>
wemind autostart install --label 工作号
```

## 它会装什么

WeMind 会按平台选一种方式：

| 平台 | 默认方式 |
| --- | --- |
| 检测到 PM2 | PM2 进程 `wemind-<key>`；Windows 另装登录任务 `wemind-autostart-pm2` |
| Windows，无 PM2 | 计划任务；不可用时退回 `HKCU\Run` |
| Linux | systemd user 单元 `wemind@<key>` |
| macOS | LaunchAgent |

> 同时装 PM2 和系统触发器会抢同一个 bot token。两套都在时，先确认只留一套，再重启。

## 为什么触发器只跑 `start` / `daemon`

- Windows 触发器执行 `wemind start --all`，之后由内置 watchdog 负责重拉。
- Linux systemd / macOS launchd 本身就是 supervisor，单元执行 `wemind daemon`（前台常驻）。如果这里跑 `start`，会被判“服务已退出”并无限重拉。
- 触发器**不会**执行 `autostart install`，否则每次登录都会递归安装。

## 环境变量

登录后自启的进程不读你 shell 里的临时环境变量。需要长期生效的变量，写到 WeMind 的配置/环境快照里：

```bash
wemind env capture
wemind env show
```

`env capture` 只保存非敏感环境（PATH、代理、locale 等），不保存 token/密钥。

启动器会丢弃 `WECHAT_DATA_DIR`，避免一个账号的临时覆盖串到别的账号；`wemind daemon` 直接前台跑时仍保留这个变量的一次性语义。

## 验证

```bash
wemind autostart status
wemind list
wemind log --errors
```

`list` 里应该是 running；`log` 里不应反复出现“连续崩溃”。

## 卸载

```bash
wemind autostart uninstall
```

卸载只移除自启，不删除账号数据。要彻底清理，再执行 `wemind delete`。

## 常见问题

**登录后没起来？** 看 `autostart status` 是不是 `not installed` 或 `unknown`；Windows 上计划任务可能被安全软件拦。

**起来了又退出？** 先手动跑 `wemind start <key>` 看报错；常见是 Node 路径不对、Agent 没登录、端口/目录权限。

**PM2 和计划任务都有？** 只留一个。两套会同时长轮询，表现为消息时有时无。
