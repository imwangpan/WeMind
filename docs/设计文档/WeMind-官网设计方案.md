# WeMind 官网设计方案

> **最后核对**：2026-11-26 ｜ **状态**：M4 已完成——GitHub Pages 已部署，线上首页/中文文档/英文文档/静态资源均 200；Cloudflare 暂缓（可选）；下一步 M5 ｜ **适用分支**：`main`
>
> 本文描述官网的定位、信息架构、技术方案与实施顺序；语言、托管、工具链已按 B 方案收口，视觉与首页文案已按本轮定稿落地。文中标「待实测」的结论，实施时必须用真实构建/部署验证。

## 0. 一句话

给 WeMind 做一个公开的产品官网：**一个首页讲清楚「微信 → AI agent → 微信」这条链路，一套文档让人能当天跑起来**；纯静态、免费托管、不需要服务器。首版中文首页 + 英文文档，首页可在 `/` 原地切换中英文，不设 `/en/` 英文首页。

## 1. 背景与目标

### 1.1 背景

- WeMind 已有两个发布到 npm 的形态：MCP Server（`@wemind/wechat-mcp`）与 daemon（`@wemind/cli`，命令 `wemind`）。
- 仓库里的 `docs/` 有约 60 篇中文文档，但主要面向维护者/AI，包含大量内部设计、审查记录和待办，不能直接整站公开。
- 目前没有官网、没有 logo、没有产品截图；README 已经能说明能力，但首次访问者缺少一个「30 秒看懂 + 5 分钟接入」的入口。

### 1.2 目标

1. **30 秒讲清楚**：访问者不打开终端，也能理解 WeMind 解决什么问题。
2. **5 分钟跑起来**：从首页到「安装、登录、发第一条消息」的路径不超过 3 次点击。
3. **文档可信**：公开文档只保留用户需要的内容，命令、参数、环境变量与当前分支一致。
4. **视觉可信**：首页有明确的动效与产品演示，但不牺牲移动端性能和可访问性。
5. **维护成本低**：静态构建、免费托管、一个 workflow 部署；不需要数据库和后端。

### 1.3 非目标

- 不做 Web 控制台（账号管理、会话管理、实时日志）——那是未来的 `apps/console`，需要 daemon 提供本地 API。
- 不做在线试玩后端；首页的聊天演示是固定脚本，不连接真实微信。
- 不把 `docs/` 全量搬到网站；内部设计、审查、待办、AI 上下文不公开。
- 不做 `/en/` 英文首页；首版只做中文首页 + 英文文档（`/en/guide`），首页在 `/` 原地中英切换；英文首页没有独立 URL、不被单独收录。
- 不做浏览器语言自动切换；首次访问默认中文，只有用户手动切 EN 才保存偏好。
- 不承诺「国内稳定访问」；Q3 的共识是尽量直连、不备案。

## 2. 已确认决策

| 编号 | 决策         | 结论                                                                      | 状态   |
| ---- | ------------ | ------------------------------------------------------------------------- | ------ |
| Q1   | 网站范围     | 产品落地页 + 文档一体                                                     | 已确认 |
| Q2   | 目标读者     | 中文技术用户为主，兼顾非技术用户的快速开始                                | 已确认 |
| Q3   | 大陆访问     | 尽量直连，不备案；接受免费托管的不稳定                                    | 已确认 |
| Q4   | 域名         | 先用免费子域，之后再买正式域名                                            | 已确认 |
| Q5   | 仓库位置     | 主仓 monorepo 的 `apps/website`                                           | 已确认 |
| Q6   | 站点框架     | VitePress 2.0 线（当前 `2.0.0-alpha.21`）                                 | 已确认 |
| Q7   | 语言方案     | B：`/` 中文首页原地切英文；不做 `/en/` 英文首页；英文文档走 `/en/guide`   | 已确认 |
| Q8   | 英文首页范围 | 全量翻译，不只 hero；导航、页脚、meta、demo、a11y 文案都要英文            | 已确认 |
| Q9   | 英文文档范围 | 首批 7 篇：getting-started、commands、sessions、tasks、brain、agents、faq | 已确认 |
| Q10  | 默认语言     | 首次访问默认中文，不读浏览器语言；手动切 EN 才保存偏好                    | 已确认 |
| Q11  | 语言开关     | 全站一个自定义开关；首页切状态，文档页走路由                              | 已确认 |
| Q12  | 未翻译页     | 点 EN 回 `/en/guide/` 并提示；不生成占位页                                | 已确认 |
| Q13  | 检查工具     | Vite+ 1.8.0 只做 check/lint/fmt/test，不做 dev/build                      | 已确认 |
| Q14  | `cleanUrls`  | GitHub Pages 用 `false`（无扩展名无法重写）；本地/Cloudflare 可 `true`    | 已确认 |
| Q15  | 部署路径     | 仓库名保持 `WeMind`，GitHub Pages `base=/WeMind/`                         | 已确认 |
| —    | 首页叙事     | S1 一条消息的旅程；S2 远程任务作为其中一幕；S3/S4 放在下方                | 已确认 |

> Q6 的「2.0」目前是 alpha 线。方案按 `2.0.0-alpha.21` 锁定精确版本；如果实施时遇到阻塞，回退 `1.6.4` 只作为应急，不改变信息架构和组件设计。Q13 的 Vite+ 只做检查层，不替代 VitePress 的构建/SSG。

## 3. 技术选型

### 3.1 为什么是 VitePress 2.0

- 站点以 Markdown 文档为主，VitePress 的默认主题已经把侧边栏、搜索、暗色模式、上一篇/下一篇、编辑链接、SEO 基础做好。
- 首页需要完全自定义，但不需要整站换框架；VitePress 允许 `layout: page` + 自定义 Vue Layout，首页可以写任意 Vue/CSS/JS，文档页继续用默认主题。
- 与 Q6 的结论一致；不再引入 Astro/React 的第二套构建链。
- 2.0 线使用 Vite 8 / Vue 3.5，构建速度和新特性更好；代价是 alpha 稳定性，必须锁版本、跑构建、保留回退路径。

### 3.2 版本与运行环境

截至 2026-11-25 的 npm 事实：

- `vitepress@2.0.0-alpha.21`
- 依赖 `vite@8.3.4`、`vue@^3.5.43`、`shiki@^4.5.0`、`minisearch@^7.2.0`
- 站点当前安装 `vite@8.3.8`、`vue@3.5.46`、`@lingui/*@6.12.0`、`@babel/core@7.29.13`、`@rolldown/plugin-babel@0.3.1`
- `vite@8.3.8` 的 `engines` 为 `^20.19.0 || >=22.12.0`
- `vitepress@2.0.0-alpha.21` 自身没有声明 `engines`，以 Vite 8 的约束为准
- `vite-plus@1.8.0` 的 `engines` 为 `^22.18.0 || ^24.11.0 || >=26.0.0`；自带 `vite` 别名 `@voidzero-dev/vite-plus-core@8.3.8001`、`oxlint@1.94`、`oxfmt@0.79`、`vitest@5.1.1`

仓库在 2026-11-24 把最低 Node 统一到 **24.11**，因此：

