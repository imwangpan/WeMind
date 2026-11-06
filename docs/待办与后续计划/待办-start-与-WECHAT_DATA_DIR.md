# 待办：`wemind start` 继承 `WECHAT_DATA_DIR`（启动器与管理命令指向不一致）

> **状态**：暂缓（2026-11-05 记录，本轮不修）｜ **适用范围**：现行代码（`watchdog-runner.ts` / `pm2-runner.ts` / `manage.ts` / core `store/account.ts`）
> **触发原因**：核对开机自启方案时发现——`wemind start <key>` 会把父进程的 `WECHAT_DATA_DIR` 原样透传给后台守护进程，而 `stop` / `list` / `session` / `task` 一律按 `accountDir(key)` 找目录。两者指向不同位置时，**启动器报告成功、实际没起或起错账号**。
> **当前结论**：**本轮不改**（改它要动 `startDaemon` 的启动环境构造 + 补测试 + 改五处文档，适合与 `wemind start --all` 合并成一次改动）。方案见 §5。

---

## 1. 一句话结论

`WECHAT_DATA_DIR` 是「**单个进程**」的数据目录覆盖（对 `wemind daemon` 直跑是正当用法）；但 `wemind start <key>` 是**按 key 寻址的管理命令**，必须解析到 `accountDir(key)`——**启动器不应该继承它**。`WEMIND_HOME` 则相反（它是根目录，与 `accountDir()` 的解析口径一致），继承是对的。

---

## 2. 事实（源码核实，2026-11-05）

| 事实 | 出处 |
|---|---|
| 数据目录解析：`WECHAT_DATA_DIR` **优先于** `WECHAT_ACCOUNT` | `DATA_DIR = process.env.WECHAT_DATA_DIR?.trim() \|\| path.join(WEMIND_ROOT, ACCOUNT_KEY)`（`packages/wechat-ilink-core/src/store/account.ts:14-15`） |
| 管理命令按**注册表根**解析：`accountDir(key) = path.join(WEMIND_ROOT, key)`，`WEMIND_ROOT = WEMIND_HOME \|\| ~/.wemind` | `packages/wechat-ilink-core/src/store/accounts.ts:15,42-44` |
| `stop` / `list` / `session` / `task` 全部走 `accountDir(key)` | `cli-context.ts:68,77,85,97`、`manage.ts:205`、`cli-session.ts:49,70,105`、`cli-task.ts:137` |
| 启动器**只覆盖 `WECHAT_ACCOUNT`**，其余父进程环境原样透传 | `watchdogStart()`：`env: stripVscodeDebugEnv({ ...process.env, WECHAT_ACCOUNT: key })`（`watchdog-runner.ts:148-155`） |
| pm2 路线同样透传 | `pm2Start()`：`pm2Run("start …", { env: { ...process.env, WECHAT_ACCOUNT: key } })`（`pm2-runner.ts:107`）；声明里只写 `env: { WECHAT_ACCOUNT: key }`，其余由 pm2 从**执行 `pm2 start` 的进程环境**合并进来（`pm2-runner.ts:73` 注释） |
| 项目**已经知道**这个坑 | `scripts/run-all-daemons.ps1:38`：`if ($env:WECHAT_DATA_DIR) { $childEnv['WECHAT_DATA_DIR'] = $null }`（第 11-12 行还先 `Write-Warning` 提示一次） |
| 直跑 `wemind daemon` 用它**是正当的** | `scripts/run-daemon.ps1:15` 单账号 wrapper 明确按 `WECHAT_DATA_DIR` 覆盖；[速查](../使用指南/速查-数据目录与环境变量.md) §7 就是这么教的 |
| `start` 的启动环境构造**零测试覆盖** | `watchdog-runner.test.ts` 只测 `nextRestartBudget`；`pm2-runner.test.ts` 只测声明生成，不测 `pm2Start` 的 env |

---

## 3. 三种失败形态（都可复现，都不报错）

前提：父进程环境里有 `WECHAT_DATA_DIR=<某路径>`（例如用户按《速查》§7 配过、或写进了计划任务环境），此时执行 `wemind start <key>`。

### ① 静默空转：报告「已启动」，实际什么都没起

`WECHAT_DATA_DIR` 指向的目录里**已有**另一个 daemon 在跑（该目录的 `daemon.pid` 存活）：

