# WeMind CLI 化设计（可发布的 `wemind` 命令）

> 状态：设计定稿（2026-06-24），待实现。

## 1. 目标

把「完整应用」（现 `@wemind/wechat-daemon` 包）做成**可发布的 `wemind` CLI**：用户 `npm i -g wemind` 或 `npx wemind …` 即可使用，**全程不碰源码、三平台通用**。

对外形成**两个发布入口**：

| 入口 | 定位 | 现状 |
| --- | --- | --- |
| `@wemind/wechat-mcp` | 轻包，纯 MCP server，插进任意 MCP 客户端 | 已可发布，不动 |
| `wemind` | 完整应用 CLI：常驻自动收发 + 远程任务 + 多账号 | 本设计新增 |

## 2. 决策记录（2026-06-24 拍板）

1. **两入口**：`@wemind/wechat-mcp`（轻）+ `wemind`（完整）。
2. **常驻**：**先方案 a（`wemind start` 封装 pm2）**，后续再迭代到方案 b（自带看门狗、去外部依赖）。
3. **目录**：内部 `packages/wechat-daemon/` 保留不改名，仅改对外发布 `name` 为 `wemind`。
4. **旧脚本**：`run-daemon.ps1` / `ecosystem.config.cjs` 保留，给「从源码仓库跑」的开发者。

## 3. 命令结构（统一一个 `wemind` bin）

| 命令 | 作用 |
| --- | --- |
| `wemind login [--label 名] [--start]` | 扫码登录（扫码即自动接入 ClawBot）；`--start` 顺带常驻 |
| `wemind list` | 账号 + 运行状态（含 pm2 进程状态） |
| `wemind start [<key\|label>]` | 启动常驻（封装 pm2） |
| `wemind stop [<key\|label>]` | 停止常驻（新增） |
| `wemind logout / delete / label / set-default / adopt` | 账号管理（同现有 manage） |
| `wemind allow / revoke / allowlist` | 授权管理 |
| `wemind task / task-status / task-reply / task-stop` | 远程任务 |
| `wemind daemon` | （内部）跑 daemon 本体，供 pm2 调用，用户一般不直接用 |

对用户只是多了 `start/stop`，其余由 `node …/manage.js X` 变为 `wemind X`。

## 4. 代码改造清单（不动核心收发逻辑）

1. **新建 `cli.ts`（bin 入口）**：读首个子命令——
   - `daemon` → `runDaemon()`；
   - `start` / `stop` → pm2 封装函数；
   - 其余 → `runManage(argv)`。
2. **`index.ts`**：把 `main()` 抽成可导出的 `runDaemon()`（启动逻辑不变）。
3. **`manage.ts`**：把 `main()` 抽成可导出的 `runManage(argv)`；删 `REPO_ROOT` 等仓库路径假设；`startDaemon` 改为走 pm2 封装；提示文本 `node packages/…/manage.js` → `wemind`。
4. **新增 pm2 封装**（`pm2-runner.ts`）：检测 pm2、`start/stop/status`。

## 5. 打包（tsdown，照搬 mcp 成功做法）

新增 `packages/wechat-daemon/tsdown.config.ts`：

- `entry: ["src/cli.ts"]`，`format: ["esm"]`，`platform: node`，`target: node20`；
- `alwaysBundle: ["@wemind/wechat-ilink-core"]`（内联 core）；
- `dts: false`；`outExtensions` 输出 `dist/cli.js`；保留 shebang。

单文件自包含产物。

## 6. 包身份（`packages/wechat-daemon/package.json`）

- `name`: `@wemind/wechat-daemon` → **`wemind`**；
- 去掉 `private: true`；
- `bin`: `{ "wemind": "dist/cli.js" }`；
- `files`: `["dist"]`；`publishConfig.access`: `public`；
- `build`: `tsdown`。

## 7. 常驻：封装 pm2（方案 a）

