import { describe, expect, it } from "vitest";

import {
  GIT_MAX_BUFFER,
  commitMessageCoversDiff,
  docPathOf,
  matchRules,
  normalizeDocName,
  parseAddedLines,
  parseEscapeHatch,
  parseEscapeHatchEnv,
  parseNameStatus,
  readEscapeHatch,
  toRuleInput,
  unquoteGitPath,
} from "./doc-impact.mjs";
import { RULES } from "./doc-impact.rules.mjs";
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

  it("单提交但工作区有未提交改动时，提交信息也不覆盖本次 diff", () => {
    expect(commitMessageCoversDiff({ commitCount: 1, dirty: false })).toBe(true);
    expect(commitMessageCoversDiff({ commitCount: 1, dirty: true })).toBe(false);
    expect(commitMessageCoversDiff({ commitCount: 2, dirty: false })).toBe(false);
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