1. `startDaemon(key)` → `stopDaemon(key)`：按 `accountDir(key)` 找，**找不到**那个 daemon → 跳过（不会误杀，但也拦不住）；
2. `watchdogStart(key)` → `_watchdog` 进程内 `DATA_DIR` 解析成 `WECHAT_DATA_DIR` → `acquireSingleton()` 读到那里存活的 `wrapper.pid` → 写一行「已有实例在跑，本次退出」后 `return`；
3. 而 CLI 已经把「已启动自带后台守护进程（账号 X，pid N）。日志：`accountDir(key)/daemon.log`」打印出来了——**连日志路径都是错的**（真实日志写进了 `WECHAT_DATA_DIR` 那个目录）。

### ② 起错账号：用户要 B，实际启动的是用 A 的 bot token 收消息的 daemon

若 `WECHAT_DATA_DIR` 指向的目录没有正在跑的 daemon：`_watchdog` 照常拉起 `daemon`，它读的是**那个目录的 `account.json`**。于是「`wemind start B`」起了一个用 **A 账号 token** 收消息的 daemon，`daemon.pid` / `wrapper.pid` 也全落在那个目录。

### ③ 停不掉：`wemind stop B` 找不到它

`stopDaemon(key)` 读 `accountDir(key)`（注册表根下的目录），而 daemon 把 pid 写进了 `WECHAT_DATA_DIR`。CLI 报「未运行」，进程还在跑。

> ③ 单独看是**既有已知项**（[速查 §7](../使用指南/速查-数据目录与环境变量.md) 的 ⚠️ 已写：只设 `WECHAT_DATA_DIR` 时 `list/stop` 可能找不到 pid）。本待办新增的是**①②**：启动器**静默**制造了这个局面，并且**声称成功**。

---

## 4. 为什么只该修启动器，不该改 core

| | 继承 `WECHAT_DATA_DIR` | 判断 |
|---|---|---|
| `wemind daemon`（直跑） | 是 | ✅ **正确**——这是「只给这个进程换目录」的唯一入口，速查 §7 的正当用法 |
| `WECHAT_DATA_DIR` 的语义 | 单账号完整路径 | ✅ 不变 |
| `WEMIND_HOME` 被 `watchdogStart` / `pm2Start` 继承 | 是 | ✅ **正确**——它是根目录，`accountDir()` 也从它解析，继承后 `start`/`stop`/`list` 仍指向同一处 |
| `wemind start <key>` 继承 `WECHAT_DATA_DIR` | 是 | ❌ **不一致**——它让「按 key 寻址」的管理命令指向一个与 `accountDir(key)` 无关的目录 |

**结论**：改动点只在**启动器的环境构造**，core 的优先级链不动、`wemind daemon` 的行为不动。

---

## 5. 方案对比

| # | 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|---|
| **S1** | **启动器丢弃继承的 `WECHAT_DATA_DIR`**（推荐） | 在 `watchdogStart()` 与 `pm2Start()` 构造子进程环境时删掉该键（与 `run-all-daemons.ps1:38` 同口径）；**同时在 stderr 打一条提示**「检测到 `WECHAT_DATA_DIR`，`wemind start` 已忽略它（要整体迁移请用 `WEMIND_HOME`）」 | 与 `stop`/`list` 口径对齐；`start` 变成真正的「按 key 寻址」；提示保证**不静默**；对「本来就想用自定义目录」的人，提示给出正确替代（`WEMIND_HOME`） | 目前靠 `setx WECHAT_DATA_DIR` + `wemind start` 自定义目录的人会失效（估计极少——该用法与 `stop`/`list` 本来就不通） |
| S2 | 启动器**拒绝执行**（报错退出） | `wemind start` 一旦检测到 `WECHAT_DATA_DIR` 就 `process.exitCode=1` 并说明原因 | 最响；绝不静默降级 | 更粗暴：环境里有残留变量就完全不能启动，连「起别的账号」也做不了 |
| S3 | 让 `stop`/`list` 也认 `WECHAT_DATA_DIR` | 管理命令读该变量来定位目录 | 表面上「两边一致」 | 方向错了：`list` 是**枚举注册表**，注册表只认 `accountDir(key)`；单个环境变量无法表达「多账号各自的目录」。等于把 `WECHAT_DATA_DIR` 升格成根目录，与 core 语义冲突 |
| S4 | 维持现状，只补文档 | 在速查 §9 写明「`wemind start` 会透传 `WECHAT_DATA_DIR`」 | 零改动 | ①②两种静默失败仍在；文档提醒救不了「报告成功却什么都没起」 |

