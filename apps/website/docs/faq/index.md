---
description: WeMind 常见问题：扫码、连接、Node、Windows、任务、附件与安全。
---

# 常见问题

## 扫码后一直登录不上

- 二维码有效期很短，过期就刷新。
- 手机和电脑不在同一网络时，先换手机流量/热点试一次。
- 看 `wemind log --errors`，确认不是 iLink 超时。

iLink 超时常见错误码是 `-14`，会暂停约 1 小时。重启 daemon 或重新扫码通常能恢复。

## 提示 `wemind: command not found`

装的是包 `@wemind/cli`，命令是 `wemind`。确认全局 bin 在 PATH 上：

```bash
npm i -g @wemind/cli
wemind version
```

临时运行要写 `npx -y @wemind/cli`，不能写 `npx wemind`。

## Node 版本不对

当前要求 **Node.js 24.11+**。`node -v` 低于这个版本，先升级。用 nvm/fnm 的，确认 daemon 启动时用的是同一个 Node。

## 微信有时回、有时不回

最常见原因：**MCP 形态和 daemon 形态同时跑**。同一个 bot token 只能一个程序长轮询。

```bash
wemind list
wemind stop
```

只留一种形态，再试。

## 发了消息，Agent 没反应

按顺序查：

1. `wemind list`：daemon 在跑吗？
2. `wemind log --errors`：有 ACP 握手/模型/权限错误吗？
3. `wemind brain check`：当前 Agent 能握手吗？
4. 你是不是登录者？非登录者会被白名单拦住。
5. 有没有同时开 MCP 形态？

## `brain check` 超时

- Agent 没装或不在 PATH：`wemind agent show <agent> --explain`。
- 启动参数不对：用 `--extra-args` 追加，不要用 `--args` 整段替换漏掉 ACP 参数。
- Agent 需要先登录：先在终端里跑一次它自己的登录。
- Copilot 不参与自动探测，必须显式 `wemind brain set copilot`。

## Windows 上提示凭证/权限问题

- `account.json` 在 Windows 上是明文，确保磁盘/账户权限可控。
- `.cmd`/`.bat` 需要经 shell 启动；内置定义已处理，自定义定义要设 `binWin` 和 `shell: true`。
- 不要从任务工作目录解析裸命令名，容易被同名 `.cmd` 劫持。

## 任务卡在“正在跑”

ACP 回合不能优雅取消，`结束任务` 只能力杀。先：

```bash
wemind task-list
wemind task-status <编号>
wemind task-stop <编号>
```

如果 daemon 重启过，任务会标成「待继续」，不会自动跑；回「继续」或 `wemind task-resume-all`。

## 任务收不到附件

先设收件人：

```text
发给任务 2
```

再发图片/文件，最后发一句文字提交。没有收件人时，带附件的消息会进聊天大脑。

## 附件发不出去

- 路径必须是绝对路径。
- 不支持 UNC/网络路径。
- 敏感文件默认被拦；需要时发 `允许敏感文件` 临时开窗。
- 单文件默认上限 25MB。

## 能不能不用自己的电脑，放云服务器？

可以，但 WeMind 的设计是“Agent 跑在你自己控制的机器上”。放云服务器等于把那台机器变成你的 Agent 工作机；仍要自己负责登录、权限、密钥和磁盘安全。

## 会不会把聊天记录上传？

WeMind 本身不建云端中转；消息由本机 daemon 接收，交给本机 Agent。Agent 自己是否会调用云端模型，取决于你选的 Agent 和它的配置。

## 怎么彻底卸载

```bash
wemind autostart uninstall
wemind stop
wemind delete
npm uninstall -g @wemind/cli
```

再删除 `~/.wemind`（确认没有要保留的会话/附件）。

## 还有问题

- [命令速查](../guide/commands.md)
- [参考](../reference/)
- [GitHub Issues](https://github.com/imwangpan/WeMind/issues)