- `wemind start [key]`：
  1. 检测 pm2（`pm2 -v`）；未装则提示 `npm i -g pm2` 并退出；
  2. `pm2 start <cli.js 绝对路径> --name wemind-<key> --interpreter node -- daemon`，注入 `env WECHAT_ACCOUNT=<key>`；
  3. 提示用户 `pm2 save`，首次再 `pm2 startup`（Linux/macOS 一条龙；Windows 用计划任务跑 `pm2 resurrect`，文档给步骤）。
- `wemind stop [key]`：`pm2 delete wemind-<key>`。
- `wemind list`：读账号注册表 + 查 pm2 进程状态。

> cli.js 绝对路径用 `fileURLToPath(import.meta.url)` 自解析（不依赖仓库结构）。

## 8. 兼容与保留

- 内部源码位置（`packages/wechat-daemon/src/*`）不变；`index.ts`/`manage.ts` 仍可被 tsc 单独编译（开发期 `npm run daemon` 等保留）。
- `run-daemon.ps1` / `ecosystem.config.cjs` 保留给源码开发者；发布版常驻走 `wemind start`（pm2）。

## 9. 实现步骤

1. 抽取 `runDaemon()`（index）/ `runManage(argv)`（manage）。
2. 新建 `cli.ts` + `pm2-runner.ts`。
3. 改 `package.json`（name/bin/去 private/build）+ 新增 `tsdown.config.ts`。
4. 删 `REPO_ROOT` 仓库路径假设，`startDaemon` 接 pm2。
5. `npm run build` / `typecheck` / `test` 全过。
6. 真机冒烟：`npm i -g pm2` → 本地 `node dist/cli.js login` → `start` → `list` 见 pm2 进程 → 微信收发验证 → `stop`。

## 10. 方案 b（自带看门狗）— 阶段 1 已实现 ✅

去掉 pm2 依赖：`wemind start` 默认用自带的跨平台 Node 看门狗常驻；与 pm2（方案 a）**共存**，靠 runner 选择——`wemind start [--runner builtin|pm2]`（或环境变量 `WEMIND_RUNNER`，默认 `builtin`）。

**阶段 1（已实现，Windows 真机验证通过）**——核心看门狗：

- `watchdog-runner.ts`：`runWatchdog()`（看门狗循环本体，由 `cli.js _watchdog` 调用——单实例守卫 → `for(;;)` 拉起 `cli.js daemon`、退出 5s 重拉、stdout/err 并入 `daemon.log`）；`watchdogStart()`（detached spawn + unref 脱离启动）。移植自 `run-daemon.ps1` 的 while 逻辑。
- `cli.ts`：新增 `_watchdog` 子命令分发。
- `manage.ts`：`--runner` 解析；`startDaemon(key, runner)` 按 runner 分发，**start 前先 `stopDaemon` 清现有任何 runner**（防同账号双跑抢 token）；`cmdStart`/`cmdLogin` 透传 runner。
- **单实例**：`wrapper.pid` + 存活检查（`process.kill(pid,0)`），零依赖、复用现有停止句柄；竞态由「start 前先 stop」压低（选型对比 pid 文件 vs proper-lockfile：前者零依赖且一份文件兼作停止句柄，后者原子但加依赖且仍需额外 pid，本场景竞态罕见，故选 pid 文件）。
- `stop`/`list` 无需改：现有 `stopDaemon`（pm2 delete + 杀 wrapper/daemon/brain pid）与 `daemon.pid` 存活检查同时覆盖两种 runner。

**阶段 2（开机自启 — 文档化方案已落实）**——跨平台开机自启**采用文档方案**而非自研：新手教程给出 Windows 启动文件夹 / 计划任务、Linux systemd user service、macOS launchd 三平台调 `wemind start` 的具体配置（`wemind start` 内部 builtin 看门狗负责崩溃重拉，自启层只需开机拉起一次）。自研 `wemind service install` 自动化留按需排期 + 对应系统实测。