**推荐 S1**（含提示）。理由：它把「启动器 = 按 key 寻址」这条口径补成真的，且**不改变** `wemind daemon` 的正当用法；提示让旧用法的人有明确迁移路径。

**实现注意**（别踩）：不要用 `{ ...process.env, WECHAT_DATA_DIR: undefined }`——`spawn` 的 env 对象里给 `undefined` 在不同平台上行为不保证；**拷一份再 `delete`**（与 `run-all-daemons.ps1` 传 `$null` 同理）。pm2 那条要额外注意：`buildAppDeclaration` 只声明 `WECHAT_ACCOUNT`，其余由 pm2 从**执行 `pm2 start` 的进程环境**合并——所以要在传给 `pm2Run` 的 env 里删，光改声明文件无效。

---

## 6. 若实施，必须一起做（§4.15 三件套）

1. **代码**
   - 抽一个纯函数（如 `launcherEnv(key, parentEnv)`）供 `watchdogStart` 与 `pm2Start` 共用——这是唯一可单测的接缝（两者本身都会 spawn 外部进程）；
   - `watchdogStart()`（`watchdog-runner.ts:148-161`）：改用该函数；检测到被丢弃的变量时写一条 stderr 提示（**不要**写进 `daemon.log`——那时目录还没解析出来）；
   - `pm2Start()`（`pm2-runner.ts:95-119`）：传给 `pm2Run` 的 env 同样经过该函数。
2. **测试**（目前 `start` 的 env 构造零覆盖）
   - `launcherEnv` 正常路径：保留 `WECHAT_ACCOUNT` 覆盖、保留 `WEMIND_HOME` / `DEEPSEEK_API_KEY` 等其它变量；
   - 关键路径：父进程有 `WECHAT_DATA_DIR` → 结果里**没有**该键；
   - 边界：`WECHAT_DATA_DIR` 为空串/只有空白（`account.ts` 用 `?.trim() ||` 判空，启动器应同样按「空即无」处理，避免把 `""` 当有效覆盖）；
   - `pm2-runner.test.ts` 补一条：`pm2Start` 传给 `pm2Run` 的 env 不含该键（可注入假 `pm2Run`）。
3. **文档**（按读者找全）
   - `docs/使用指南/速查-数据目录与环境变量.md` §7（现只有「直跑 `wemind daemon`」的说明，要补「`wemind start` 会忽略它」）与 §9（环境变量怎么传给 daemon 的那节）；
   - `docs/repowiki/09-配置项与环境变量.md` 的 `WECHAT_DATA_DIR` 行；
   - `README.md` 环境变量表、`packages/wechat-daemon/README.md` 环境变量表（随 npm 包发布，硬性同步项）；
   - `docs/ai/已知坑.md`（加一条）；
   - `docs/部署与运维/自启方案对比.md` §4.2 坑 2（改为「已记录待办」并链到本文）。
4. **验收**
   - `npm run verify` 全绿；
   - 真机：`setx WECHAT_DATA_DIR <某目录>` 后 `wemind start <key>` → 提示出现、`~/.wemind/<key>/daemon.pid` 正确、`wemind list` 显示运行中、`wemind stop <key>` 能停掉；
   - 回归：`WECHAT_DATA_DIR=<dir> wemind daemon` 直跑仍按该目录（不能被本次改动连带改坏）。

---

## 7. 与其它待办的关系

- **[自启方案对比](../部署与运维/自启方案对比.md) §4.2 坑 2 与 P1（`wemind start --all`）**：`--all` 必然遍历注册表，同样必须丢弃继承的 `WECHAT_DATA_DIR`。**两者共用同一个 `launcherEnv`**，建议**一次提交**完成（否则 `--all` 会把坑 2 放大到「每个账号都指向同一个目录」）。
- **[待办：任务编号与记录体积](待办-任务编号与记录体积.md)**：无关，仅同属「暂缓」清单。
