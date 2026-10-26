# @wemind/cli（命令 `wemind`）独立发布方案

> 分支：`feat/wemind-npm-publish` ｜ 目标包：**`@wemind/cli`**（源码 `packages/wechat-daemon/`，命令 `wemind`）｜ 计划首发版本：**1.0.0**
>
> 本文件既是**方案**也是**实施记录**：§4 起的代码改动已在分支上落地并通过本地验证，§8 列出「还需要人做」的一次性动作。

---

## 1. 现状盘点（分析结论）

### 1.1 仓库里「三个包」的角色

| 包 | 目录 | 发布状态 | 说明 |
| --- | --- | --- | --- |
| `@wemind/wechat-ilink-core` | `packages/wechat-ilink-core` | 私有，**永不发布** | iLink 协议内核；被另两个包**构建时内联**（`alwaysBundle`），不是运行时依赖 |
| `@wemind/wechat-mcp` | `packages/wechat-mcp` | **已发布**（1.0.4） | MCP server，bin `wemind-mcp`，已有 `wechat-mcp-publish.yml` |
| `@wemind/cli` | `packages/wechat-daemon` | **本次发布** | 常驻 daemon + ACP 大脑 + worker + 多账号 CLI，**bin `wemind`** |

结论：不需要拆仓。运行时依赖只有 `qrcode`（第三方）＋内核（已内联），产物是**单文件 `dist/cli.js`（约 155 KB）**，具备「装了就独立跑」的前提。

### 1.2 阻塞发布的 5 个问题（已定位到具体行）

| # | 问题 | 证据 | 后果 |
| --- | --- | --- | --- |
| P1 | **包名冲突**：根包与待发布包都叫 `wemind` | 根 `package.json` `"name": "wemind", private: true`，workspace 里也有 `wemind` | 用户已注册 `@wemind` scope 且想按 scope 发布；同时 `wemind` 这个短名本身是「一个包名」，与根包同名会带来解析与心智混乱 |
| P2 | **进程身份特征写死源码目录名** | `proc-identity.ts`：`CLI_PID_MARKERS = [["wechat-daemon","cli.js"], …]` | 发布后命令行是 `…/node_modules/@wemind/cli/dist/cli.js`，**匹配不上** → `wemind list` 永远「已停止」、`stop` 杀不掉、看门狗单实例守卫失效（可能双开抢 token） |
| P3 | **用户可见提示指向源码路径** | `manage.ts` 两处 `node packages/wechat-daemon/dist/manage.js …` | 全局安装的用户照抄命令必然失败 |
| P4 | **无 `repository`/`homepage`/`author`** | `packages/wechat-daemon/package.json` | npm 页面无源码链接、无 provenance 校验基线；与 `wechat-mcp` 不一致 |
| P5 | **没有发布流水线、没有产物守卫** | 只有 `wechat-mcp-publish.yml` | 忘记 build 时会发出「只有 package.json」的空壳包（`bin` 指向不存在的 `dist/cli.js`），装上即 `MODULE_NOT_FOUND` |

> 附：`wemind version` 之前不存在（只有 help），排查用户问题（哪版、哪个 node）时缺最基本信息。

---

## 2. 发布定位与命名决策（2026-10-26 定稿）

### 2.1 结论

| 项 | 取值 | 说明 |
| --- | --- | --- |
| **npm 包名** | `@wemind/cli` | 收进你已注册的 `@wemind` scope，命名空间统一（与 `@wemind/wechat-mcp` 并列） |
| **命令名（bin）** | `wemind` | 与包名**有意不同**：`bin` 字段与包名无关，装完仍是短命令 |
| **仓库根包名** | `wemind`（**保持原样，不改**） | 根包 `private: true`，只是个容器，不发布 |
| **首发版本** | `1.0.0` | 新包新名，从 1.0.0 起（不是 1.1.0，避免让人以为有 1.0.x 历史） |

### 2.2 为什么包名可以和命令名不同（业界惯例）

scope 是**命名空间**，不是包；安装后得到什么命令由 `bin` 决定，与包名无关：

| 包名 | 命令 | 规律 |
| --- | --- | --- |
| `@wemind/cli` | `wemind` | 本项目 |
| `@angular/cli` | `ng` | 同规律（包名 ≠ 命令名） |
| `@openai/codex` | `codex` | scope 收窄，命令保持短名 |
| `@modelcontextprotocol/server` | 无 bin | scope 里放系列包 |
| `@wemind/wechat-mcp` | `wemind-mcp` | 已是本仓库的先例 |

### 2.3 ⚠️ 唯一的用户体验差异：`npx` 必须写全包名

npm 的 `npx <name>` 按**包名**解析，再按「唯一 bin」挑命令：