- 本地与 CI 统一使用 **Node 24.11**（根 `package.json` 的 `engines` 为 `>=24.11.0`；Vite 8 的最低要求是 `^20.19.0 || >=22.12.0`，24.11 满足）。
- `apps/website/package.json` 写 `"engines": { "node": ">=24.11.0" }`。
- 站点独立 `package.json` + 独立 `package-lock.json`，**不加入根 `workspaces`**；根 `npm install` / `npm run verify` 不覆盖站点，站点有单独的 CI 与构建命令。
- Vite+ 只做检查层：`apps/website` 加 `vite-plus@1.8.0` devDependency + `vite.config.ts`（只写 `lint`/`fmt`/`test`），脚本为 `check: vp check`、`lint: vp lint`、`fmt: vp fmt`、`test: vp test`；`vitepress dev/build/preview` 仍由 VitePress 自己跑，不跑 `vp run build`。Vite+ 自带的 Oxc 比仓库根旧一版（1.94/0.79 vs 1.95/0.80），已接受；不把 `vite-plus` 装到根，避免两套 Vite 抢依赖。
- `vite-plus` 的 `vite` 别名不能替代 VitePress 的构建链；VitePress 的 Vite 版本仍以 `vitepress@2.0.0-alpha.21` 的依赖为准。M1 已验证 Vite+ 的检查层与 VitePress 的 Vite 8.3.8 构建可以共存。

### 3.3 为什么还要一个包名

`package.json` 的 `name` 是 npm 的包标识，不是「要发布」的意思：

- 即使 `private: true`，npm 仍需要一个 `name` 来写 lockfile、跑 `npm run`、在依赖树里标识这个项目。
- 本站不是库，不会被任何包 import，也不会发布到 npm；用 `wemind-website` 就够，不需要 `@wemind/website` 这种 scope。
- `private: true` 的作用是防误发布：`npm publish` 会直接拒绝。
- 如果以后 `apps/website` 要加入根 workspaces，再改成 `@wemind/website` 也不迟；现在没有这个必要。

推荐：

```json
{
  "name": "wemind-website",
  "private": true,
  "type": "module"
}
```

> `apps/website/package.json` 已改为 `wemind-website`；两者都 `private: true`，都不发布。

### 3.4 base 是什么，为什么要环境变量

已定：仓库名保持 `WeMind`，GitHub Pages 项目页用 `base=/WeMind/`，不为了小写 URL 改仓库名（§3.5/§3.6）。`base` 是**站点部署在域名下的哪个路径**。它会影响：

- JS/CSS/字体等资源的 URL；
- 路由跳转的前缀；
- 自定义组件里手写绝对路径的资源。

同一个站点可能部署到两种路径：

| 托管方式            | 访问地址                           | `base`     |
| ------------------- | ---------------------------------- | ---------- |
| 本地开发            | `http://localhost:5173/`           | `/`        |
| Cloudflare Pages    | `https://wemind.pages.dev/`        | `/`        |
| GitHub Pages 项目页 | `https://<user>.github.io/WeMind/` | `/WeMind/` |
| 自定义域名根路径    | `https://wemind.dev/`              | `/`        |

所以配置里用构建时环境变量：

```ts
const base = (process.env.DOCS_BASE ?? "/").replace(/\/?$/, "/");

if (!base.startsWith("/")) {
  throw new Error(`DOCS_BASE must start with "/": ${base}`);
}
```

构建命令：

```bash
# 本地 / Cloudflare / 自定义域名
npm run build

# GitHub Pages 项目页
DOCS_BASE=/WeMind/ npm run build
```

注意：`base` 是构建时配置，不是运行时开关；部署到哪个路径，就要用对应的 `base` 重新构建。不要把它当成用户可配置的环境变量写进文档。

### 3.5 `/WeMind/` 的大小写

有影响，而且是一个容易在本地漏掉的坑：

- GitHub Pages 的项目路径来自仓库名 `WeMind`，访问地址是 `https://<user>.github.io/WeMind/`。
- GitHub Pages 跑在 Linux 文件系统上，路径大小写敏感；`/wemind/` 可能 404，`/WeMind/` 才是对的。
- Windows 本地文件系统不区分大小写，所以本地 `base: '/wemind/'` 可能看起来正常，部署后才暴露。
- 自定义域名根路径部署时，`base` 是 `/`，不存在这个问题。

因此：

- `base` 必须与部署路径完全一致，包括大小写和结尾 `/`。
- 首版用 `DOCS_BASE` 显式传入，不在代码里硬编码 `/WeMind/`。
- 部署后必须真实访问一次首页、一篇文档、一个静态资源（favicon/OG），确认没有 404。

### 3.6 要不要同时支持 `/wemind/` 和 `/WeMind/`

**不要把它当成一个需要支持的功能。** GitHub Pages 的项目页路径由仓库名决定，没有给你配置「大小写别名」的入口；大小写变体即使偶尔被平台归一化，也不能当成稳定契约。

- 仓库叫 `WeMind`，GitHub Pages 的规范路径就是 `/WeMind/`；`base` 写 `/wemind/` 会让资源全部 404。
- 如果只选一个，**URL 惯例上小写更好**（好输入、少出错、和 `wemind` 命令一致），但前提是把仓库改名为 `wemind`；改名后旧 `/WeMind/` 链接不保证还能用，README、badges、文档里的仓库链接要一起改。
- 如果不想改仓库名，就保留 `/WeMind/`，不要为了「两个都能开」去加 `404.html` 里的 JS 跳转：它先返回 404，对搜索引擎和可靠性都不好。
- 真正干净的做法是不使用项目子路径：Cloudflare Pages 根路径或自定义域名根路径，`base` 是 `/`，大小写问题不存在。

结论：首版用 GitHub Pages 的 `/WeMind/`，Cloudflare Pages 后补；除非决定把仓库正式改名为 `wemind`，否则不做双路径。

## 4. 信息架构

### 4.1 路由

```text
/                         首页（中文；可原地切英文）
/en/                     静态跳转页 -> /en/guide/（noindex，不是英文首页）

/guide/                   中文使用指南入口
/guide/getting-started    安装、登录、启动、发第一条消息
/guide/commands           微信指令与 CLI 命令
/guide/sessions           会话：新建、恢复、重命名、删除
/guide/tasks              远程任务：worker、进度、续跑、停止
/guide/brain              大脑：切换 Agent、模型、MCP
/guide/media              图片、文件、视频、语音
/guide/autostart          开机自启与常驻
/agents/                  支持的 Agent 与接入方式
/agents/custom            自定义 Agent 定义（进阶）
/reference/cli            CLI 子命令参考
/reference/wechat         微信指令参考
/reference/env            环境变量
/reference/data           数据目录与文件
/faq/                     常见问题

/en/guide/                英文文档入口（不是英文营销首页）
/en/guide/getting-started
/en/guide/commands
/en/guide/sessions
/en/guide/tasks
/en/guide/brain
/en/guide/agents
/en/guide/faq
```

首版不设 `/docs/` 前缀，直接 `/guide`、`/reference`；如果以后需要把文档收进 `/docs`，用 VitePress 的 `rewrites` 迁移，不改内容。英文只列 7 篇已翻译页；其余中文独有页面不生成英文占位 URL。

`/changelog` 不单独维护，直接链接 GitHub Releases；避免和 `CHANGELOG.md` 双份维护。

### 4.2 导航

M3 实际导航在 M2 最小集上扩展，不挂空链接：

- 左侧品牌 `WeMind` → `/`（英文文档页也回 `/`，并把偏好记成 EN）
- 顶部 nav：快速开始、接入 Agent、参考、FAQ、GitHub；中文/英文各一份，英文只列已翻译入口
- 右侧自定义「文档 / Docs」→ 当前语言对应的文档入口（`/guide/` 或 `/en/guide/`）
- 右侧自定义语言开关（`中文 | EN`）
- 首页底部：文档、GitHub、免责声明；英文首页同样全英文

