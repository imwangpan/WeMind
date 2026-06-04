# Changelog

本文件记录本 Fork 相对上游 [Howardzhangdqs/mcp-wechat-server](https://github.com/Howardzhangdqs/mcp-wechat-server) 的改动。

## [Unreleased] — fork

### Added
- **Node.js 支持**：`tsc` 构建到 `dist/`，`node` 直接运行；新增 `build` / `typecheck` / `start` / `dev` / `test` 脚本，`engines.node >= 20`。
- iLink 公共请求头 `iLink-App-Id`（`bot`）与 `iLink-App-ClientVersion`（应用到所有 GET/POST 请求）。
- `notifyStart` / `notifyStop` 上下线通知：登录确认及启动（已登录）时上线，登出时下线。
- 会话守卫 `session-guard`：命中 errcode `-14`（会话超时）后进入 1 小时冷却，返回可操作的 `session_expired` 提示而非通用报错或空转。
- 单元测试（vitest）覆盖 session-guard 与 package 元数据读取；GitHub Actions CI 跑 typecheck + build + test。

### Fixed
- 回复引用（`ref_msg`）此前从 `WeixinMessage` 读取（恒为 `undefined`，死代码），改为从 `MessageItem` 读取。
- server 版本号从硬编码 `1.0.0` 改为读取 `package.json`。
- Windows 下 `chmod 600` 为 no-op 导致 token 明文且无提示：限定 chmod 仅在 POSIX 执行，Windows 下输出一次性明文告警。

### Borrowed
- iLink 协议细节、`session-guard` 与 `notifyStart` / `notifyStop` 实现借鉴自微信官方插件 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）。
