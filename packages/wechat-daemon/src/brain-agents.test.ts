import { describe, it, expect, afterEach } from "vitest";

import { resolveAgent } from "./brain-agents.js";

const VARS = [
  "WEMIND_BRAIN",
  "WEMIND_BRAIN_BIN",
  "WEMIND_BRAIN_ARGS",
  "WEMIND_BRAIN_SHELL",
  "WEMIND_BRAIN_HOME_ENV",
  "WEMIND_BRAIN_INHERIT",
  "WEMIND_BRAIN_REAL_HOME",
  "WEMIND_BRAIN_INHERIT_DIRS",
  "KIRO_CLI_BIN",
];

const saved: Record<string, string | undefined> = {};
for (const v of VARS) saved[v] = process.env[v];
function clearVars() {
  for (const v of VARS) delete process.env[v];
}

afterEach(() => {
  clearVars();
  for (const v of VARS) if (saved[v] !== undefined) process.env[v] = saved[v];
});

describe("resolveAgent 预设", () => {
  it("默认 kiro：沿用 kiro 约定（沙箱根 / settings/mcp.json / 格式 kiro）", () => {
    clearVars();
    const ag = resolveAgent();
    expect(ag.name).toBe("kiro");
    expect(ag.homeEnvVar).toBe("KIRO_HOME");
    expect(ag.configSubdir).toBe("");
    expect(ag.mcpFormat).toBe("kiro");
    expect(ag.mcpConfigFile).toBe("settings/mcp.json");
    expect(ag.catalogFile).toBe("settings/mcp.json");
    expect(ag.shell).toBe(false);
    expect(ag.env).toEqual({});
  });

  it("opencode：XDG_CONFIG_HOME 隔离 + opencode.json / mcp.servers + 目录与单文件继承", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "opencode";
    const ag = resolveAgent();
    expect(ag.name).toBe("opencode");
    expect(ag.args).toEqual(["acp"]);
    expect(ag.shell).toBe(true); // Windows shim 需经 shell
    expect(ag.homeEnvVar).toBe("XDG_CONFIG_HOME"); // 替换 global，实现隔离
    expect(ag.configSubdir).toBe("opencode"); // 配置落在 <沙箱>/opencode/
    expect(ag.mcpFormat).toBe("opencode");
    expect(ag.mcpConfigFile).toBe("opencode.json");
    expect(ag.catalogFile).toBe("opencode.json");
    expect(ag.inheritDirs).toEqual(["skills", "agents", "commands"]);
    expect(ag.inheritFiles).toEqual(["AGENTS.md"]);
    expect(ag.env).toEqual({ OPENCODE_DISABLE_PROJECT_CONFIG: "1" });
  });

  it("环境变量可覆盖继承目录清单", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "opencode";
    process.env.WEMIND_BRAIN_INHERIT_DIRS = "skills,foo";
    expect(resolveAgent().inheritDirs).toEqual(["skills", "foo"]);
  });
});