中文 sidebar 分组为「开始 / 使用 / 接入 / 参考 / 常见问题」，共 14 个链接、5 组；英文 sidebar 只列 7 篇正文 + Docs Home。中文 sidebar 是跨 `/guide`、`/agents`、`/reference`、`/faq` 共用的一份完整侧栏，不按路由缩成单组；所有分组 `collapsed: false`，默认展开、标题可点击折叠；当前页用浅松绿底、左侧松绿竖线、松绿 600 字重高亮。移动端「本页目录」点击任一子项后自动收起。桌面端侧栏「开始」分组上方右侧提供整体收起/展开按钮（`SidebarToggle`），不压住分组标题和折叠箭头，点「«」图标后侧栏整体滑出，左边缘留一个 30×30 的「»」页签可重新展开；状态写入 `localStorage` 的 `wemind-sidebar-collapsed`，并在 `<head>` 内联脚本里先读，避免刷新时侧栏先展开再收起；首页 `sidebar: false` 时不渲染。默认主题自带的语言菜单隐藏，只保留一个自定义 `LocaleSwitch`；英文文档页的默认主题文案（`Skip to content`、`Return to top`、`Change language`、`Main Navigation`、`On this page` 等）在 `config.ts` 的 `THEME_LABELS` 中逐项覆盖。

### 4.3 公开文档范围

首版公开文档控制在 15–20 篇，M3 已落地 15 篇中文，先覆盖「能跑起来 + 常见问题」，不追求全量：

| 分类 | 页面                                               | 来源/处理                                      |
| ---- | -------------------------------------------------- | ---------------------------------------------- |
| 开始 | getting-started                                    | 基于 README + 新手教程重写                     |
| 使用 | commands、sessions、tasks、brain、media、autostart | 基于 `docs/使用指南/` 精选、改写               |
| 接入 | agents、custom                                     | 基于 `docs/接入方案/` 与 `docs/repowiki/` 精选 |
| 参考 | cli、wechat、env、data                             | 基于 `README.md` 命令表与速查文档整理          |
| 其它 | faq                                                | 新写，收集真实问题                             |

英文首批只做 7 篇，不追求和中文一一对应：

| 英文页面                    | 对应中文                 |
| --------------------------- | ------------------------ |
| `/en/guide/getting-started` | `/guide/getting-started` |
| `/en/guide/commands`        | `/guide/commands`        |
| `/en/guide/sessions`        | `/guide/sessions`        |
| `/en/guide/tasks`           | `/guide/tasks`           |
| `/en/guide/brain`           | `/guide/brain`           |
| `/en/guide/agents`          | `/agents/` 的英文精选版  |
| `/en/guide/faq`             | `/faq/`                  |

英文导航/侧边栏只列这 7 篇；英文搜索只索引这 7 篇。其余中文独有页（如 `/guide/media`、`/guide/autostart`、`/reference/*`）不生成英文占位页；用户点 EN 时回 `/en/guide/` 并提示「这篇还没有英文版」。

明确不公开：

- `docs/审查与质量记录/`
- `docs/待办与后续计划/`
- `docs/ai/`
- `docs/设计文档/`（除非单篇改写为公开的架构说明）
- `docs/机制与协议说明/`（内部协议细节，暂不公开）
- 任何带真实账号、token、聊天记录、内网路径的内容

### 4.4 文档来源：已定精选副本

现在有三条路：

| 方案                | 做法                                                           | 优点                                             | 缺点                                                                                             |
| ------------------- | -------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| A. 精选副本（已定） | 在 `apps/website/docs` 里维护公开文档，从根 `docs/` 精选后改写 | 公开内容可控、可重写、不会泄露内部文档；构建简单 | 根文档更新后可能漂移，需要人工同步                                                               |
| B. 构建时同步       | 根 `docs/` 为唯一源，构建前按白名单复制到站点并改写链接        | 单一源，长期不易漂移                             | 根文档是面向 AI/维护者的，直接上网要大量改写；链接/图片/frontmatter 处理复杂；白名单漏一个就泄露 |
| C. 搬家             | 把公开文档移到 `apps/website/docs`，根 `docs/` 只留内部        | 公开与内部彻底分开                               | 会破坏现有 AGENTS/llms/链接，迁移成本高                                                          |

**已确认首版走 A**：公开文档是「面向用户重写」的产物，不是根文档的镜像。等公开文档稳定、更新频率上来后，再评估 B（只对稳定的参考页做自动同步），不要一开始就做同步管线。

无论选哪条，都需要一条纪律：**根 `docs/` 的事实变更，必须在同一个 PR 里检查站点对应页面**。可以在 PR 模板里加一行「官网文档是否受影响」。

## 5. 首页设计

### 5.1 叙事结构

首页不是功能列表，而是一条**消息的旅程**：

> 你在微信里发一句话 → WeMind 接住 → 交给本机 Agent → Agent 用工具干活 → 结果回到微信。

滚动时，左侧手机固定，右侧文字逐幕推进；手机屏幕里的聊天内容跟着变。移动端取消 sticky 和视差，改成「文字 + 手机截图/卡片」顺序堆叠。

### 5.2 五幕

| 幕  | 标题（工作稿）      | 画面                                                                             | 文案要点                                               |
| --- | ------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | 在微信里，说一句话  | 手机聊天：用户发「帮我把 docs 里的接入方案整理成一页说明」                       | 不打开终端、不装新 App；微信就是入口                   |
| 2   | WeMind 接住这条消息 | 手机旁出现 daemon/MCP 的接收动画；消息 ID、媒体、白名单                          | 单实例收消息；文本/图片/文件/语音都能进                |
| 3   | 换一个 Agent 接手   | 微信聊天里点选 Claude Code / Codex / Gemini / Pi，顶部状态从「主聊」换成新 Agent | 主聊的 Agent 随时换；微信入口不变；不解释 CLI/ACP 条件 |
| 4   | Agent 开始干活      | 工具步骤：读文件、跑命令、查资料；长任务交给任务 Agent                           | 进度会回微信；长任务不阻塞聊天；主聊可以继续           |
| 5   | 结果回到微信        | 手机收到总结 + 附件；聊天里出现「完成」                                          | 文本、图片、文件、视频都能回；不需要服务器中转         |

S2 远程任务作为第 4 幕的一个分支：任务较长时出现「已交给任务 Agent」卡片，展示进度和「继续/停止」指令；不单独占一整屏。第三幕和「一个入口，多个 Agent」小节只用日常说法，不再重复「必须同时支持 CLI 与 ACP」。

S3「两种形态」与 S4「安全边界」放在五幕之后：

- 两种形态：MCP Server vs daemon，两栏卡片，各自适合谁、怎么启动。
- 安全边界：本机运行、白名单、敏感文件拦截、附件大小上限、无云端中转；用短句，不堆术语。

### 5.3 假聊天演示

首页中段放一个可交互的假微信窗口：

- 三个 tab：`总结文档`、`查资料`、`远程任务`。
- 每个 tab 是一组固定消息脚本（3–5 条），按时间逐条出现；支持「重播」「跳过」。
- 不连接后端、不调用真实微信、不需要 token；页面明确标注「演示脚本，不会真的发消息」。
- 脚本内容使用真实产品能力（例如 `帮我把这个目录的文档总结成一页`），但不出现真实账号、路径、内网地址。
- 移动端默认只显示第一个脚本，tab 横向滚动；不自动播放声音。
- 英文首页的 tab、消息、按钮、提示、代码注释全部英文；不允许在英文首页混中文。英文译文进 Lingui catalog，CI 检查缺条目。

