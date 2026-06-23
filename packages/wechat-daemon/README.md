# @wemind/wechat-daemon

> 脱离 kiro-cli 会话的**常驻微信 Bot 守护进程**：自己长轮询 iLink 收消息 → 调常驻 ACP 大脑生成回复 → 自动回发。支持**远程任务（worker）**与**多账号**。

[WeMind](https://github.com/imwangpan/WeMind) monorepo 的常驻包；只依赖内核 `@wemind/wechat-ilink-core`，不碰 MCP 层，可独立运行。

## 能力

- **对话大脑**：常驻 `kiro-cli acp`（或任意兼容 ACP 的 agent，见 `docs/接入其它-ACP-Agent.md`）当大脑，原生多轮记忆、流式拼接、存活检测自愈。
- **远程任务（worker）**：把漫长任务交给受控 ACP worker，在「需要决策 / 中断」时推微信、回复注入续跑。两个入口管同一任务——微信 `任务：…`，或本地终端 `manage.js task`。
- **多账号**：每账号独立目录 / daemon / 会话；`manage.js` 统一管理。
- **健壮性**：typing 续命、连续发送上限治理、iLink 错误码分类、收发图/文件、收语音。

## 用法

```bash
npm run build
npm run daemon            # 前台运行（需先完成扫码登录）

# 多账号管理（manage.js）
node packages/wechat-daemon/dist/manage.js login --label 主号 --start   # 扫码登录 + 启动
node packages/wechat-daemon/dist/manage.js list                          # 账号 + 运行状态
node packages/wechat-daemon/dist/manage.js task "<描述>" --cwd <目录>     # 本地派发远程任务
```

> ⚠️ **安全**：daemon 用 `--trust-all-tools`——能给该微信 Bot 发消息的人即可让大脑在本机执行任意工具（含 shell / 写文件）。唯一安全闸是**发件人授权（allowFrom）**：扫码登录者自动授权，**勿关闭**。

## 文档（主仓库 `docs/`）

- 常驻原理（看门狗 / 自启 / 多账号 / pid 链）：`daemon-常驻原理.md`、`跨平台常驻-pm2.md`
- 远程任务设计与使用：`方案C-MVP-远程human-in-the-loop.md`、`本地双入口-命令派发与看敲.md`、`使用指南-远程任务（worker）.md`
- 切换大脑 agent：`接入其它-ACP-Agent.md`

## License

MIT