- 包名 `wemind` + bin `wemind` → `npx wemind list` 可用；
- 包名 `@wemind/cli` + bin `wemind` → 两个名字对不上，**必须** `npx -y @wemind/cli list`。

`npm i -g @wemind/cli` 之后敲的命令不受影响，仍是 `wemind …`。README、help 文本、发布文档里所有 `npx` 示例都按包名写全。

### 2.4 关于「根包是否改名」——我的结论是：**不需要改，已回退**

最初的改动把根包改名为 `wemind-monorepo`。复核后撤回，依据：

1. **根包是 private 容器**，不会发布，也不会与 `@wemind/cli` 撞名；
2. 根包名下没有挂任何 `bin`，与真正的发布包无冲突；
3. 是否带 `-w wemind` 只影响**仓库内部脚本**，用户完全感知不到——用户装的是 `@wemind/cli`。

需要的工作只是：把根 `package.json` 里两处 `-w wemind` 改成 `-w @wemind/cli`（`build` / `typecheck` / `verify:publish`），一次改完即可。你要求的「根包名不改」已满足。

### 2.5 其余定位

- **不发布内核**：`@wemind/wechat-ilink-core` 保持 `private: true`，继续内联。理由：内核 API 仍可能随协议变化；对外只需要「MCP server」与「CLI」两个入口。
- **两个发布入口互斥**：同一个 bot token 只能有一个消费者（`@wemind/cli` 的 daemon 或 `@wemind/wechat-mcp`），README 已写明。

---

## 3. 目标状态

```
npm i -g @wemind/cli                 → 得到 wemind 命令
wemind login --label 主号 --start    → 微信扫码 → 常驻守护 + ACP 大脑
wemind list / brain check / task …   → 全部命令自洽（不再出现源码路径）
git push main（CI）                  → 一次发布 = 构建产物 + prepack 守卫 + 装包冒烟 + provenance
```

---

## 4. 代码改动清单（已在本分支实施）

### 4.1 根 `package.json`：**根包名保持 `wemind` 不变**，只改内部脚本

- `name` **不变**（仍 `wemind`、`private: true`）；已撤回最初「改名 `wemind-monorepo`」的改动。
- 三处 `-w wemind` → `-w @wemind/cli`（`build` / `typecheck` / `verify:publish`），因为发布包改名叫 `@wemind/cli`。
- 新增脚本：`check:version`、`verify:publish`。

### 4.2 `packages/wechat-daemon/package.json`：包名改 `@wemind/cli`

- `name`: `wemind` → **`@wemind/cli`**；`version` → **`1.0.0`**（新包新名，从 1.0.0 起）。
- **`bin` 仍是 `{ "wemind": "dist/cli.js" }`** —— 包名与命令名解耦，安装后用户敲的还是 `wemind`。
- `description` 末尾补「安装后命令为 wemind」，避免 npm 页面上误会。
- 补 `repository`（含 `directory`）、`homepage`、`bugs`、`author`，与 `wechat-mcp` 保持一致。
- `keywords` 增加 `wemind` / `daemon` / `cli`。
- 新增 `prepack` **产物守卫**：`node ../../scripts/prepack-guard.mjs .`
- `files` 保持 `["dist"]`（`tsdown` 会保留 shebang 并 chmod +x）。

### 4.3 `src/proc-identity.ts`：进程身份特征改为 `wemind` + `cli.js`

```ts
export const CLI_PID_MARKERS: string[][] = [["wemind", "cli.js"], ["run-daemon.ps1"]];
```

覆盖三种安装方式（注释里写清）：

| 场景 | 命令行 | 命中原因 |
| --- | --- | --- |
| 源码仓库 | `…\WeMind\packages\wechat-daemon\dist\cli.js daemon` | 路径里的 **WeMind** |
| 全局安装（scope 包） | `…\npm\node_modules\@wemind\cli\dist\cli.js daemon` | `@wemind` 里的 **wemind** |
| 项目本地安装 | `…\node_modules\@wemind\cli\dist\cli.js daemon` | 同上（Windows npm shim 走 `…/@wemind/cli/dist/cli.js`） |
| 源码开发期 PowerShell wrapper | `pwsh -File …\run-daemon.ps1` | 第二组 marker |

> 注意：**不要**改成 `@wemind/cli` + `cli.js`。Windows 上 npm 的 shim 走短路径 `…/@wemind/cli/dist/cli.js`（不保证出现 scope 前缀形态），用 `wemind` 这个子串同时覆盖 scope 全路径与短路径，更稳。

**取舍**：`wemind` 是较宽的词（理论上任何含 `wemind` 且含 `cli.js` 的命令行都会被认作我们）。但 `matchesMarkers` 是 AND（两个 token 同时出现），实际误判窗口极小；相比之下「认不出自己」的代价（杀不掉、双开）大得多。单测已覆盖三种路径 + 反例。