实现上用 Vue 的 `TransitionGroup` + `setTimeout` 即可，不引入动画库。所有计时器在组件卸载时清理，避免切页后继续跑。

### 5.4 动效与移动端

- 桌面：手机 `position: sticky`，右侧步骤 `min-height: 62vh`；`IntersectionObserver` 切换 active step；进度线用 CSS 变量。`HomePage` 的横向裁切必须用 `overflow: clip`，不能用 `overflow: hidden`，否则 sticky 会失效。
- 移动：取消 sticky、视差和大幅位移；手机变成普通卡片，步骤顺序堆叠。
- 尊重 `prefers-reduced-motion: reduce`：关闭滚动动画、逐条打字和自动播放，直接显示最终状态。
- 动效只改 `transform` / `opacity`，不改布局属性；不做无限循环的背景动画。
- 首版不引入 GSAP/Three.js；如果后续要加 3D，必须作为独立的 `client:only` 岛并做移动端降级。

### 5.5 性能预算

VitePress 本身会带 Vue runtime，首页不可能做到 Astro 那种「零 JS」。预算按「额外交互代码」算：

- 首页新增的交互组件 JS：**< 20KB gzip**（不含 VitePress/Vue 基础 runtime）。
- 首页 LCP：**< 2.5s**（中端移动网络，真实测量）。
- CLS：**< 0.1**。
- 首屏不加载大图；手机 mockup 优先用 CSS/HTML 画，不用截图。
- 图片用 WebP/AVIF，写明 `width`/`height`，首屏外 `loading="lazy"`。
- Lingui 额外 JS 实测约 **+4.65KB gzip**（CSS +0.29KB）；M2 五幕/demo/语言整体新增约 **+10.8KB gzip**，全站 JS 约 76KB gzip，仍在 20KB 额外预算内。760B 只是 app chunk，不是全部。
- 默认主题不要 preload Inter；使用 `vitepress/theme-without-fonts`，首版不加载 Web Font。

## 6. 视觉方向

### 6.1 关键词

**通道、安静、可靠、本地优先**。不要做成「AI 魔法」风格的紫蓝渐变，也不要直接使用微信官方视觉。

### 6.2 色彩、字体、logo（已定）

按微信公众号的「人文感/纸感」方向落地，不做深色首页：

- 暖白纸感底 `--wm-paper #f6f1e7`，卡片 `#fffdf8`，墨色正文 `#26302b`，弱化 `#68716b`。
- 强调色：低饱和松绿 `--wm-pine #4f6f52`；朱砂只做小面积强调 `--wm-clay #b45f3f`。
- 字体：标题宋体/衬线（`Noto Serif SC`、`Songti SC`、`STSong` 回退），正文 `PingFang SC` / `Microsoft YaHei` / `Noto Sans SC`；不加载 Web Font。
- 图形：细线、留白、手绘线稿；手机 mockup 用 HTML/CSS 画，不用真实截图。
- 文档页也统一浅色；`config.ts` 已设 `appearance: false`，首版不提供暗色切换。
- Logo：M2 仍用文字标 `WeMind`；图形标放 M5 品牌阶段，不在首页临时拼一个。

### 6.3 素材边界

- 不使用微信、腾讯、Claude、OpenAI、Google 等官方 logo 作为产品背书。
- Agent 名称用文字标签，不用官方图标。
- 不使用真实聊天截图；需要截图时用脱敏的 mockup。
- 首页底部加一句：WeMind 不是腾讯/微信官方产品；相关名称归各自权利人所有。
- **手绘风格不消除法律风险**：如果画出来仍能认出是微信的气泡、Claude 的星芒、OpenAI 的结等，仍可能构成近似商标、衍生作品或不正当竞争。安全的做法是只画「消息、终端、大脑、盾牌、文件」这类通用概念图标，不复制品牌的轮廓、配色和组合；不要给图标起品牌名。
- 用文字写「支持 Claude Code / Codex / Gemini CLI」属于说明兼容性，通常比用 logo 安全；但不要暗示官方合作。免责声明不能替代授权。
- 如果以后要商业化投放或大规模买量，建议找知识产权律师看一遍；本文不是法律意见。

## 7. 工程结构

### 7.1 目录

```text
apps/website/
  package.json
  package-lock.json
  lingui.config.ts
  vite.config.ts          # Vite+ 检查层；不接管 VitePress 构建
  tsconfig.json
  docs/
    .vitepress/
      config.ts
      theme/
        index.ts
        Layout.vue
        custom.css
        components/
          HomePage.vue
          HomeHero.vue
          ScrollStory.vue
          PhoneFrame.vue
          PhoneDemo.vue
          ChatBubble.vue
          FeatureGrid.vue
          SiteFooter.vue
          DocsLink.vue
          LocaleSwitch.vue
        composables/
          useLocale.ts
        data/
          story.ts
          demo.ts
        locale.ts
        locale.test.ts
        locales/
          zh/messages.po
          en/messages.po
    public/
      favicon.svg
      en/index.html      # /en/ 静态跳转页，不是英文首页
    index.md             # 中文首页（原地切英文）
    guide/
      index.md           # 文档入口
      getting-started.md
      commands.md
      sessions.md
      tasks.md
      brain.md
      media.md
      autostart.md
    agents/
      index.md
      custom.md
    reference/
      index.md
      cli.md
      wechat.md
      env.md
      data.md
    faq/
      index.md
    en/
      guide/
        index.md         # 英文文档入口
        getting-started.md
        commands.md
        sessions.md
        tasks.md
        brain.md
        agents.md
        faq.md
```

M3 已落地 15 篇中文（含 guide/agents/reference/faq 入口）与 7 篇英文正文；英文只列已翻译页，中文独有页不生成英文占位。`docs/en/index.md` 已删除，`/en/` 由 `docs/public/en/index.html` 静态跳转。

### 7.2 站点配置

`docs/.vitepress/config.ts` 负责：

- `base`：从 `DOCS_BASE` 读取，默认 `/`；GitHub Pages workflow 显式传 `/WeMind/`。
- `cleanUrls`：由 `DOCS_CLEAN_URLS` 控制，默认 `true`；GitHub Pages workflow 显式传 `false`。Pages 没有无扩展名重写，`/guide/getting-started` 会 404；`.html` 路径稳定。本地/Cloudflare 保持 `true`，回退只改 URL，不改内容。
- **顶层 `locales`**：`root`（`lang: 'zh-CN'`）与 `en`（`lang: 'en-US'`）各自带 `themeConfig`。VitePress 2 alpha 只认这个形状；写成 `themeConfig.locales.en` 会被忽略，表现为英文正文变了但 nav/sidebar 仍中文。
- `lang`：根 `zh-CN`，英文 `en-US`；运行时切首页时同步 `<html lang>`。
- `vite.plugins: [linguiVue(), lingui()]`：`linguiVue()` 已包含 Vue 模板 transform，不要再重复加 `vue()`；Lingui 只处理 `.vue`/JS/TS，Markdown 正文不进 catalog。
- `themeConfig.nav`、`sidebar`、`search`、`socialLinks`、`editLink`、`footer`：中文、英文各一份；M3 nav/sidebar 已按 §4.2/§4.3 落地，英文只列已翻译页；`search`/`socialLinks`/`editLink` 留 M4/M5，不挂空链接。
- 英文默认主题文案：`skipToContentLabel`、`returnToTopLabel`、`outline.label`、`darkModeSwitchLabel`、`langMenuLabel`、`docFooter` 等逐项覆盖。
- `head`：favicon、OG、theme-color；英文文档页加 `hreflang`/canonical；`/en/` 跳转页加 `noindex`。
- `sitemap.hostname`：等域名确定后填；只让主站进 sitemap，`/en/` 跳转页不进去。
- `markdown`：首版不启用数学公式；需要时再加。
- `vite.config.ts`：只给 Vite+ 的 `lint`/`fmt`/`test` 用，不配置 VitePress 的构建；VitePress 继续用自己的 `vitepress build docs`。

