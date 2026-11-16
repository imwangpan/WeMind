// scripts/doc-impact.rules.mjs
//
// 这是什么：一张「改了代码的哪些地方 → 必须同步哪些文档」的对照表。
// 它不是可执行脚本，由 scripts/doc-impact.mjs 读取。
//
// 为什么存在：审计（docs/审查与质量记录/审查-2026-11-05-经验与约束.md）发现，
// 「按读者找全文档」是开放式判断，AI 会做一次 grep 后合理地宣布完成，实际经常漏。
// 把「可能受影响的文档」写成闭集清单，检查才可查证。
//
// 每条规则字段：
//   id     规则名（出现在输出里）
//   why    一句话：这条规则防的是什么
//   files  可选，限定只看这些路径的 diff；不写则看全部
//   trigger(diffLines) 判断是否触发；diffLines 是 git diff --name-status -M 后的
//          「状态 + 路径」行（如 "M packages/x.ts"）与新增行（以 "+" 开头）的混合数组
//   docs   触发后必须同步的文档（路径 + 章节）
//
// 豁免：提交信息或 PR 描述里写一行 `Docs-Impact: none — <理由>`。
// pre-commit 阶段还没有提交信息，改用环境变量 DOCS_IMPACT（值只写 `none — Pure refactor` 即可）。
// 分支级检查（merge-base..HEAD）包含多个提交时，最近一次提交信息不作数；
// 要豁免整条分支必须显式设置 DOCS_IMPACT_MESSAGE，避免 HEAD 的一句「只改注释」跳过前面提交的缺口。
// 允许的理由只有 Pure refactor / Comment only / Test update 三种，见文件末尾。