### 4.4 `src/manage.ts`：提示与自解析

- 两处 `node packages/wechat-daemon/dist/manage.js …` → `wemind …`。
- `startDaemon()` 的 cli 路径改用 `process.argv[1]`（`import.meta.url` 目录作兜底）：发布后 tsdown 内联成单文件时两者相同，但将来拆 chunk 时只有 `argv[1]` 是「用户装的那个 bin」。
- 新增 `version` / `--version` / `-v` 子命令；help 头部带版本号与包名。

### 4.5 新增 `src/version.ts` + `src/version.test.ts`

`CLI_VERSION` / `CLI_PKG_NAME` 常量 + `versionLine()`：

```
wemind 1.0.0 (@wemind/cli, node 24.21.0, win32-x64)
```

单测校验四个不变量：`CLI_VERSION == package.json.version`、`CLI_PKG_NAME == package.json.name`、**`name` 必须是 `@wemind/cli` 且 `bin` 必须叫 `wemind`**（防止有人「顺手」把 bin 也改成 `@wemind/cli`）、`versionLine()` 含命令名与包名。

### 4.6 新增 `scripts/prepack-guard.mjs`

`npm pack`/`publish` 前检查：`files` 里每个目录存在且非空、`bin` 指向的文件存在且带 shebang。不满足 → **exit 1**，从源头杜绝空壳包。

### 4.7 新增 `scripts/check-version.mjs`

校验：包名 = `@wemind/cli`、`bin` 含 `wemind`、`CLI_VERSION`/`CLI_PKG_NAME` 与 `package.json` 一致、lock 里 `packages/wechat-daemon` 的 `name`/`version` 一致。已实测：故意不同步时它会报错，`npm install` 后转绿。

### 4.8 新增 `.github/workflows/wemind-publish.yml`

复刻 `wechat-mcp-publish.yml` 的成熟流程，并加两道专属关卡：

```
check-version（包名+版本一致性）→ npm ci → lint → format:check → typecheck → build → test
→ npm pack --dry-run -w @wemind/cli              （prepack 守卫挡空壳）
→ pack + 装到临时目录跑 wemind version / help    （真装真跑冒烟；tgz 名是 wemind-cli-<ver>.tgz）
→ 已发布则跳过 → npm publish --workspace @wemind/cli --provenance --access public
```

权限：`id-token: write`（npm Trusted Publishing + provenance），无长期 token。

### 4.9 `packages/wechat-daemon/README.md` 重写

从「源码包里的一张说明」改成**面向 npm 用户的落地页**：标题就是 `@wemind/cli — 命令 wemind`、安装（含「`npx` 必须写全包名」的显式提醒）、三步上手、命令表、常驻原理、数据与安全（`--trust-all-tools` 的告警必须显眼）、环境变量、与 MCP 形态的对比、文档外链。

---

## 5. 一致性约束（发布期必须守住）

1. **`dist/` 永不入库**（`.gitignore` 已忽略），产物只由 CI 的 `npm run build` 生成 → `prepack` 守卫兜底。
2. **包名与版本同步**：改版本只改 `packages/wechat-daemon/package.json`，然后同步 `src/version.ts` 与 `npm install` 刷新 lock（`check-version` 会卡住 CI）。
3. **包名与命令名解耦，且都要守**：包名 `@wemind/cli`、命令 `wemind`。改任何一处都要同时看 README、`npx` 示例、CI 的 workspace 参数、`check-version.mjs`。
4. **内核改动要重新发布 `@wemind/cli`**：内核是内联的，`packages/wechat-ilink-core/**` 变更会触发本 workflow（paths 已包含）。
5. **`engines.node: ">=20"`** 是承诺：构建 target 也是 `node20`；DSH CLI 这类大脑需要 node ≥22，那是**用户侧大脑**的要求，不写进本包 `engines`。
6. **`@wemind/wechat-mcp` 与 `@wemind/cli` 各自独立版本**，互不引用。

---

## 6. 发布前检查清单（人执行）

### 6.1 核名（一次性，必须先做）

```bash
npm view @wemind/cli version        # 应报 404：确认这个包名没被（你自己或别人）占用
npm view @wemind/cli@1.0.0 version  # 应报 404：确认 1.0.0 未发过
npm whoami                          # 确认已登录且有 @wemind scope 的发布权限
```

> 与之前不同：这里**不需要**再核 `wemind` 短名 —— 我们不再用那个名字。

### 6.2 本地全绿

```bash
npm install
npm run check:version      # 包名 + 版本一致
npm run lint && npm run typecheck && npm run build && npm test
npm run verify:publish      # build + 两个包的 npm pack --dry-run
```

### 6.3 真装冒烟（不必碰真实账号）