`themeConfig.sidebar` 每个 locale 用一份完整数组，不按 `/guide/`、`/agents/`、`/reference/` 拆成不同侧栏；这样跨「开始/使用/接入/参考」导航时左侧栏保持同一份结构，不会像进入新站点。分组 `collapsed: false` 默认展开、可折叠；当前页高亮在 `custom.css` 中补足。公开文档数量少，手写比自动扫目录可控。英文 sidebar 只列 7 篇。

### 7.3 自定义 Layout

`docs/index.md`：

```md
---
layout: page
sidebar: false
title: WeMind
---

<HomePage />
```

`docs/.vitepress/theme/Layout.vue` 不再按 `frontmatter.customHome` 分支，而是始终渲染默认主题，把首页内容通过 `docs/index.md` 的 `<HomePage />` 放进默认内容区；这样文档页的 nav/sidebar/search/footer 都保留，首页只需要 `layout: page` + `sidebar: false`。

`Layout.vue` 的职责是：

- 用 `useSlots()` 动态转发默认主题的命名 slot，避免文档页丢搜索/侧边栏/页脚；
- `#nav-bar-content-after` 放 `DocsLink`（桌面）和 `LocaleSwitch`；
- `#nav-screen-content-before` 放 `DocsLink mobile`，`#nav-screen-content-after` 放 `LocaleSwitch`（移动菜单）；
- 不覆盖默认主题的 `VPContent`。

M2 已落地：

- `theme/index.ts` 初始化 Lingui；`Layout.vue` 注入 `LocaleSwitch`/`DocsLink`；不要在每个组件里各自 `createLingui()`。
- `Layout.vue` 用 `useSlots()` 动态透传默认主题的 slots，避免文档页丢搜索/侧边栏/页脚。
- 用 `vitepress/theme-without-fonts` 替代默认主题，去掉 Inter 预加载；首版不加载 Web Font。
- 默认主题语言菜单隐藏，只保留一个 `LocaleSwitch`；英文主题文案逐项覆盖。
- 语言状态按 `route.path` 判断，不用 `useData().lang` 推断当前语言。

### 7.4 国际化（B 方案）

**目标**：中文首页 + 英文文档；首页在 `/` 原地切换，不产生 `/en/` 英文首页；英文文档走 `/en/guide`，可分享、可被收录。

**URL 与跳转**：

- `/` 是唯一首页；中文和英文共用这个 URL。
- `/en/` 只是一个静态跳转页，`meta refresh` + `canonical` 指向 `/en/guide/`，并加 `noindex`；GitHub Pages 没有 301，Cloudflare 后再用 `_redirects`。
- 英文文档入口是 `/en/guide/`，它不是英文营销首页；英文首页没有独立 URL。

**默认语言与偏好**：

- 首次访问 `/` 默认中文；**不读 `navigator.language`，不自动切**。
- 只有用户手动点 EN 才写 `localStorage`（`wemind-locale=en`）；点中文写 `zh`。
- 已保存 EN 的用户刷新 `/`：先显示中性骨架/加载动画，Lingui 激活后显示英文；用 `<head>` 内联脚本读 localStorage，给 `<html>` 加 `data-locale-pending="en"`，最多约 1s 超时回退中文，尊重 `prefers-reduced-motion`。
- 从 `/en/guide/` 客户端回 `/` 不套骨架，直接按已保存偏好渲染。

**一个开关**：

- 首页 `/`：只 `i18n.activate` + 保存偏好，不改 URL；文档链接按当前语言指向 `/guide/` 或 `/en/guide/`。
- 文档页：按 `route.path` 算目标；有对应译文就 `router.go` 到 `/en/...` 或 `/...`；没有就回 `/en/guide/` 并提示「这篇还没有英文版」。
- 当前语言看 `route.path`，不看 `useData().lang`；切换后同步 `<html lang>`。
- 英文文档页的 Home/logo 回 `/`，并把偏好记成 EN；进入 `/en/guide/...` 时也写 EN，避免点 Home 掉回中文。
- 中文文档页的 Home/logo 回 `/`；如果用户已保存 EN，首页仍按保存的 EN 显示（URL 是文档页的权威，首页是偏好）。

**内容边界**：

- 英文首页全量翻译：nav、footer、按钮、语言开关、`<title>`/meta/OG、图片 alt、`aria-label`、空状态/错误、demo 每条消息/命令/步骤、代码块注释。
- 英文文档只做 7 篇；中文 15–20 篇按 §4.3。英文导航/侧边栏/搜索只列 7 篇。
- 未翻译页不生成 `/en/guide/xxx` 占位页；直接访问未翻译英文 URL 走英文 404/说明页。
- 英文文档的 VitePress 主题自带文案必须英文；不能出现「英文正文 + 中文 Skip to content」。

**SEO 与代价**：

- 英文首页没有独立 URL，不能被单独收录/分享；这是 B 方案接受的代价。
- 英文文档有 `/en/` URL，可以有 `hreflang`、canonical、独立 sitemap 条目；`/en/` 跳转页不收录。
- 首页 `<html lang>` 运行时切换；爬虫看到的是默认中文首页，不宣称英文首页 SEO。

**当前状态**：M4 已完成——M3 的 15 篇中文 + 7 篇英文、全站侧栏/折叠/高亮/整体收起均已落地；`vp check` 26 文件格式/23 文件 lint+type、`vp test` 7 个用例、默认/base 构建、CDP 抽检通过。GitHub Pages 已按 `DOCS_BASE=/WeMind/`、`DOCS_CLEAN_URLS=false` 部署，线上首页、`/guide/getting-started.html`、`/en/guide/`、`/en/` 跳转和 CSS/JS 均 200；`cleanUrls=false` 为 GitHub Pages 结论。Cloudflare Pages 仍为可选后补。下一步 M5（SEO/OG、可访问性、Lighthouse、搜索/分析）。

### 7.5 组件职责

| 组件               | 职责                                        | 是否客户端交互 |
| ------------------ | ------------------------------------------- | -------------- |
| `HomePage.vue`     | 首页骨架，组合各 section；只做横向裁切      | 否             |
| `HomeHero.vue`     | 标题、副标题、范围小字、CTA、Agent 纸卡     | 否             |
| `ScrollStory.vue`  | 五幕滚动叙事、active step、桌面 sticky 手机 | 是             |
| `PhoneFrame.vue`   | 手机外框、状态栏、按幕渲染聊天内容          | 否             |
| `PhoneDemo.vue`    | 三脚本切换、逐条播放、重播/跳过             | 是             |
| `ChatBubble.vue`   | 文本/附件/进度气泡的展示                    | 否             |
| `FeatureGrid.vue`  | 两种形态、不能同时跑的提醒、五条安全边界    | 否             |
| `SiteFooter.vue`   | 品牌、文档/GitHub、免责声明                 | 否             |
| `DocsLink.vue`     | 按当前语言指向 `/guide/` 或 `/en/guide/`    | 否             |
| `LocaleSwitch.vue` | 首页切 Lingui、文档页走 locale 路由         | 是             |

数据：

- `data/story.ts`：五幕的编号、标题、正文、手机屏幕状态（`act`）。
- `data/demo.ts`：三个演示脚本的标题、消息数组、发送方、特殊块（附件/来源/任务）。

