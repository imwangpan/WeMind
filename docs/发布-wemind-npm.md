# wemind 独立发布方案（npm）

> 分支：`feat/wemind-npm-publish` ｜ 目标包：`wemind`（源码 `packages/wechat-daemon/`）｜ 计划首发版本：**1.1.0**
>
> 本文件既是**方案**也是**实施记录**：§4 起的代码改动已在分支上落地并通过本地验证，§8 列出「还需要人做」的一次性动作。

---

## 1. 现状盘点（分析结论）

### 1.1 仓库里「三个包」的角色

| 包 | 目录 | 发布状态 | 说明 |
| --- | --- | --- | --- |
| `@wemind/wechat-ilink-core` | `packages/wechat-ilink-core` | 私有，**永不发布** | iLink 协议内核；被另两个包**构建时内联**（`alwaysBundle`），不是运行时依赖 |
| `@wemind/wechat-mcp` | `packages/wechat-mcp` | **已发布**（1.0.4） | MCP server，bin `wemind-mcp`，已有 `wechat-mcp-publish.yml` |
| `wemind` | `packages/wechat-daemon` | **未发布** | 本方案的对象：常驻 daemon + ACP 大脑 + worker + 多账号 CLI，bin `wemind` |

结论：`wemind` **不需要拆仓**。它的运行时依赖只有 `qrcode`（第三方）＋内核（已内联），产物是**单文件 `dist/cli.js`（约 155 KB）**，具备「装了就独立跑」的前提。

### 1.2 阻塞发布的 5 个问题（已定位到具体行）

| # | 问题 | 证据 | 后果 |
| --- | --- | --- | --- |
| P1 | **根包与发布包同名 `wemind`** | 根 `package.json` `"name": "wemind", private: true`，workspace 里也有 `wemind` | `npm publish -w wemind` / `-w wemind` 在工作区歧义；根包 private 时 `-w` 可能解析到根包（无 `bin`）。发布脚本不可靠 |
| P2 | **进程身份特征写死源码目录名** | `proc-identity.ts`：`CLI_PID_MARKERS = [["wechat-daemon","cli.js"], …]` | 发布后命令行是 `…/node_modules/wemind/dist/cli.js`，**匹配不上** → `wemind list` 永远「已停止」、`stop` 杀不掉、看门狗单实例守卫失效（可能双开抢 token） |
| P3 | **用户可见提示指向源码路径** | `manage.ts` 两处 `node packages/wechat-daemon/dist/manage.js …` | 全局安装的用户照抄命令必然失败 |
| P4 | **无 `repository`/`homepage`/`author`** | `packages/wechat-daemon/package.json` | npm 页面无源码链接、无 provenance 校验基线；与 `wechat-mcp` 不一致 |
| P5 | **没有发布流水线、没有产物守卫** | 只有 `wechat-mcp-publish.yml` | 忘记 build 时会发出「只有 package.json」的空壳包（`bin` 指向不存在的 `dist/cli.js`），装上即 `MODULE_NOT_FOUND` |

> 附：`wemind version` 之前不存在（只有 help），排查用户问题（哪版、哪个 node）时缺最基本信息。

---

## 2. 发布定位与命名决策

- **包名 `wemind`**：短、与命令同名（`npx wemind …` 直接可用），已由仓库根 `package.json` 的 description 与 `docs/wemind-CLI化设计.md` 规划。
  - 风险：npm 上可能已被他人占用。**发布前必须先核名**（§6.1）；若被占，回退方案见 §9-D。
- **版本 `1.1.0`**：源码内部此前一直叫 1.0.1，但从未发布；既然这是**首次面向公众的 CLI 契约**（新增 `version` 子命令、README 重写、进程身份规则变化），用 1.1.0 而不是 1.0.x，给后续 bug 修复留 1.1.x。
- **不发布内核**：保持 `private: true`，继续内联。理由：内核 API 仍可能随协议变化；对外只需要「MCP server」与「CLI」两个入口。
- **两个发布入口互斥**：同一个 bot token 只能有一个消费者（`wemind` daemon 或 `@wemind/wechat-mcp`），README 已写明。

---

## 3. 目标状态

```
npm i -g wemind
wemind login --label 主号 --start   →  微信扫码 → 常驻守护 + ACP 大脑
wemind list / brain check / task …  →  全部命令自洽（不再出现源码路径）
npm publish（CI，push main）        →  一次发布 = 构建产物 + prepack 守卫 + 装包冒烟 + provenance
```

---

## 4. 代码改动清单（已在本分支实施）

### 4.1 根 `package.json`：根包改名 `wemind-monorepo`

- `name: wemind` → `wemind-monorepo`（仍 `private: true`），并加 `$comment` 说明**为什么不能同名**。
- 新增脚本：`check:version`、`verify:publish`。
- 副作用：`npm -w wemind …` 从此唯一指向 `packages/wechat-daemon`（已实测 `npm ls -w wemind` 只列该包）。