```bash
npm pack --workspace @wemind/cli --pack-destination "$TEMP"
# scope 包打包后文件名是 wemind-cli-1.0.0.tgz（不是 @wemind/cli-…）
mkdir smoke && cd smoke && npm init -y && npm i "$TEMP/wemind-cli-1.0.0.tgz"
./node_modules/.bin/wemind version   # → wemind 1.0.0 (@wemind/cli, node …)
./node_modules/.bin/wemind help
```

### 6.4 Trusted Publishing 绑定（一次性）

npmjs.com → `@wemind/cli` 包设置 → Trusted Publisher 选 GitHub Actions：

| 字段 | 值 |
| --- | --- |
| Organization / User | `imwangpan` |
| Repository | `WeMind` |
| Workflow filename | `wemind-publish.yml` |
| Environment | 留空 |

> 首次发布若包**还不存在**，npm 不允许配置 Trusted Publisher（与你发布 `@wemind/wechat-mcp` 时的情况一样）。两个办法：① 本地 `npm publish --workspace @wemind/cli --access public` 发一次 1.0.0，之后配 TP 交给 CI；② 先发 `1.0.0-rc.1` 占位，配好 TP 后由 CI 发正式版。**推荐 ①**，与 `wechat-mcp` 的历史做法一致。

### 6.5 发布后验收

```bash
npm i -g @wemind/cli@1.0.0 && wemind version    # → wemind 1.0.0 (@wemind/cli, …)
wemind list                      # 应正确显示「运行中(pid …)」（验证 P2 修复）
wemind task "echo hi"            # daemon 在跑时应能派发
npx -y @wemind/cli list          # 验证「npx 写全包名」这条路
```

---

## 7. 回滚与善后

- npm 侧：24h 内可 `npm unpublish @wemind/cli@1.0.0`（建议只在「包完全不可用」时用）；否则 `npm deprecate @wemind/cli@1.0.0 "原因"` 并尽快发 1.0.1。
- 已装用户：`npm i -g @wemind/cli@<上一版>`。
- 数据兼容：本方案**不改**任何 `~/.wemind/<账号>/` 文件的格式与路径，升级/回滚都不影响登录态与沙箱。

---

## 8. 还需要「人」做的动作（代码之外）

1. **§6.1 核名**：确认 `@wemind/cli` 未被占用（我无法联网核查）。
2. 配 Trusted Publisher（§6.4），或用本地首发的过渡方式。
3. 合并后 `push main` → 观察 `Publish @wemind/cli` workflow 首次运行。

---

## 9. 风险与备选

**A. `npx` 手感变化**（本次命名方案的唯一代价）：`npx wemind` 不可用，必须 `npx -y @wemind/cli`；`npm i -g` 后命令不受影响。README / help / 文档已全部按包名写全。

**B. 用户机器上没有 ACP agent**：`wemind daemon` 会以退出码 78 失败并停止自动重启（已有设计），`wemind brain`/`brain check` 会给出可操作提示。**建议首发后观察**是否需要在 `wemind login` 后主动跑一次 `brain check` 并提示安装大脑（当前不做，避免拖慢登录）。

**C. 进程身份新规则与旧进程**：旧版（从未发布）用 `wechat-daemon` marker；本机在跑的 daemon 命令行是 `…\WeMind\packages\wechat-daemon\dist\cli.js`，靠 **WeMind** 命中，**无需重启**即可被新 CLI 识别（已实测 `wemind list` 显示「运行中(pid 18468)」）。从「别处 clone、目录名不含 wemind」启动的旧进程会认不出——个体重启一次即可。

**D. 若以后仍想占住 `wemind` 短名**：可以用 `bin` 为空的 `wemind` 包做「指向 `@wemind/cli` 的提示包」（不推荐：多一个要维护的包）。当前不做。

**E. Windows 上 `npm i -g` 的 shim**：`bin` 生成 `wemind.cmd`，其内容为 `exec node "…/node_modules/@wemind/cli/dist/cli.js"` —— 正好命中新的身份特征（单测已按该路径形态断言）。

---

## 10. 实施顺序（建议的落地节奏）

| 步骤 | 内容 | 谁做 |
| --- | --- | --- |
| 1 | 本分支代码 + 文档 + workflow（已完成；根包名已按要求保持 `wemind`） | AI ✅ |
| 2 | 本地 §6.2 / §6.3 全绿（lint/typecheck/build/test/pack/装包冒烟） | AI ✅ |
| 3 | 核名 `@wemind/cli`（§6.1） | **人** |
| 4 | 本地首发 1.0.0（或先 TP 再 CI 首发） | **人** |
| 5 | 配 Trusted Publisher，push main 验证 workflow | **人** |
| 6 | 发布后验收 §6.5 + 真机微信收发一条消息 | **人** |