不引入 Pinia、Vue Router 或全局状态；`useLocale.ts` 用模块级 `landingLocale` 共享首页偏好，组件内部 `ref` 足够。

### 7.6 样式

- `custom.css` 只放设计 token、首页全局布局、VitePress 变量覆盖；组件样式用 `<style scoped>`。
- 断点：`860px`（桌面/移动分界）、`640px`（小屏细节）；M2 未单独使用 768/1024/1280。
- 移动端触控目标 ≥ 44px；焦点样式不能被 `outline: none` 去掉。
- 首页的 section 用语义化 `<section>` + `<h2>`；不要用一堆 `<div>`。
- 首页横向裁切用 `overflow: clip`，给 sticky 留出工作空间；不要用 `overflow: hidden`。

## 8. 文档管线

### 8.1 首版流程

1. 从根 `docs/` 选一篇公开候选，复制到 `apps/website/docs/...`。
2. 按公开读者重写：去掉内部链接、维护者术语、审查记录引用；补 frontmatter（title/description）。
3. 在中文 `config.ts` 的 sidebar 里登记。
4. 英文只从 §4.3 的 7 篇清单选；翻译后校对，登记英文 sidebar；不生成未翻译占位页。
5. 本地 `npm run build` + `npm run preview`，检查链接、代码块、移动端、两种语言的主题文案。
6. PR 里勾选「根文档是否也需要同步」。

英文页的正文、标题、description、侧边栏文字和代码块注释都算翻译范围；英文页里不能混中文说明。

### 8.2 链接规则

- 站内链接用相对路径（`./sessions`、`../reference/cli`），让 VitePress 处理 base。
- 指向源码/仓库的链接用绝对 GitHub URL：`https://github.com/imwangpan/WeMind/blob/main/...`。
- 不链接 `docs/ai/`、`docs/审查与质量记录/`、`docs/待办与后续计划/`。
- 不在正文里写死 `http://localhost`、内网 IP、真实账号路径。
- 构建后加一个链接检查（工具待定：`linkinator`/`lychee`/自写脚本），至少检查站内 404。
- 英文页链回中文对应页时，目标页不存在就回 `/guide/`；不要让英文页链到中文独有页。
- `/en/` 跳转页不参与站内导航，只作为外部旧链接/直接访问的入口。

### 8.3 与根文档守卫的关系

根 `npm run verify` 的文档守卫主要覆盖根 `docs/`；`apps/website/docs` 的链接检查不能寄托在根脚本上。站点自己的 CI 必须跑：

- `npm run check`、`npm run lint`、`npm run fmt`、`npm run test`（Vite+ 检查层）；
- `npm run build`；
- 构建后的站内链接检查；
- 英文 catalog 缺条目检查（缺一条就失败，不允许回退中文）；
- 英文文档主题 UI 文案检查（不能出现中文 `Skip to content` 等）。

## 9. 部署与 CI

### 9.1 托管选择

| 方案             | 免费额度                            | 国内访问                                   | 预览       | 结论          |
| ---------------- | ----------------------------------- | ------------------------------------------ | ---------- | ------------- |
| Cloudflare Pages | 免费，带宽/请求宽松，约 500 构建/月 | 实测 `pages.dev` 可连但慢（约 5–6s）       | PR 预览    | **后补/备选** |
| GitHub Pages     | public 仓库免费，约 1GB/100GB 月    | 实测 `github.io` 失败，`github.com` 也不稳 | 无 PR 预览 | **首版主站**  |
| Vercel           | Hobby 免费但非商用                  | 不稳定                                     | 有         | 不推荐        |
| Netlify          | 免费额度较小                        | 不稳定                                     | 有         | 不推荐        |

建议：

- **首版 GitHub Pages**：零额外账号、同仓 Actions 就能上线；`DOCS_BASE=/WeMind/`。
- **Cloudflare Pages 后补**：注册后再加一个部署目标，同一份构建，`base` 为 `/`；适合做 PR 预览和国内可达性更好的镜像。
- **谁主谁副可以后定**：技术上只是 `DOCS_BASE`、canonical/sitemap、CI 的差异，不需要重写页面；但正式宣传后再换主站，会影响外链和 SEO，尽量在上线宣传前定最终主站。
- 两个都部署时，只让一个主站进 sitemap/搜索控制台，另一个用 canonical 指向主站。

### 9.2 base 矩阵

| 目标             | 构建命令                                                 | 访问地址                           |
| ---------------- | -------------------------------------------------------- | ---------------------------------- |
| 本地             | `npm run dev`                                            | `http://localhost:5173/`           |
| Cloudflare Pages | `npm run build`                                          | `https://<project>.pages.dev/`     |
| GitHub Pages     | `DOCS_BASE=/WeMind/ DOCS_CLEAN_URLS=false npm run build` | `https://<user>.github.io/WeMind/` |
| 自定义域名       | `npm run build`                                          | `https://<domain>/`                |

首版 GitHub Pages 用 `cleanUrls: false`；Pages 没有无扩展名重写，`/WeMind/guide/getting-started` 会 404，带 `.html` 的 URL 稳定。本地和 Cloudflare 仍可用 `true`。以后切主站时同步改 `DOCS_CLEAN_URLS`、canonical/sitemap。

### 9.3 CI

站点独立 workflow `.github/workflows/website.yml`，路径过滤 `apps/website/**` 与该 workflow：

- Node 24.11
- `npm ci`（工作目录 `apps/website`）
- `npm run check`、`npm test`
- `npm run build`，env `DOCS_BASE=/WeMind/`、`DOCS_CLEAN_URLS=false`
- `touch docs/.vitepress/dist/.nojekyll`
- `actions/configure-pages` + `upload-pages-artifact` + `deploy-pages`；PR 只构建，push main 才部署
- 部署后验收：`/WeMind/`、一个 `/WeMind/guide/*.html`、`/WeMind/en/` 跳转、`/WeMind/en/guide/`、静态 CSS/JS 均 200
- Cloudflare 后补：`wrangler pages deploy docs/.vitepress/dist --project-name=wemind`，`base` 为 `/`、`DOCS_CLEAN_URLS=true`

首版只做 GitHub Pages（零额外账号）；Cloudflare 等注册后再加。

### 9.4 自定义域名

Q4 已定「先用免费子域」。以后买域名时：

1. 在 Cloudflare Pages 绑定自定义域名；
2. `base` 改为 `/`；
3. 更新 `sitemap.hostname`、OG/canonical；
4. 旧 `pages.dev` 地址保留 301（如果平台支持）。

## 10. SEO、可访问性、分析

### 10.1 SEO

- 每页 `title` / `description` 唯一；首页 description 不超过 160 字符。
- 根 `lang="zh-CN"`，英文文档 `lang="en-US"`；运行时切首页时同步 `<html lang>`。
- 静态 `og.png`（1200×630），首版不做动态生成。
- `robots.txt` 允许抓取；`sitemap.xml` 在域名确定后启用，只让主站和英文文档进 sitemap，`/en/` 跳转页不进去。
- 英文文档页加 `hreflang` 与 canonical（`/en/guide/...` ↔ 对应中文页）；首页没有英文 URL，不要给 `/` 伪造英文 hreflang。
- B 方案的代价：英文首页不被单独收录，分享 `/` 给英文用户可能先看到中文；这是接受的产品取舍，不在 SEO 上宣称英文首页。
- 文档页保留 `lastUpdated` 和「编辑此页」链接，方便判断时效。
- 首页考虑加 `SoftwareApplication` JSON-LD（名称、描述、代码仓库、license）；不确定的字段不写。

