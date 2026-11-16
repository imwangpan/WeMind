import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  GIT_MAX_BUFFER,
  checkStaleFacts,
  commitMessageCoversDiff,
  docPathOf,
  isStaleHitAllowed,
  isStaleScanPath,
  matchRules,
  normalizeDocName,
  parseAddedLines,
  parseLsFiles,
  parseEscapeHatch,
  parseEscapeHatchEnv,
  parseNameStatus,
  readEscapeHatch,
  staleBlocksCheck,
  toRuleInput,
  unquoteGitPath,
} from "./doc-impact.mjs";
import { RULES, STALE_FACTS } from "./doc-impact.rules.mjs";
import {
  checkDocContent,
  checkIndexes,
  extractPresetNames,
  findDocForPreset,
  normName,
} from "./check-agent-docs.mjs";
import {
  collectCliCommands,
  collectWechatCommands,
  extractBlock,
  extractDefault,
  parsePresetRows,
  renderEnvVarsTable,
  replaceBlock,
} from "./gen-docs-tables.mjs";

describe("doc-impact 解析", () => {
  it("git diff 缓冲大于 Node 默认 1MB（大分支不再 ENOBUFS）", () => {
    expect(GIT_MAX_BUFFER).toBeGreaterThan(1024 * 1024);
  });

  it("解析 name-status：普通状态与重命名", () => {
    const files = parseNameStatus(
      ["M\tpackages/a.ts", "R100\tpackages/old.ts\tpackages/new.ts", "A\tREADME.md"].join("\n"),
    );
    expect(files).toEqual([
      { status: "M", path: "packages/a.ts" },
      { status: "R", oldPath: "packages/old.ts", path: "packages/new.ts" },
      { status: "A", path: "README.md" },
    ]);
  });

  it("中文路径即使被 git 加引号也能还原，规则才能对上", () => {
    const quoted =
      '"docs/repowiki/06-ACP-\\345\\244\\247\\350\\204\\221\\344\\270\\216\\345\\211\\257\\346\\234\\254.md"';
    expect(unquoteGitPath(quoted)).toBe("docs/repowiki/06-ACP-大脑与副本.md");
    expect(parseNameStatus(`M\t${quoted}`)).toEqual([
      { status: "M", path: "docs/repowiki/06-ACP-大脑与副本.md" },
    ]);
  });

  it("新增行带上文件路径，跳过 +++ 文件头", () => {
    const diff = [
      "+++ b/packages/a.ts",
      "+const x = process.env.NEW_FLAG;",
      "+++ b/scripts/x.mjs",
      "+if (process.env.NEW_FLAG) {}",
    ].join("\n");
    expect(parseAddedLines(diff)).toEqual([
      "+packages/a.ts\tconst x = process.env.NEW_FLAG;",
      "+scripts/x.mjs\tif (process.env.NEW_FLAG) {}",
    ]);
  });

  it("合成规则输入：状态行 + 新增行", () => {
    const input = toRuleInput([{ status: "M", path: "a.ts" }], ["+a.ts\tx"]);
    expect(input).toEqual(["M a.ts", "+a.ts\tx"]);
  });

  it("从文档条目取路径，忽略章节说明", () => {
    expect(docPathOf("docs/repowiki/05-daemon.md（会话管理章节）")).toBe(
      "docs/repowiki/05-daemon.md",
    );
    expect(docPathOf("AGENTS.md §4.11 控制桥")).toBe("AGENTS.md");
    expect(docPathOf("docs/ai/已知坑.md 会话四件套")).toBe("docs/ai/已知坑.md");
    expect(docPathOf("llms.txt")).toBe("llms.txt");
  });

  it("豁免声明：合法与非法理由", () => {
    expect(parseEscapeHatch("Docs-Impact: none — Pure refactor")).toMatchObject({
      status: "none",
      valid: true,
    });
    expect(parseEscapeHatch("Docs-Impact: none — 时间不够")).toMatchObject({ valid: false });
    expect(parseEscapeHatch("普通提交信息")).toBeNull();
  });

  it("豁免声明（环境变量）：只写理由也能解析", () => {
    expect(parseEscapeHatchEnv("none — Pure refactor")).toMatchObject({
      status: "none",
      valid: true,
    });
    expect(parseEscapeHatchEnv("Docs-Impact: none — Test update")).toMatchObject({
      status: "none",
      valid: true,
    });
    expect(parseEscapeHatchEnv("none — 时间不够")).toMatchObject({ valid: false });
    expect(parseEscapeHatchEnv("")).toBeNull();
  });

  it("多提交分支不认最近一次提交的豁免", () => {
    expect(
      readEscapeHatch({
        staged: false,
        allowCommitMessage: false,
        lastCommitMessage: "Docs-Impact: none — Comment only",
        env: {},
      }),
    ).toBeNull();
  });

  it("单提交但工作区有未提交改动、或有范围内的未跟踪文件时，提交信息也不覆盖本次 diff", () => {
    expect(commitMessageCoversDiff({ commitCount: 1, dirty: false })).toBe(true);
    expect(commitMessageCoversDiff({ commitCount: 1, dirty: true })).toBe(false);
    expect(commitMessageCoversDiff({ commitCount: 2, dirty: false })).toBe(false);
    expect(
      commitMessageCoversDiff({ commitCount: 1, dirty: false, untrackedInScope: false }),
    ).toBe(true);
    expect(
      commitMessageCoversDiff({ commitCount: 1, dirty: false, untrackedInScope: true }),
    ).toBe(false);
  });

  it("git ls-files 的 C 风格引号路径先还原，空行与目录项丢掉", () => {
    const quoted = '"docs/repowiki/06-ACP-\\345\\244\\247\\350\\204\\221\\344\\270\\216\\345\\211\\257\\346\\234\\254.md"';
    expect(parseLsFiles([quoted, "", "scripts/", "docs/x.md"].join("\n"))).toEqual([
      "docs/repowiki/06-ACP-大脑与副本.md",
      "docs/x.md",
    ]);
  });

  it("单提交范围仍认提交信息；env 显式声明始终生效", () => {
    expect(
      readEscapeHatch({
        staged: false,
        allowCommitMessage: true,
        lastCommitMessage: "Docs-Impact: none — Comment only",
        env: {},
      }),
    ).toMatchObject({ status: "none", valid: true });
    expect(
      readEscapeHatch({
        staged: false,
        allowCommitMessage: false,
        lastCommitMessage: "",
        env: { DOCS_IMPACT_MESSAGE: "none — Pure refactor" },
      }),
    ).toMatchObject({ status: "none", valid: true });
  });
});