### 4.2 `packages/wechat-daemon/package.json`：发布元数据

- `version` → `1.1.0`；`description` 去掉过时的「默认 kiro-cli」（现为 auto 探测）。
- 补 `repository`（含 `directory`）、`homepage`、`bugs`、`author`，与 `wechat-mcp` 保持一致。
- `keywords` 增加 `wemind` / `daemon` / `cli`。
- 新增 `prepack` **产物守卫**：`node ../../scripts/prepack-guard.mjs .`
- `files` 保持 `["dist"]`；`bin` 保持 `{ "wemind": "dist/cli.js" }`（`tsdown` 会保留 shebang 并 chmod +x）。

### 4.3 `src/proc-identity.ts`：进程身份特征改为 `wemind` + `cli.js`

```ts
export const CLI_PID_MARKERS: string[][] = [["wemind", "cli.js"], ["run-daemon.ps1"]];
```

覆盖三种安装方式（注释里写清）：

| 场景 | 命令行 | 命中原因 |
| --- | --- | --- |
| 源码仓库 | `…\WeMind\packages\wechat-daemon\dist\cli.js daemon` | 路径里的 **WeMind** |
| 全局/本地安装 | `…\node_modules\wemind\dist\cli.js daemon` | 包目录 **wemind** |
| 源码开发期 PowerShell wrapper | `pwsh -File …\run-daemon.ps1` | 第二组 marker |

**取舍**：`wemind` 是更宽的词（理论上任何含 `wemind` 且含 `cli.js` 的命令行都会被认作我们）。但 `matchesMarkers` 是 AND（两个 token 同时出现），实际误判窗口极小；相比之下「认不出自己」的代价（杀不掉、双开）大得多。单测已覆盖三种路径 + 反例。

### 4.4 `src/manage.ts`：提示与自解析

- 两处 `node packages/wechat-daemon/dist/manage.js …` → `wemind …`。
- `startDaemon()` 的 cli 路径改用 `process.argv[1]`（`import.meta.url` 目录作兜底）：发布后 tsdown 内联成单文件时两者相同，但将来拆 chunk 时只有 `argv[1]` 是「用户装的那个 bin」。
- 新增 `version` / `--version` / `-v` 子命令；help 头部带版本号。

### 4.5 新增 `src/version.ts` + `src/version.test.ts`

`CLI_VERSION` 常量 + `versionLine()`；单测**读 `package.json` 校验两者一致**（防止「发了新版、`wemind version` 还报旧版」）。

### 4.6 新增 `scripts/prepack-guard.mjs`

`npm pack`/`publish` 前检查：`files` 里每个目录存在且非空、`bin` 指向的文件存在且带 shebang。不满足 → **exit 1**，从源头杜绝空壳包。

### 4.7 新增 `scripts/check-version.mjs`

校验三处版本一致（`package.json` / `src/version.ts` / `package-lock.json`）＋ 根包不得与工作区包同名。已实测：故意不同步时它会报错，`npm install` 后转绿。

### 4.8 新增 `.github/workflows/wemind-publish.yml`

复刻 `wechat-mcp-publish.yml` 的成熟流程，并加两道 `wemind` 专属关卡：

```
check-version → npm ci → lint → format:check → typecheck → build → test
→ npm pack --dry-run -w wemind          （prepack 守卫挡空壳）
→ pack + 装到临时目录跑 wemind version / help   （真装真跑冒烟）
→ 已发布则跳过 → npm publish --workspace wemind --provenance --access public
```

权限：`id-token: write`（npm Trusted Publishing + provenance），无长期 token。

### 4.9 `packages/wechat-daemon/README.md` 重写

从「源码包里的一张说明」改成**面向 npm 用户的落地页**：安装、三步上手、命令表、常驻原理、数据与安全（`--trust-all-tools` 的告警必须显眼）、环境变量、与 MCP 形态的对比、文档外链。

---

## 5. 一致性约束（发布期必须守住）

1. **`dist/` 永不入库**（`.gitignore` 已忽略），产物只由 CI 的 `npm run build` 生成 → `prepack` 守卫兜底。
2. **版本三处同步**：改版本只改 `packages/wechat-daemon/package.json`，然后同步 `src/version.ts` 与 `npm install` 刷新 lock（`check-version` 会卡住 CI）。
3. **内核改动要重新发布 `wemind`**：内核是内联的，`packages/wechat-ilink-core/**` 变更会触发本 workflow（paths 已包含）。
4. **`engines.node: ">=20"`** 是承诺：构建 target 也是 `node20`；DSH CLI 这类大脑需要 node ≥22，那是**用户侧大脑**的要求，不写进本包 `engines`。
5. **`wemind-mcp` 与 `wemind` 各自独立版本**，互不引用。

---

## 6. 发布前检查清单（人执行）

### 6.1 核名（一次性，必须先做）

