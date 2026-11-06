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
          line.startsWith('+packages/wechat-daemon/src/brain-agents.ts\t') &&
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
          /^\+packages\/wechat-daemon\/src\/(manage|chat-commands|cli|cli-dispatch)\.ts\t/.test(line) &&
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
      'docs/repowiki/06-ACP-大脑与沙箱.md',
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
    docs: ['docs/repowiki/06-ACP-大脑与沙箱.md 大脑配置', 'AGENTS.md §4.12'],
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
    // --check 只要求上述三个文档至少改一个；完整核对清单另由方案文档提供：
    // docs/审查与质量记录/方案-源码目录重构-2026-11-05.md §4 步骤 4（14 个文件、87 处引用）
    note: '至少同步一个目录结构文档；并对照重构方案 §4 步骤 4 的完整清单逐项核对（历史快照文档只加「当时路径」说明，不改正文）。',
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