describe("doc-impact 规则匹配", () => {
  const match = (lines) =>
    matchRules(
      RULES,
      lines,
      lines.filter((l) => l.startsWith("+")),
    );

  it("环境变量只在包源码里触发", () => {
    expect(match(["+packages/wechat-daemon/src/a.ts\tprocess.env.NEW_FLAG"])).toHaveLength(1);
    expect(match(["+scripts/guard.mjs\tprocess.env.NEW_FLAG"])).toHaveLength(0);
  });

  it("规则声明 files 时只看这些目录", () => {
    const outside = match(["M packages/wechat-mcp/src/foo-store.ts"]).map((h) => h.rule.id);
    expect(outside).not.toContain("data-file");
    const inside = match(["M packages/wechat-daemon/src/tasks/task-store.ts"]).map(
      (h) => h.rule.id,
    );
    expect(inside).toContain("data-file");
  });

  it("新增脚本触发 script 规则", () => {
    const hit = match(["A scripts/new-guard.mjs"]);
    expect(hit.map((h) => h.rule.id)).toContain("script");
  });

  it("重命名触发 restructure", () => {
    const hit = match(["R packages/wechat-daemon/src/acp/acp-brain.ts"]);
    expect(hit.map((h) => h.rule.id)).toContain("restructure");
  });

  it("src/ 下增删超过 5 个文件也触发 restructure", () => {
    const lines = Array.from({ length: 6 }, (_, i) => `A packages/wechat-daemon/src/new/${i}.ts`);
    expect(match(lines).map((h) => h.rule.id)).toContain("restructure");
  });

  it("预设只在 brain-presets.ts 里触发，并标记动态文档", () => {
    const hit = match([
      '+packages/wechat-daemon/src/agents/brain-presets.ts\t  acme: { name: "acme",',
    ]);
    expect(hit.map((h) => h.rule.id)).toContain("preset");
    expect(hit.find((h) => h.rule.id === "preset").dynamic).toBe(true);
    expect(hit.find((h) => h.rule.id === "preset").dynamicNames).toEqual(["acme"]);
  });

  it("构建拓扑配置变化触发 build-config", () => {
    const hit = match([
      '+packages/wechat-ilink-core/package.json\t  "exports": {',
      '+packages/wechat-daemon/tsconfig.json\t  "noEmit": true,',
      "+packages/wechat-daemon/tsdown.config.ts\t  failOnWarn: true,",
    ]);
    expect(hit.map((h) => h.rule.id)).toContain("build-config");
  });

  it("build-config 不看普通源码与依赖版本", () => {
    const fromSrc = match(["+packages/wechat-daemon/src/a.ts\tconst files = 1;"]);
    expect(fromSrc.map((h) => h.rule.id)).not.toContain("build-config");
    const fromVersion = match(['+packages/wechat-daemon/package.json\t  "version": "1.6.1",']);
    expect(fromVersion.map((h) => h.rule.id)).not.toContain("build-config");
  });

  it("接入文档名归一化：大小写与连字符不参与比较", () => {
    expect(normalizeDocName("docs/接入方案/接入-ClaudeCode.md")).toBe(
      normalizeDocName("接入-claude-code.md"),
    );
  });
});