export const RULES = [
  {
    id: 'env-var',
    why: '新增环境变量最容易只写代码不写文档；它在 4 处文档里各有一份表，漏一处读者就查不到。',
    trigger: (diffLines) =>
      diffLines.some(
        (line) => line.startsWith('+packages/') && /\bprocess\.env\.[A-Z][A-Z0-9_]*\b/.test(line),
      ),
    docs: [
      'docs/使用指南/速查-数据目录与环境变量.md §6、§7',
      'README.md 环境变量表',
      'packages/wechat-daemon/README.md 环境变量表',
      'docs/repowiki/09-配置项与环境变量.md',
      'docs/ai/已知坑.md',
    ],
  },
  {
    id: 'preset',
    why: '接一个新 ACP agent 必须同时产出接入文档与四处索引；只加预设不写文档，用户查不到怎么装、有什么限制。',
    trigger: (diffLines) =>
      diffLines.some(
        (line) =>
          line.startsWith('+packages/wechat-daemon/src/agents/brain-presets.ts\t') &&
          /name:\s*["'][a-z0-9_-]+["']/.test(line),
      ),
    // 文档路径根据 name 的值动态生成：docs/接入方案/接入-<name>.md
    dynamicDoc: /name:\s*["']([a-z0-9_-]+)["']/,
    docs: [
      'docs/接入方案/接入其它-ACP-Agent.md §5 agent 表',
      'docs/ai/已知坑.md',
      'docs/README.md 各 agent 实测行',
      'llms.txt',
      'docs/ai/README.md 事实状态表',
    ],
  },
  {
    id: 'cli-command',
    why: '命令是用户直接调用的接口。新增/改名后，README、教程、速查、随包 README 与 AGENTS.md 的命令表都会过时。',
    trigger: (diffLines) =>
      diffLines.some(
        (line) =>
          /^\+packages\/wechat-daemon\/src\/(?:[\w-]+\/)*(manage|chat-commands|chat-command-specs|cli|cli-dispatch)\.ts\t/.test(line) &&
          /case\s+["'][\w-]+["']/.test(line),
      ),
    docs: [
      'README.md 命令速览',
      'docs/使用指南/新手教程.md',
      'docs/使用指南/速查-数据目录与环境变量.md CLI 命令表',
      'packages/wechat-daemon/README.md CLI 命令表',
      'AGENTS.md §3 常用命令',
    ],
  },
  {
    id: 'data-file',
    why: '数据文件（tasks.json、brain-sessions.json 等）的格式或文件名变化会影响升级兼容与排障，文档必须写清。',
    files: ['packages/wechat-ilink-core/src/store/', 'packages/wechat-daemon/src/'],
    trigger: (diffLines) =>
      diffLines.some(
        (line) =>
          /^[MAD] /.test(line) &&
          /(\/store\/|(^|\/)[\w-]+-store\.ts$)/.test(line.slice(2).trim()),
      ),
    docs: [
      'docs/repowiki/08-数据存储与多账号.md',
      'docs/使用指南/速查-数据目录与环境变量.md 数据目录',
      'AGENTS.md §4.12',
    ],
  },
  {
    id: 'behavior-session',
    why: '会话的新建/恢复/改名/删除与交接是用户可见行为；严格恢复、登记表降级这些语义改了就有人踩坑。',
    files: ['packages/wechat-daemon/src/'],
    trigger: (diffLines) =>
      diffLines.some(
        (line) =>
          /^[MAD] /.test(line) &&
          /(session-manager|session-registry|session-map|handoff)\.ts$/.test(line.slice(2).trim()),
      ),
    docs: [
      'docs/repowiki/05-daemon.md（会话管理章节）',
      'docs/ai/已知坑.md 会话四件套',
      'docs/ai/recipes/run-e2e.md 会话验收',
    ],
  },
  {
    id: 'behavior-worker',
    why: '多任务、任务编号、进程池回收、中断续跑都是用户可见行为，且默认行为改一次就可能吞消息或烧额度。',
    files: ['packages/wechat-daemon/src/'],
    trigger: (diffLines) =>
      diffLines.some(
        (line) =>
          /^[MAD] /.test(line) &&
          /(worker-pool|worker-acp|task-manager)\.ts$/.test(line.slice(2).trim()),
      ),
    docs: [
      'docs/repowiki/07-远程任务-Worker.md',
      'docs/ai/已知坑.md 多任务并行 / 寻址',
      'docs/ai/recipes/run-e2e.md 任务验收',
    ],
  },
  {
    id: 'behavior-brain',
    why: 'ACP 协议层（帧、超时、反向请求、回放）是 brain 与 worker 共用的，改一处会影响所有 agent 的接入结论。',
    files: ['packages/wechat-daemon/src/'],
    trigger: (diffLines) =>
      diffLines.some(
        (line) =>
          /^[MAD] /.test(line) &&
          /(acp-brain|acp-connection|acp-reverse|acp-switch|acp-quiet)\.ts$/.test(line.slice(2).trim()),
      ),
    docs: [
      'docs/repowiki/06-ACP-大脑与副本.md',
      'docs/ai/已知坑.md 热切换大脑',
      'docs/ai/recipes/run-e2e.md brain check 验收',
    ],
  },
  {
    id: 'brain-split',
    why: '大脑的选择、持久化、运行状态与预检规则变了，`wemind brain`/`wemind list` 的行为说明就得跟着改。',
    files: ['packages/wechat-daemon/src/'],
    trigger: (diffLines) =>
      diffLines.some(
        (line) =>
          /^[MAD] /.test(line) &&
          /(agent-slot|brain-config|brain-state|brain-check)\.ts$/.test(line.slice(2).trim()),
      ),
    docs: ['docs/repowiki/06-ACP-大脑与副本.md 大脑配置', 'AGENTS.md §4.12'],
  },
  {
    id: 'script',
    why: '脚本的用法写在文档里；改了参数或语义，照着文档跑的人会失败。',
    trigger: (diffLines) =>
      diffLines.some(
        (line) => /^[MAD] /.test(line) && /^scripts\/[\w.-]+\.(ps1|mjs)$/.test(line.slice(2).trim()),
      ),
    // 开发守卫脚本写进开发指南，运维脚本写进部署运维；改任意一处即可。
    anyOf: true,
    docs: [
      'docs/repowiki/11-开发指南.md',
      'docs/repowiki/10-部署与运维.md',
      'docs/部署与运维/daemon-常驻原理.md',
      'AGENTS.md §3 常用命令',
    ],
  },
  {
    id: 'new-doc',
    why: '新文档不进总索引等于不存在；断链检查查不出「没被索引」。',
    trigger: (diffLines) =>
      diffLines.some(
        (line) => line.startsWith('A ') && /^docs\/.*\.md$/.test(line.slice(2).trim()),
      ),
    docs: ['docs/README.md', 'llms.txt'],
  },
  {
    id: 'release',
    why: '版本号是发布流程的单一来源（只改 packages/wechat-daemon/package.json）；变更记录与发版手册必须同步。',
    trigger: (diffLines) =>
      diffLines.some(
        (line) =>
          /^\+packages\/[^\t]*package\.json\t/.test(line) &&
          /"?version"?:\s*["'][\d.]+["']/.test(line),
      ),
    files: ['packages/'],
    docs: ['docs/发布与变更记录/CHANGELOG.md', 'docs/发布与变更记录/如何发布新版本.md'],
  },
  {
    id: 'restructure',
    why: '目录重构后，文档里大量源码路径引用会失效；普通规则只看新增行，识别不了「移动」。',
    files: ['packages/wechat-daemon/src/'],
    // 触发条件（两条满足其一）：
    //   1. git diff --name-status -M 出现 R（重命名/移动）；
    //   2. src/ 下删除 + 新增的文件合计超过 5 个（拆分、合并、目录迁移）。
    trigger: (diffLines) => {
      const touched = diffLines.filter((line) => /^[MADR] /.test(line));
      if (touched.some((line) => line.startsWith('R '))) return true;
      const addOrDelete = touched.filter(
        (line) =>
          /^[AD] /.test(line) && line.slice(2).trim().startsWith('packages/wechat-daemon/src/'),
      );
      return addOrDelete.length > 5;
    },
    anyOf: true,
    docs: [
      'AGENTS.md §2 仓库地图',
      'docs/ai/代码地图.md',
      'docs/ai/README.md 代码导航',
      'docs/repowiki/02-系统架构.md',
    ],
    // --check 只要求上述三个文档至少改一个；完整核对清单另由设计文档提供：
    // docs/设计文档/源码目录分层设计.md §9
    note: '至少同步一个目录结构文档；并对照源码目录分层设计 §9 的完整清单逐项核对（历史快照文档只加「当时路径」说明，不改正文）。',
  },
  {
    id: 'build-config',
    why: '构建拓扑（JIT 源码包/内联/emit 开关）变了，README、开发指南与发布手册里的构建步骤和产物说明会一起失效。',
    // 只看构建配置本身：普通源码、依赖版本、测试 fixture 不触发。
    files: [
      'package.json',
      'packages/wechat-ilink-core/package.json',
      'packages/wechat-daemon/package.json',
      'packages/wechat-mcp/package.json',
      'packages/wechat-ilink-core/tsconfig.json',
      'packages/wechat-daemon/tsconfig.json',
      'packages/wechat-mcp/tsconfig.json',
      'packages/wechat-daemon/tsdown.config.ts',
      'packages/wechat-mcp/tsdown.config.ts',
    ],
    trigger: (diffLines) =>
      diffLines.some(
        (line) =>
          line.startsWith('+') &&
          /(?:"(?:main|types|exports|build|files|noEmit)"\s*:|(?:alwaysBundle|failOnWarn)\s*:)/.test(
            line,
          ),
      ),
    anyOf: true,
    docs: [
      'AGENTS.md §0 / §2 / §3 / §4.20（构建拓扑）',
      'docs/ai/README.md 包表',
      'docs/repowiki/11-开发指南.md §11.2–11.3',
      'README.md 项目结构与本地开发',
      'packages/wechat-ilink-core/README.md 安装',
      'docs/发布与变更记录/如何发布新版本.md',
      'docs/ai/已知坑.md',
      'docs/ai/验收清单.md 构建拓扑行',
    ],
    note: '至少同步一处；完整核对清单见 AGENTS.md §4.20。',
  },
];

/**
 * 豁免理由白名单。
 *
 * 为什么允许豁免：没有豁免的检查一定会被 `git commit --no-verify` 绕过，机制等于零。
 * 为什么只有这三种：它们都表示「行为语义没变」，文档确实不需要跟。
 * 其它任何理由（如「时间不够」）都不放行。
 */
export const VALID_ESCAPE_HATCH_REASONS = /^(Pure refactor|Comment only|Test update)$/i;

/**
 * 内容级校验：已废弃结论登记表（2026-11-15）。
 *
 * 为什么需要：`RULES` 只判断「规则要求的文档有没有出现在 diff 里」，不读内容。本次审查出现过两种假绿——
 * 「文档确实改了，但只换术语、旧结论原封不动」，以及「提交信息写 `Docs-Impact: none — Pure refactor` 跳过整条分支」。
 * 这里登记「已经被推翻、且现行结论有权威出处」的具体措辞，`--check` 时读工作树最终内容逐行核对。
 *
 * 每条字段：
 *   id       登记项名（出现在输出里）
 *   since    结论作废日期
 *   why      现行结论与权威文档位置（报错时打印，告诉人该改成什么）
 *   pattern  逐行匹配的旧措辞（RegExp，不要带 g；尽量精确，避免否定语境误报）
 *   allow    允许保留旧措辞的位置，每项：
 *            path        精确路径或 RegExp
 *            section     可选；命中行所在最近的一级/二级标题必须匹配（如 CHANGELOG 已发布版本段）
 *            linePattern 可选；命中行本身必须匹配（如同一行已带补注）
 *            marker      可选；文件全文必须出现这个标记（约定还在，allow 才生效）
 *            why         为什么可以保留（必须写，报错时会提示）
 *
 * `allow.marker` 是「约定」的机器化表达：CHANGELOG 已发布段能保留旧结论，依据是文件头「版本边界」声明；
 * 历史归档清单能保留已删文件名，依据是它自己的「只加标注」体例与后续变更注记。声明或注记被删掉，allow 立即失效。
 * 新增旧措辞时优先改正文；只有确实属于「已发布段 / 归档索引 / 测试反例」才登记 allow。
 *
 * 豁免边界：`Docs-Impact: none` 只作用于 `RULES` 的路径检查，不适用于这里（见 doc-impact.mjs 的 staleBlocksCheck）。
 */
export const STALE_FACTS = [
  {
    id: 'copilot-acp-mcp-old',
    since: '2026-11-15',
    why: 'Copilot CLI 1.0.108 实测不加载 ACP session/new.mcpServers 的 stdio 条目，MCP 改走配置文件（acpMcpServers: false + mcpDelivery: "config"），真机微信 E2E 已通过；见 docs/接入方案/接入-Copilot.md 与 CHANGELOG 的 Unreleased/Changed。',
    pattern: /1\.0\.107(?!\d)|其 stdio MCP 探针实测可用|图片能力仍依赖模型实测|真实微信 brain\/worker E2E 尚待验证|通过 ACP 激活 MCP 并排除/,
    allow: [
      {
        path: 'docs/发布与变更记录/CHANGELOG.md',
        section: /^## \[(?!Unreleased)/,
        marker: /\*\*版本边界\*\*/,
        why: 'CHANGELOG.md:5 版本边界：已发布段只记该版本发布时的行为，不回改；订正写进 Unreleased。',
      },
      {
        path: 'docs/设计文档/文档守卫设计.md',
        linePattern: /2026-11-15 补注|守卫自身/,
        marker: /2026-11-15 补注（守卫自身/,
        why: '守卫设计文档的 2026-11-15 补注引用本规则的正则字面量本身（解释现行口径），不是那条废弃的 Copilot 结论；补注被删掉 allow 立即失效。',
      },
      {
        path: 'docs/审查与质量记录/审查-2026-11-05-经验与约束.md',
        linePattern: /2026-11-15 补注/,
        marker: /2026-11-15 补注（守卫自身口径）/,
        why: '审计记录按体例只加 2026-11-15 补注，同样引用正则字面量说明现行口径；历史正文与表格原样保留，补注被删掉 allow 立即失效。',
      },
    ],
  },
  {
    id: 'src-subdir-count-6',
    since: '2026-11-15',
    why: '新增 agents/config/ 后 src/ 为 8 个一级 + 7 个二级目录；见 docs/repowiki/01-项目概览.md 与 docs/设计文档/源码目录分层设计.md §13 补注。索引类文档必须写现行值。',
    pattern: /6 个二级|6 subdirectories/,
    allow: [
      {
        path: 'docs/发布与变更记录/CHANGELOG.md',
        section: /^## \[(?!Unreleased)/,
        marker: /\*\*版本边界\*\*/,
        why: '已发布段按版本边界保留 2026-11-06 当时的统计口径。',
      },
      {
        path: 'docs/设计文档/源码目录分层设计.md',
        marker: /2026-11-15 补注/,
        why: '§1 目标与 §13 修订差异表保留 2026-11-06 实施时的统计；文件末尾 2026-11-15 补注已写现行 7 个二级目录。',
      },
    ],
  },
  {
    id: 'deleted-mvp-doc-ref',
    since: '2026-11-15',
    why: '该 MVP 设计文档已删除；现行设计见 docs/设计文档/远程任务-human-in-the-loop设计与实现.md。历史段/归档索引按各自体例只加标注、不改正文。',
    pattern: /方案C-MVP-远程human-in-the-loop\.md/,
    allow: [
      {
        path: 'docs/发布与变更记录/CHANGELOG.md',
        section: /^## \[(?!Unreleased)/,
        marker: /\*\*版本边界\*\*/,
        why: '已发布段按版本边界保留发布当时的源码路径与文档指针。',
      },
      {
        path: 'docs/审查与质量记录/历史文档清单-2026-11-04.md',
        marker: /后续变更（2026-11-15）/,
        why: '归档索引按「只加标注、不改写当时的设计背景」体例处理；头部 2026-11-15 后续变更注记说明文件已删除与现行设计位置。',
      },
    ],
  },
  {
    id: 'empty-config-fingerprint',
    since: '2026-11-15',
    why: 'configFingerprint() 现在把 ag.name + rt.mode 与显式配置文件、overlay 一起哈希：没有 homeEnvVar 的 Agent 也返回非空指纹，homeMode 变化会触发进程重建；见 AGENTS.md §4.14 与 docs/repowiki/06-ACP-大脑与副本.md。',
    // 只拦「旧断言」：正文里说明「不再 / 不返回 / 仍返回非空」的现行口径不参与命中。
    pattern: /^(?!.*(?:不再|不返回|仍返回非空|不恒为)).*返回空指纹/,
    allow: [
      {
        path: 'docs/发布与变更记录/CHANGELOG.md',
        section: /^## \[(?!Unreleased)/,
        marker: /\*\*版本边界\*\*/,
        why: '已发布段按版本边界保留当时行为，不回改。',
      },
    ],
  },
  {
    id: 'doubled-fuben-label',
    since: '2026-11-15',
    why: '「沙箱」全局改名为「账号副本」时把运行日志与注释里的「副本」叠成了重复词；现行文案见 managed-common.ts，并由 managed-common.test.ts 静态断言兜底。',
    pattern: /副本副本/,
    allow: [
      {
        path: /\.test\.ts$/,
        why: '测试用例故意保留反例字符串，用于断言源码里不再出现它。',
      },
    ],
  },
];
