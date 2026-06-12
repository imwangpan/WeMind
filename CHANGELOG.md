# Changelog

本文件记录本 Fork 相对上游 [Howardzhangdqs/mcp-wechat-server](https://github.com/Howardzhangdqs/mcp-wechat-server) 的改动。

## [Unreleased] — fork

### Changed
- **状态目录改为 `~/.wemind/<account>/` 并支持多账号**：默认目录由 `~/.mcp-wechat-server` 改为 `~/.wemind/default`；新增 `WECHAT_ACCOUNT` 选择子目录、`WECHAT_DATA_DIR` 指定完整路径覆盖。`DATA_DIR` 在 core 单点定义、daemon 从 core 导入。多账号即「不同 `WECHAT_ACCOUNT` → 不同目录 → 各自独立登录/状态/会话，各跑一个 daemon」。`run-daemon.ps1` 的单实例 Mutex 也按账号区分，多账号可共存。
- **重构为 npm workspaces 三包布局**：原 `src/` 平铺结构拆为 `packages/wechat-ilink-core`（`@wemind/wechat-ilink-core`，iLink 协议内核，私有）、`packages/wechat-mcp`（`@wemind/wechat-mcp`，可发布的 MCP server，`bin: wemind-mcp`）、`packages/wechat-daemon`（`@wemind/wechat-daemon`，私有常驻进程）。三包共享同一内核，消费方只依赖 `core`，不再互相耦合。
  - `core` 去掉对 `package.json`（`pkg.ts`）的 `ilink_appid` 耦合，固化为 `config.ts` 常量（`ILINK_APP_ID`，env 可覆盖）；新增 barrel `index.ts` 统一导出。
  - `mcp-server` 用 [tsup](https://tsup.egoist.dev/) 把 `core` **内联**进单一产物，发布时无需单独发 `core`；版本号改由 `version.ts` 向上查找自身 `package.json` 读取（打包后亦可用）。
  - 构建顺序 `core → daemon/mcp-server`，由 root 编排脚本保证；daemon 入口由 `dist/daemon/index.js` 变更为 `packages/wechat-daemon/dist/index.js`（`scripts/run-daemon.ps1` 已同步）。

### Added
- **发图（出站图片）**：core `getUploadUrl` + `sendImage`（AES-128-ECB 加密 → CDN 上传 → `image_item` 发送，`no_need_thumb` 免缩略图、无需 sharp/jimp）。daemon 从 brain 回复中提取图片引用（Markdown `![](url/本地路径)` 或裸图片 URL）→ 下载/读取 → 作为图片消息发出，再发清理后的文本；acp-brain 每会话首轮注入「可发图」约定提示。移植自官方 openclaw-weixin。实测真机收到。
- **一条命令登录 + key/label 选择器**：`manage.js login [--label][--start]` 完成扫码登录全流程——自刷新二维码（过期自动换）、终端 ANSI 码 + 自动打开 PNG、扫码确认后自动按 botId 归档登记，`--start` 顺带启动 daemon。`logout`/`delete`/`label`/`set-default`/`start` 支持用 key 或 label 选择账号。daemon 包新增 `qrcode` 依赖。
- **多账号登录/登出/删除**：账号注册表 `~/.wemind/accounts.json`，每账号独立目录 `~/.wemind/<key>/`（`key` 由微信 botId 派生，唯一；另存可编辑 `label` 别名）。新增管理 CLI `packages/wechat-daemon/dist/manage.js`：`list`/`finalize`(暂存登录→按 botId 归档)/`adopt`/`label`/`set-default`/`logout`(停 daemon+下线+清凭证)/`delete`(停 daemon+删目录+注销)。daemon 启动写 `daemon.pid`、wrapper 写 `wrapper.pid` 到账号目录，供管理命令精确停止整条链。多账号自启脚本 `scripts/run-all-daemons.ps1` 遍历注册表逐账号拉起（各账号 Mutex 独立、可共存）。
- **ACP 常驻大脑**：daemon 默认改用常驻的 `kiro-cli acp` 进程（JSON-RPC over stdio）当大脑，取代「每条消息 spawn」。原生多轮记忆、暖进程（~3s，原 spawn ~6s）、回复从 `agent_message_chunk` 流式拼接（无旁白/ANSI）；带存活检测自动重启、PID 进程树清杀；新增微信指令 `新会话`/`重置` 开启新会话。`brain.ts`（spawn 版）保留作回退。
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