### 10.2 可访问性

- 颜色对比达到 WCAG AA；首页只有浅色主题，检查纸底/墨字/松绿/朱砂的对比。
- 所有交互可键盘操作；tab 用按钮 + `aria-selected`，不要只靠 hover。
- 滚动叙事在 `prefers-reduced-motion` 下退化为静态内容。
- 假聊天窗口用 `aria-label` 标注「演示」；不要用 `aria-live` 播报每一条自动消息，避免读屏刷屏。
- 图片有 `alt`；装饰性图形 `aria-hidden="true"`。
- 语言开关用 `<button>` 时要有 `aria-pressed`，触控目标 ≥44px；用 `<a>` 时要有可读的 `hreflang`/label；键盘可操作。
- 英文文档的默认主题 skip link、返回顶部、语言菜单 label 不能残留中文。
- 焦点可见；不要全局 `outline: none`。

### 10.3 分析

- 首版默认不装分析，减少 cookie/隐私负担。
- 如果需要，优先 Cloudflare Web Analytics（无 cookie、免费）或自建 Umami；不接 Google Analytics。
- 分析脚本必须异步、不阻塞首屏；上线前确认不需要 cookie 同意。

## 11. 测试与验收

### 11.1 构建门禁

- `npm run check`、`npm run lint`、`npm run fmt`、`npm run test` 必须通过；Vite+ 只做检查层，不接管构建。
- `npm run build` 必须通过；VitePress 2 alpha 升级时单独 PR，不和内容改动混在一起。
- `npm run preview` 人工检查首页、文档页、404。
- 站点自己的链接检查通过；英文 catalog 缺条目、英文主题文案残留中文都要失败。

### 11.2 浏览器验收

至少覆盖：

- 桌面 1440×900：首页五幕滚动、sticky 手机、tab 切换。
- 移动 375×812：无横向滚动、无 sticky 抖动、触控目标够大。
- 文档页：侧边栏、搜索、代码块复制；首版不提供暗色模式。
- 刷新/直达：`/WeMind/guide/getting-started` 直接打开不 404（base 正确）。
- 首次访问 `/`：中文，无英文闪烁；`localStorage` 无偏好时不读浏览器语言。
- 保存 EN 后刷新 `/`：骨架 → 英文，最多约 1s 回退中文；不出现中文正文闪一下。
- `/` 点 EN：不换 URL、不整页刷新，nav/hero/demo/footer 全英文；文档链接改指 `/en/guide/`。
- 文档页切语言：有译文走对应 `/en/...`；无译文回 `/en/guide/` 并提示；开关高亮与 `<html lang>` 一致。
- 英文文档 Home/logo 回 `/` 后仍是英文；`/en/` 跳 `/en/guide/`；英文文档无中文主题文案。
- 关闭 JavaScript：首页主要内容仍可读（叙事文字不依赖 JS；手机 mockup 可以是静态第一幕）。

### 11.3 可选自动化

- Playwright：首页加载、tab 点击、移动端截图；不做像素级 diff，先做 smoke。
- Lighthouse：Performance/Accessibility/SEO 目标 ≥ 90；首页动画多，允许 Performance 单独放宽到 ≥ 85，但要记录原因。

## 12. 风险

| 风险                            | 影响                               | 缓解                                                               |
| ------------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| VitePress 2.0 alpha 变更        | 构建失败/主题 API 变化             | 锁 `2.0.0-alpha.21`；升级单独 PR；保留 `1.6.4` 应急分支            |
| Vite 8 Node 约束                | 本地/CI 跑不起来                   | CI 固定 Node 24.11；`engines` 写清楚                               |
| GitHub Pages base/大小写        | 资源 404                           | `DOCS_BASE` 显式传；部署后真实访问；本地不能验证大小写             |
| GitHub Pages 不支持 `cleanUrls` | 无扩展名路径 404                   | M1 实测；404 就回退 `false`，只影响 URL，不影响内容                |
| 文档双份维护漂移                | 官网与仓库说法不一致               | 首版精选副本 + PR 检查项；稳定后再评估同步脚本                     |
| 国内访问不稳定                  | 用户打不开                         | GitHub Pages 先上，Cloudflare 后补；不承诺稳定                     |
| 品牌/商标                       | 误用官方 logo                      | 只用文字标签；首页免责声明；不使用真实聊天截图                     |
| 首页动画拖慢移动端              | LCP/CLS 差                         | 移动端关 sticky/视差；CSS 动画；预算与 Lighthouse                  |
| 中文搜索效果                    | 搜不到文档                         | 先测 VitePress local search；不行再换 Algolia DocSearch/Pagefind   |
| B 方案语言状态机                | 切错、闪中文、URL 与开关高亮不一致 | 单开关 + `route.path` 判定；文档页 URL 权威；M1 加 Playwright 用例 |
| 英文主题 UI 未翻译              | 英文页混中文                       | 逐项覆盖 VitePress label；验收检查                                 |
| Vite+ L2 版本偏差               | lint/format 与根不一致             | 只做检查层；锁 1.8.0；不和根共用；spike 后再进 CI                  |
| 英文翻译工作量                  | 7 篇文档滞后                       | 只列已翻译页；缺页回 `/en/guide/`；CI 缺 catalog 失败              |
| 英文首页无独立 URL              | 不能被搜到/分享                    | 接受 B 的代价；不宣称英文首页 SEO                                  |
| 内部文档误公开                  | 泄露内部信息                       | 白名单 + 发布前人工审计；不整站复制 `docs/`                        |

## 13. 里程碑

| 阶段 | 交付                                                                                                | 验收                                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| M0   | 本文 + `docs/website-design` 分支                                                                   | 方案评审通过                                                                                                       |
| M0.5 | VitePress 2 + Lingui 最小 spike                                                                     | 已完成工具链验证；评审发现 P0/P1，代码冻结，M1 修复                                                                |
| M1   | `apps/website` 骨架、VitePress 2 alpha、自定义 Layout、Vite+ 检查层、base/cleanUrls、语言开关状态机 | 已完成；P0 清零，构建与语言切换验收通过                                                                            |
| M2   | 五幕叙事、手机 mockup、假聊天 demo、移动端、reduced motion、英文首页全量文案、浅色视觉              | 已完成本地验收；桌面/移动无溢出，英文无中文残留，JS 约 76KB gzip                                                   |
| M3   | 15–20 篇中文文档 + 7 篇英文文档、导航/侧边栏、链接检查                                              | 已完成：15 篇中文 + 7 篇英文；构建无 404；内部文档未进入；英文缺页行为正确                                         |
| M4   | GitHub Pages 部署 +（可选）Cloudflare Pages、CI、base 矩阵                                          | 已完成 GitHub Pages：首页/中文文档/英文文档/`/en/` 跳转/静态资源均 200；`cleanUrls=false`；Cloudflare 暂缓（可选） |
| M5   | SEO/OG、可访问性、Lighthouse、分析（可选）                                                          | 目标分数；无阻塞问题                                                                                               |

## 14. 尚未聊清楚的问题

### 14.1 已定（本轮）

