import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * P3 守卫：per-agent 代码只能在 `agents/adapters/`、`definitions/` 与注册表里出现。
 * 核心解析/副本/指纹/附件/提示不允许再按 agent 名分支——否则「新 agent 不用改核心」会慢慢失效。
 *
 * 只扫**注释之外**的代码：注释里解释某个 agent 的实测结论是允许的，也应当保留。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "..");

const CORE_FILES = [
  "agents/brain-agents.ts",
  "agents/managed/mcp-brain.ts",
  "agents/managed/mcp-worker.ts",
  "agents/managed/managed-common.ts",
  "agents/managed/mcp-adapters.ts",
  "agents/config/config-fingerprint.ts",
  "daemon/messaging/attachments.ts",
  "acp/brain-check.ts",
  "cli/subcommands/cli-agent.ts",
  "cli/subcommands/cli-brain.ts",
];

const NAMES = [
  "kiro",
  "deepseek",
  "opencode",
  "qoder",
  "cline",
  "gemini",
  "copilot",
  "claude-code",
  "codex",
  "pi",
];

function codeOnly(file: string): string {
  return fs
    .readFileSync(path.join(SRC, file), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("P3 分支守卫", () => {
  it("核心代码不按 agent 名比较/分支", () => {
    const problems: string[] = [];
    for (const file of CORE_FILES) {
      const code = codeOnly(file);
      if (/\.name\s*(===|!==|==|!=)\s*["']/.test(code))
        problems.push(`${file}: 出现按 .name 的字符串比较`);
      if (new RegExp(`case\\s*["'](?:${NAMES.join("|")})["']`).test(code))
        problems.push(`${file}: 出现按 agent 名的 switch case`);
    }
    expect(problems).toEqual([]);
  });

  it("agent 专属参数/文件名只在内置 adapter 与定义里", () => {
    const reserved = [
      "KIRO_CLI_BIN",
      "--trust-all-tools",
      "session-persistence-jsonl",
      "dsh.cmd",
      "opencode.json",
    ];
    for (const file of CORE_FILES) {
      const code = codeOnly(file);
      for (const token of reserved)
        expect(code.includes(token), `${file} 不应再包含 ${token}`).toBe(false);
    }
    const adapter = codeOnly("agents/adapters/builtin.ts");
    expect(adapter).toContain("KIRO_CLI_BIN");
    expect(adapter).toContain("--trust-all-tools");
    expect(adapter).toContain("session-persistence-jsonl");
  });

  it("自动探测顺序由注册表从内置 adapter 派生", () => {
    const brainAgents = codeOnly("agents/brain-agents.ts");
    expect(brainAgents).not.toContain("export const AUTO_PROBE_ORDER");
    const registry = codeOnly("agents/agent-registry.ts");
    expect(registry).toContain("export const AUTO_PROBE_ORDER");
    expect(registry).toContain("hints?.autoProbe");
  });
});