describe("check-agent-docs", () => {
  it("解析预设名（含带连字符的键）", () => {
    const source = [
      "export const ACP_AGENT_PRESETS: Record<string, AcpAgentPreset> = {",
      "  kiro: {",
      '    name: "kiro",',
      "  },",
      '  "claude-code": {',
      '    name: "claude-code",',
      "  },",
      "};",
    ].join("\n");
    expect(extractPresetNames(source)).toEqual(["kiro", "claude-code"]);
  });

  it("按文件名归一化匹配文档", () => {
    expect(normName("claude-code")).toBe(normName("ClaudeCode"));
    const docs = [{ file: "docs/接入方案/接入-ClaudeCode.md", text: "..." }];
    expect(findDocForPreset("claude-code", docs)?.file).toBe("docs/接入方案/接入-ClaudeCode.md");
  });

  it("完整文档无缺口；缺小节会报错", () => {
    const ok = [
      "> **最后核对**：2026-11-06 ｜ **实测环境**：Windows ｜ **状态**：已实测",
      "## 1. 安装",
      "## 2. 预设",
      "## 3. 探针结论",
      "## 4. 已知限制",
      "## 5. 验证",
      "## 待实测",
      "无",
    ].join("\n");
    expect(checkDocContent(ok)).toEqual([]);
    expect(checkDocContent("## 1. 安装\n")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("实测环境"),
        expect.stringContaining("待实测"),
      ]),
    );
  });

  it("索引缺一处就报错", () => {
    const errors = checkIndexes("acme", "接入-acme", {
      "AGENTS.md": "acme",
      "llms.txt": "没有",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("llms.txt");
  });
});

describe("gen-docs-tables", () => {
  it("提取默认值：字符串、数字、空串与不可判定", () => {
    expect(extractDefault('const a = process.env.X ?? "y";', "X")).toBe("y");
    expect(extractDefault("const a = Number(process.env.X) || 120_000;", "X")).toBe("120000");
    expect(extractDefault('const a = process.env.X ?? "";', "X")).toBe("");
    expect(extractDefault('const a = process.env.X?.trim() || read() || "";', "X")).toBeNull();
  });

  it("CLI 命令过滤 flag 别名", () => {
    const source = 'case "version":\ncase "--version":\ncase "brain":';
    expect(collectCliCommands(source)).toEqual(["brain", "version"]);
  });

  it("微信指令取 zh 与 brief", () => {
    const source = 'id: "mcp.add",\n section: "mcp",\n zh: "加载 <名字>",\n brief: "加载一个 MCP",';
    expect(collectWechatCommands(source)).toEqual([
      { id: "mcp.add", zh: "加载 <名字>", brief: "加载一个 MCP" },
    ]);
  });

  it("表格：空串默认值显示为双引号", () => {
    const table = renderEnvVarsTable([
      { name: "A", defaultValue: null, location: "x.ts:1" },
      { name: "B", defaultValue: "", location: "x.ts:2" },
    ]);
    expect(table).toContain("| `A` | — |");
    expect(table).toContain('| `B` | `""` |');
  });

  it("预设行解析 bin 与 args", () => {
    const source = [
      "export const ACP_AGENT_PRESETS = {",
      "  acme: {",
      '    name: "acme",',
      '    bin: "acme-cli",',
      '    args: ["acp", "--yolo"],',
      "  },",
      "};",
    ].join("\n");
    expect(parsePresetRows(source)).toEqual([
      { name: "acme", bin: "acme-cli", args: "acp --yolo" },
    ]);
  });

  it("标记块替换与提取可往返", () => {
    const original = "before\n<!-- BEGIN:auto x -->\nold\n<!-- END:auto x -->\nafter";
    const replaced = replaceBlock(original, "x", "new");
    expect(replaced).toContain("new");
    expect(extractBlock(replaced, "x")).toBe("new");
    expect(replaceBlock("no marker", "x", "new")).toBeNull();
  });
});