| #   | 问题          | 结论                                                                                          |
| --- | ------------- | --------------------------------------------------------------------------------------------- |
| 1   | 公开文档来源  | 精选副本（§4.4 A）                                                                            |
| 2   | 公开文档清单  | 中文 15–20 篇；英文首批 7 篇                                                                  |
| 3   | 首版托管      | GitHub Pages 先上；Cloudflare 后补                                                            |
| 4   | `cleanUrls`   | GitHub Pages 固定 `false`（无扩展名会 404）；本地/Cloudflare 可 `true`；首版已按 `false` 部署 |
| 5   | 语言方案      | B：`/` 原地中英切换，不做 `/en/` 英文首页                                                     |
| 6   | 默认语言      | 首次中文，不读浏览器语言；手动切 EN 才保存                                                    |
| 7   | 英文首页范围  | 全量翻译，不只 hero                                                                           |
| 8   | 英文文档范围  | 首批 7 篇（getting-started/commands/sessions/tasks/brain/agents/faq）                         |
| 9   | 未翻译页      | 回 `/en/guide/` 并提示；不生成占位页                                                          |
| 10  | 语言开关      | 全站一个；首页切状态，文档页走路由                                                            |
| 11  | 英文文档 Home | 回 `/` 并记 EN                                                                                |
| 12  | 检查工具      | Vite+ 1.8.0 只做 check/lint/fmt/test                                                          |
| 13  | base/仓库名   | 仓库保持 `WeMind`，base `/WeMind/`                                                            |

### 14.2 可以边做边定

最终主站是否从 GitHub Pages 切到 Cloudflare Pages，也放在这一类：技术上不影响页面代码，但会影响外链和 SEO，尽量在正式宣传前定。

| #   | 问题                                  | 建议                                                                               |
| --- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| 5   | 视觉方向/主色/logo                    | 已定浅色人文纸感（§6.2）；M2 先用文字标 `WeMind`，图形标 M5 再做                   |
| 6   | 正式域名与购买时间                    | Q4 已定先用免费子域；上线后再买                                                    |
| 7   | 是否加访问统计                        | 首版不加；需要时用 Cloudflare Web Analytics                                        |
| 8   | 英文文案与翻译流程                    | 7 篇英文文档已落地；剩母语校对、后续更新责任、与中文页漂移检查                     |
| 9   | 搜索用 local 还是 Algolia             | 先用 VitePress local search，中文/英文各自实测                                     |
| 10  | 演示脚本最终文案                      | 已定三个 tab；M2 脚本已落地，后续可按真实反馈微调                                  |
| 11  | OG 图/分享卡片                        | 先做静态 1200×630，M5 再优化                                                       |
| 12  | 文档内容许可                          | 跟仓库 LICENSE 一致；如果要 CC BY，单独确认                                        |
| 13  | 站点文档跟 `main` 还是最新 npm 版本？ | 首版标「适用于 main」；发版后在页头显示版本/日期，避免命令与已发布包不一致         |
| 14  | 支持 Agent 的兼容性矩阵怎么呈现？     | 只列实测通过的版本/日期/限制，未测的明确标「未验证」                               |
| 15  | 用户去哪里提问/报安全问题？           | GitHub Issues + `SECURITY.md`；站内明确提醒不要贴 token/二维码                     |
| 16  | 公开文档的许可？                      | 跟随仓库 MIT；若要 CC BY 4.0，在 `apps/website/docs` 单独加 LICENSE                |
| 17  | 中文 SEO/双站 canonical 怎么做？      | 一个主站进 sitemap；另一个 canonical 指向它；百度需求强时尽早自定义域名/Cloudflare |
| 18  | 用什么衡量官网上线成功？              | 先定 3 个：快速开始完成、GitHub star、npm 下载/文档访问                            |

## 15. 决策记录

| 日期       | 决策                 | 说明                                                                                                     |
| ---------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| 2026-11-23 | Q1 落地页 + 文档一体 | 不拆两个站                                                                                               |
| 2026-11-23 | Q2 中文技术用户为主  | 兼顾非技术快速开始                                                                                       |
| 2026-11-23 | Q3 尽量直连、不备案  | 接受免费托管的不稳定                                                                                     |
| 2026-11-23 | Q4 先用免费子域      | 正式域名后补                                                                                             |
| 2026-11-23 | Q5 `apps/website`    | 不放 `packages/`，不拆独立仓库                                                                           |
| 2026-11-23 | Q6 VitePress 2.0     | 锁定 `2.0.0-alpha.21`；1.6.4 仅应急                                                                      |
| 2026-11-23 | 首页叙事 S1 主线     | S2 作为一幕，S3/S4 放下方                                                                                |
| 2026-11-24 | 公开文档=精选副本    | 认可 §4.3 的 15–20 篇公开清单                                                                            |
| 2026-11-24 | 首版 GitHub Pages    | Cloudflare 未注册，后补；`base=/WeMind/`                                                                 |
| 2026-11-24 | `cleanUrls=true` 试  | M1 在 GitHub Pages 实测；无扩展名 404 就回退 `false`                                                     |
| 2026-11-24 | 图标只用通用手绘     | 不用微信/Claude 等官方 logo，避免近似商标                                                                |
| 2026-11-25 | 语言方案 B           | 不做 `/en/` 英文首页；`/` 原地中英切换；英文文档 `/en/guide`                                             |
| 2026-11-25 | 默认中文             | 不读浏览器语言；手动切 EN 才写 localStorage；保存 EN 刷新用骨架                                          |
| 2026-11-25 | 英文首页全量翻译     | nav/footer/meta/demo/a11y 都要英文；不混中文                                                             |
| 2026-11-25 | 英文文档 7 篇        | 只列已翻译页；未翻译页回 `/en/guide/`                                                                    |
| 2026-11-25 | 单语言开关           | 首页切状态；文档页按 route 走 `/en/...`；英文文档 Home 回 `/` 并记 EN                                    |
| 2026-11-25 | Vite+ L2             | 只做 check/lint/fmt/test；不接管 dev/build                                                               |
| 2026-11-25 | base `/WeMind/`      | 仓库名保持 `WeMind`，不改名                                                                              |
| 2026-11-25 | 浅色人文视觉         | 暖白纸底/墨色/松绿/朱砂；不要深色、霓虹、3D；不加载 Web Font                                             |
| 2026-11-25 | 主文案定稿           | 一个微信入口，接入任意 AI Agent；微信不用换，Agent 随心换；Pi 作长任务示例                               |
| 2026-11-25 | M2 首页落地          | 五幕、手机 mockup、三 tab 假 demo、docs 入口、中英/base 验收                                             |
| 2026-11-25 | M3 文档落地          | 15 篇中文 + 7 篇英文；nav/sidebar 扩展；构建/抽检通过；不含内部文档                                      |
| 2026-11-25 | 侧栏体验修复         | 全站共用完整中文侧栏；分组可折叠；当前页高亮；移动端本页目录点后收起                                     |
| 2026-11-25 | 整体侧栏收起/展开    | 「开始」分组上方按钮；收起后左边缘展开页签；localStorage 记忆；首页/移动端不显示                         |
| 2026-11-26 | M4 GitHub Pages 完成 | 线上首页/中文文档/英文文档/`/en/` 跳转/静态资源 200；`base=/WeMind/`、`cleanUrls=false`；Cloudflare 暂缓 |

---

## 附：当前落地状态

- `apps/website` 已是 M4 站点：M2 首页 + 15 篇中文 + 7 篇英文文档；浅色视觉、五幕、手机 mockup、三 tab 假 demo、中英切换、侧栏整体收起/展开、base 与 `cleanUrls:false` 均已落地；
- 已通过 `vp check`、`vp test`、默认/base 构建、桌面/移动 CDP 抽检；GitHub Pages 已部署，线上验收通过；
- 下一步 M5（SEO/OG、可访问性、Lighthouse、搜索/分析可选）；Cloudflare 与自定义域名后补。