```bash
npm view wemind version          # 若返回版本号 → 名字被占，走 §9-D
npm view wemind@1.1.0 version     # 应报 404（确认 1.1.0 未发过）
```

### 6.2 本地全绿

```bash
npm install
npm run check:version     # 版本三处一致
npm run lint && npm run typecheck && npm run build && npm test
npm run verify:publish     # build + 两个包的 npm pack --dry-run
```

### 6.3 真装冒烟（不必碰真实账号）

```bash
npm pack --workspace wemind --pack-destination "$TEMP"
mkdir smoke && cd smoke && npm init -y && npm i "$TEMP/wemind-1.1.0.tgz"
./node_modules/.bin/wemind version      # → wemind 1.1.0 (node …)
./node_modules/.bin/wemind help
```

### 6.4 Trusted Publishing 绑定（一次性）

npmjs.com → 包设置 → Trusted Publisher 选 GitHub Actions：

| 字段 | 值 |
| --- | --- |
| Organization / User | `imwangpan` |
| Repository | `WeMind` |
| Workflow filename | `wemind-publish.yml` |
| Environment | 留空 |

> 首次发布若包**还不存在**，npm 不允许配置 Trusted Publisher。两个办法：① 本地 `npm publish --workspace wemind --access public` 发一次 1.1.0，之后切到 CI；② 先发一个 `1.1.0-rc.1` 预发布占位，配好 TP 后由 CI 发正式版。**推荐 ①**，与 `wechat-mcp` 的历史做法一致。

### 6.5 发布后验收

```bash
npm i -g wemind@1.1.0 && wemind version
wemind list                      # 应正确显示「运行中(pid …)」（验证 P2 修复）
wemind task "echo hi"            # daemon 在跑时应能派发
```

---

## 7. 回滚与善后

- npm 侧：24h 内可 `npm unpublish wemind@1.1.0`（建议只在「包完全不可用」时用）；否则 `npm deprecate wemind@1.1.0 "原因"` 并尽快发 1.1.1。
- 已装用户：`npm i -g wemind@<上一版>`。
- 数据兼容：本方案**不改**任何 `~/.wemind/<账号>/` 文件的格式与路径，升级/回滚都不影响登录态与沙箱。

---

## 8. 还需要「人」做的动作（代码之外）

1. **§6.1 核名**：`wemind` 在 npm 上是否可用（我无法代你判断，需联网核）+ 1.1.0 是否已存在。
2. 配 Trusted Publisher（§6.4），或用本地首发的过渡方式。
3. 决定是否把 `wemind` 加进 README 顶层「安装方式」章节（根 README 目前以源码仓库为主，本方案未改根 README，避免与 MCP 形态的说明冲突）。
4. 合并后 `push main` → 观察 `Publish wemind` workflow 首次运行。

---

## 9. 风险与备选

**A. 包名被占** → 见 D。

**B. 用户机器上没有 ACP agent**：`wemind daemon` 会以退出码 78 失败并停止自动重启（已有设计），`wemind brain`/`brain check` 会给出可操作提示。**建议首发后观察**是否需要在 `wemind login` 后主动跑一次 `brain check` 并提示安装大脑（当前不做，避免拖慢登录）。

**C. 进程身份新规则与旧进程不兼容**：旧版（未发布）用 `wechat-daemon` marker；本分支已在跑的用户 daemon 命令行是 `…\WeMind\packages\wechat-daemon\dist\cli.js`，靠 WeMind 命中，**无需重启**即可被新 CLI 识别（已实测 `wemind list` 显示「运行中」）。但从「别处 clone 的目录名不含 wemind」启动的旧进程会认不出——这种个体重启一次即可。

**D. `wemind` 名字不可用的回退**：按优先级 ① `@wemind/cli`（需 scope 权限）② `wemind-cli` ③ `@wemind/wemind`。**命令名可以继续叫 `wemind`**（`bin` 字段与包名无关），只需改 `name` + `publishConfig.access`，workflow 与守卫全部复用。

**E. Windows 上 `npm i -g` 的 shim**：`bin` 生成 `wemind.cmd`，其内容为 `exec node "…/node_modules/wemind/dist/cli.js"` —— 正好命中新的身份特征（已在 §4.3 单测里以该路径形态断言）。

---

## 10. 实施顺序（建议的落地节奏）

| 步骤 | 内容 | 谁做 |
| --- | --- | --- |
| 1 | 本分支代码 + 文档 + workflow（已完成） | AI ✅ |
| 2 | 本地 §6.2 / §6.3 全绿（local 已跑通 lint/typecheck/build/test/pack/装包冒烟） | AI ✅ |
| 3 | 核名 + 1.1.0 是否已存在（§6.1） | **人** |
| 4 | 本地首发 1.1.0（或先 TP 再 CI 首发） | **人** |
| 5 | 配 Trusted Publisher，push main 验证 workflow | **人** |
| 6 | 发布后验收 §6.5 + 真机微信收发一条消息 | **人** |