describe("doc-impact 内容级校验（STALE_FACTS）", () => {
  const fact = (overrides = {}) => ({
    id: "stale-demo",
    since: "2026-11-15",
    why: "现行结论见 docs/x.md",
    pattern: /旧结论/,
    allow: [],
    ...overrides,
  });

  it("只扫结论会写在里面的文件；scripts/ 的 pattern 字面量不会自命中", () => {
    expect(isStaleScanPath("AGENTS.md")).toBe(true);
    expect(isStaleScanPath("README.md")).toBe(true);
    expect(isStaleScanPath("llms.txt")).toBe(true);
    expect(isStaleScanPath("docs/ai/已知坑.md")).toBe(true);
    expect(isStaleScanPath("packages/wechat-daemon/README.md")).toBe(true);
    expect(isStaleScanPath("packages/wechat-daemon/src/agents/managed/managed-common.ts")).toBe(true);
    expect(isStaleScanPath("scripts/doc-impact.rules.mjs")).toBe(false);
    expect(isStaleScanPath("scripts/doc-guards.test.mjs")).toBe(false);
    expect(isStaleScanPath("scripts/doc-impact.mjs")).toBe(false);
    expect(isStaleScanPath("scripts/README.md")).toBe(true);
    expect(isStaleScanPath(".worktrees/x/docs/a.md")).toBe(false);
    expect(isStaleScanPath("packages/a/node_modules/x/README.md")).toBe(false);
    expect(isStaleScanPath("packages/a/dist/cli.js")).toBe(false);
  });

  it("命中报「文件:行号」并带现行结论，命中行按 trim 截断", () => {
    const hits = checkStaleFacts([fact()], [
      { path: "docs/x.md", content: "# 标题\n\n正文写着旧结论，还有一句。\n" },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id: "stale-demo",
      since: "2026-11-15",
      why: "现行结论见 docs/x.md",
      path: "docs/x.md",
      line: 3,
    });
    expect(hits[0].text).toContain("旧结论");
  });

  it("allow.marker 命中时放行；标记被删掉 allow 立即失效", () => {
    const f = fact({
      allow: [{ path: "docs/x.md", marker: /版本边界/, why: "已发布段按版本边界保留" }],
    });
    expect(checkStaleFacts([f], [{ path: "docs/x.md", content: "> **版本边界** …\n\n旧结论\n" }])).toEqual([]);
    expect(checkStaleFacts([f], [{ path: "docs/x.md", content: "> 没写约定\n\n旧结论\n" }])).toHaveLength(1);
  });

  it("allow 的 path / section / linePattern / marker 四个条件全满足才放行", () => {
    const allow = [
      {
        path: "docs/x.md",
        section: /^## \[1\.7\.0\]/,
        linePattern: /旧结论/,
        marker: /版本边界/,
        why: "已发布段",
      },
    ];
    const f = fact({ pattern: /旧结论|别的旧说法/, allow });
    const base = "> **版本边界**\n## [1.7.0] 已发布\n旧结论\n";
    expect(checkStaleFacts([f], [{ path: "docs/x.md", content: base }])).toEqual([]);
    expect(checkStaleFacts([f], [{ path: "docs/y.md", content: base }])).toHaveLength(1);
    expect(
      checkStaleFacts([f], [
        { path: "docs/x.md", content: "> **版本边界**\n## [Unreleased] 未发布\n旧结论\n" },
      ]),
    ).toHaveLength(1);
    const mixed = checkStaleFacts([f], [
      { path: "docs/x.md", content: "> **版本边界**\n## [1.7.0] 已发布\n旧结论\n别的旧说法\n" },
    ]);
    expect(mixed).toHaveLength(1);
    expect(mixed[0].line).toBe(4);
    expect(
      checkStaleFacts([f], [
        { path: "docs/x.md", content: "> 没有标记\n## [1.7.0] 已发布\n旧结论\n" },
      ]),
    ).toHaveLength(1);
  });

  it("isStaleHitAllowed 四个条件逐一验证", () => {
    const allow = [
      { path: "docs/x.md", section: /^## A/, linePattern: /旧结论/, marker: /约定/, why: "…" },
    ];
    const ctx = {
      rel: "docs/x.md",
      content: "约定\n## A\n旧结论",
      line: "旧结论",
      section: "## A",
    };
    expect(isStaleHitAllowed(allow, ctx)).toBe(true);
    expect(isStaleHitAllowed(allow, { ...ctx, section: "## B" })).toBe(false);
    expect(isStaleHitAllowed(allow, { ...ctx, line: "别的说法" })).toBe(false);
    expect(isStaleHitAllowed(allow, { ...ctx, content: "缺少标记" })).toBe(false);
    expect(isStaleHitAllowed(allow, { ...ctx, rel: "docs/y.md" })).toBe(false);
  });

  it("allow.path 支持正则：测试里的反例字符串放行，源码里的同名串不放行", () => {
    const f = fact({ pattern: /反例串/, allow: [{ path: /\.test\.ts$/, why: "测试反例" }] });
    const hits = checkStaleFacts([f], [
      { path: "packages/a/src/x.test.ts", content: "反例串\n" },
      { path: "packages/a/src/x.ts", content: "反例串\n" },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe("packages/a/src/x.ts");
  });

  it("代码围栏里的章节标题只是示例，不能伪造已发布章节让 allow 错误放行", () => {
    const f = fact({
      allow: [{ path: "docs/x.md", section: /^## \[1\.7\.0\]/, why: "已发布段" }],
    });
    const content = [
      "## [Unreleased] 未发布",
      "```md",
      "## [1.7.0] 已发布（这只是示例）",
      "旧结论",
      "```",
      "旧结论",
    ].join("\n");
    const hits = checkStaleFacts([f], [{ path: "docs/x.md", content }]);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(6);
  });

  it("复用的 allow 正则重置 lastIndex，带 g 的规则不会跨行串状态", () => {
    const f = fact({
      pattern: /旧结论/g,
      allow: [{ path: "docs/x.md", linePattern: /旧结论/g, marker: /约定/g, why: "…" }],
    });
    const content = "> 约定\n旧结论\n旧结论\n";
    expect(checkStaleFacts([f], [{ path: "docs/x.md", content }])).toEqual([]);
  });

  it("合法豁免也不能放行内容级命中（staleBlocksCheck 刻意不接收豁免结果）", () => {
    const escape = parseEscapeHatch("Docs-Impact: none — Pure refactor");
    expect(escape).toMatchObject({ status: "none", valid: true });
    const hits = checkStaleFacts([fact()], [{ path: "docs/x.md", content: "旧结论\n" }]);
    expect(hits).toHaveLength(1);
    expect(staleBlocksCheck(true, hits)).toBe(true);
    expect(staleBlocksCheck(true, hits, escape)).toBe(true);
    // main() 在 readEscapeHatch() 之前就 return 1；这里用源码顺序钉住，避免将来把内容层挪到豁免之后。
    const src = fs.readFileSync(new URL("./doc-impact.mjs", import.meta.url), "utf8");
    const main = src.slice(src.indexOf("function main(argv)"));
    expect(main.indexOf("staleBlocksCheck")).toBeLessThan(main.indexOf("readEscapeHatch"));
  });

  it("只读模式不拦截，没有命中也不拦截", () => {
    expect(staleBlocksCheck(false, [{ id: "x" }])).toBe(false);
    expect(staleBlocksCheck(true, [])).toBe(false);
    expect(staleBlocksCheck(true, null)).toBe(false);
  });

  it("登记的废弃结论不会误伤同主题的现行/否定语境文案", () => {
    const current = [
      "GitHub Copilot CLI 1.0.108 实测不加载 ACP session/new.mcpServers 的 stdio 条目。",
      "8 个一级目录 + 7 个二级目录（agents/config/ 是第 7 个）。",
      "现行设计见 docs/设计文档/远程任务-human-in-the-loop设计与实现.md。",
      "agents/managed/managed-common.ts 的日志写「副本里的微信 MCP 已剔除」。",
      "不是因为「只支持 http/sse」，而是 stdio 条目根本不加载。",
    ].join("\n");
    expect(checkStaleFacts(STALE_FACTS, [{ path: "docs/x.md", content: current }])).toEqual([]);
  });

  it("CHANGELOG 的版本边界声明是 allow 的依据；删掉后三条旧结论同时报错", () => {
    const content =
      "> **版本边界**：已发布段不回改\n\n## [1.7.0] 已发布\nCopilot CLI 1.0.107 的旧结论；8 个一级 + 6 个二级；详见 方案C-MVP-远程human-in-the-loop.md。\n";
    const file = (text) => ({ path: "docs/发布与变更记录/CHANGELOG.md", content: text });
    expect(checkStaleFacts(STALE_FACTS, [file(content)])).toEqual([]);
    expect(
      checkStaleFacts(STALE_FACTS, [file(content.replace("**版本边界**", "版本说明"))]).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("历史归档清单靠 2026-11-15 后续变更补注放行已删文档指针；删掉补注就报错", () => {
    const f = STALE_FACTS.find((x) => x.id === "deleted-mvp-doc-ref");
    const path = "docs/审查与质量记录/历史文档清单-2026-11-04.md";
    const row = "| 方案C-MVP-远程human-in-the-loop.md | B | 保留原行 |\n";
    const withNote =
      "> **后续变更（2026-11-05）**：…\n>\n> **后续变更（2026-11-15）**：该文档已删除。\n\n" + row;
    expect(checkStaleFacts([f], [{ path, content: withNote }])).toEqual([]);
    expect(
      checkStaleFacts([f], [{ path, content: "> **后续变更（2026-11-05）**：…\n\n" + row }]),
    ).toHaveLength(1);
  });

  it("版本号模式带边界：1.0.1070 不误报", () => {
    expect(
      checkStaleFacts(STALE_FACTS, [
        { path: "docs/x.md", content: "Copilot CLI 1.0.1070 是另一个虚构版本号。\n" },
      ]),
    ).toEqual([]);
  });

  it("「返回空指纹」的旧断言被登记，现行否定语境不误报", () => {
    const f = STALE_FACTS.find((x) => x.id === "empty-config-fingerprint");
    expect(f).toBeDefined();
    expect(
      checkStaleFacts([f], [
        { path: "docs/x.md", content: "`claude-code`/`cline` 没有可重定向配置目录，返回空指纹，改完重启 daemon。\n" },
      ]),
    ).toHaveLength(1);
    const current = [
      "即使没有 `homeEnvVar` 也不再返回空指纹，homeMode 改变会触发进程重建。",
      "没有 `homeEnvVar` 也不返回空指纹，指纹不再恒为空。",
      "没有 homeEnvVar 的 agent 仍返回非空指纹，且 homeMode 改变会让它变化。",
    ].join("\n");
    expect(checkStaleFacts([f], [{ path: "docs/x.md", content: current }])).toEqual([]);
  });

  it("守卫文档补注里引用正则字面量本身放行；删掉补注标记就报错", () => {
    const f = STALE_FACTS.find((x) => x.id === "copilot-acp-mcp-old");
    const design = "docs/设计文档/文档守卫设计.md";
    const audit = "docs/审查与质量记录/审查-2026-11-05-经验与约束.md";
    const withNote = (p, label) => ({
      path: p,
      content: `> **2026-11-15 补注（${label}）**：正则 \`1\\.0\\.107(?!\\d)\` 不误报 \`1.0.1070\`，不会把 \`1.0.107\` 误判为现行结论。\n`,
    });
    expect(checkStaleFacts([f], [withNote(design, "守卫自身解析口径")])).toEqual([]);
    expect(checkStaleFacts([f], [withNote(audit, "守卫自身口径")])).toEqual([]);
    expect(
      checkStaleFacts([f], [
        { path: design, content: "> **2026-11-14 旧说明**：不会把 `1.0.107` 误判为现行结论。\n" },
      ]),
    ).toHaveLength(1);
  });
});
