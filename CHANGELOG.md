# Changelog

本文件记录本 Fork 相对上游 [Howardzhangdqs/mcp-wechat-server](https://github.com/Howardzhangdqs/mcp-wechat-server) 的改动。

## [Unreleased] — fork

### Added
- **brain MCP 沙箱 + 对话式动态加载**：brain 跑在独立 `KIRO_HOME`（`WECHAT_BRAIN_HOME`），**默认不加载任何 MCP**（杜绝 wechat 回环、不连本地浏览器）。微信指令 `加载/卸载/列出 MCP` 由 daemon 拦截，从全局 `mcp.json` 取定义动态写入沙箱（`wechat` 永久禁止）。
- **守护进程（`src/daemon/`）**：脱离 kiro-cli 的独立 WeChat bot。自长轮询 iLink → 调 headless `kiro-cli`（`--no-interactive --trust-all-tools`）当大脑 → 自动回发；带每用户滚动上下文、typing 指示、session-guard、发件人白名单（默认仅登录账号本人，`WECHAT_OWNER_ID` 可覆盖）。仅依赖 `api/` + `store/`，便于独立拆出。`npm run daemon` 启动；`scripts/run-daemon.ps1` 为常驻包装（循环重拉）。
- **Node.js 支持**：`tsc` 构建到 `dist/`，`node` 直接运行；新增 `build` / `typecheck` / `start` / `dev` / `test` / `daemon` 脚本，`engines.node >= 20`。
- iLink 公共请求头 `iLink-App-Id`（`bot`）与 `iLink-App-ClientVersion`（应用到所有 GET/POST 请求）。
- `notifyStart` / `notifyStop` 上下线通知：登录确认及启动（已登录）时上线，登出时下线。
- 会话守卫 `session-guard`：命中 errcode `-14`（会话超时）后进入 1 小时冷却，返回可操作的 `session_expired` 提示而非通用报错或空转。
- 单元测试（vitest）覆盖 session-guard 与 package 元数据读取；GitHub Actions CI 跑 typecheck + build + test。

### Fixed
- **登录二维码流程**：`get_bot_qrcode` 改为 POST + `local_token_list`；iLink 客户端版本对齐官方 `2.4.3`。此前用 GET 且声明的客户端版本过低，导致扫码「无反应 / 秒过期」。已实测登录、入站、出站全链路打通。
- 回复引用（`ref_msg`）此前从 `WeixinMessage` 读取（恒为 `undefined`，死代码），改为从 `MessageItem` 读取。
- server 版本号从硬编码 `1.0.0` 改为读取 `package.json`。
- Windows 下 `chmod 600` 为 no-op 导致 token 明文且无提示：限定 chmod 仅在 POSIX 执行，Windows 下输出一次性明文告警。

### Borrowed
- iLink 协议细节、`session-guard` 与 `notifyStart` / `notifyStop` 实现借鉴自微信官方插件 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）。
