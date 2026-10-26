import { describe, it, expect, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveAgent, agentProblem } from "./brain-agents.js";

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
const savedPath = process.env.PATH;

function clearVars() {
  for (const v of VARS) delete process.env[v];
}

afterEach(() => {
  clearVars();
  for (const v of VARS) if (saved[v] !== undefined) process.env[v] = saved[v];
  if (savedPath !== undefined) process.env.PATH = savedPath;
});

// 独立临时目录，用于「伪造 PATH」验证 auto 探测（不依赖宿主机的真实安装）。
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-brain-test-"));
const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-brain-empty-"));
afterAll(() => {
  fs.rmSync(fakeBin, { recursive: true, force: true });
  fs.rmSync(emptyBin, { recursive: true, force: true });
});

describe("resolveAgent 预设", () => {
  it("显式 kiro：沿用 kiro 约定（沙箱根 / settings/mcp.json / 格式 kiro）", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "kiro";
    const ag = resolveAgent();
    expect(ag.name).toBe("kiro");
    expect(ag.homeEnvVar).toBe("KIRO_HOME");
    expect(ag.configSubdir).toBe("");
    expect(ag.mcpFormat).toBe("kiro");
    expect(ag.mcpConfigFile).toBe("settings/mcp.json");
    expect(ag.catalogFile).toBe("settings/mcp.json");
    expect(ag.shell).toBe(false);
    expect(ag.env).toEqual({});
    expect(ag.requestedKey).toBe("kiro");
    expect(ag.source).toBe("env");
    expect(ag.known).toBe(true);
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

  it("deepseek：dsh.cmd + DSH_HOME + resume/model/images=false", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "deepseek";
    const ag = resolveAgent();
    expect(ag.name).toBe("deepseek");
    expect(ag.bin).toBe(process.platform === "win32" ? "dsh.cmd" : "dsh");
    expect(ag.args).toEqual(["--profile", "acp"]);
    expect(ag.shell).toBe(true);
    expect(ag.homeEnvVar).toBe("DSH_HOME");
    expect(ag.restore).toBe("resume");
    expect(ag.firstFrameMs).toBe(60_000);
    expect(ag.heartbeatMs).toBe(60_000);
    expect(ag.images).toBe(false);
    expect(ag.credentialFile).toBe(".credentials.yaml");
    expect(ag.model).toBe('["deepseek-account","deepseek-flash"]');
    expect(ag.mcpViaAcp).toBe(true); // MCP 走 session/new|resume 的 mcpServers，不写文件
  });

  it("kiro/opencode：mcpViaAcp 默认 false（仍走沙箱配置文件）", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "kiro";
    expect(resolveAgent().mcpViaAcp).toBe(false);
    process.env.WEMIND_BRAIN = "opencode";
    expect(resolveAgent().mcpViaAcp).toBe(false);
  });

  it("环境变量可覆盖继承目录清单", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "opencode";
    process.env.WEMIND_BRAIN_INHERIT_DIRS = "skills,foo";
    expect(resolveAgent().inheritDirs).toEqual(["skills", "foo"]);
  });
});

describe("resolveAgent 选择来源与优先级", () => {
  it("brain.json（cfg）可选中预设，来源 file", () => {
    clearVars();
    const ag = resolveAgent({ agent: "opencode" });
    expect(ag.name).toBe("opencode");
    expect(ag.requestedKey).toBe("opencode");
    expect(ag.source).toBe("file");
  });

  it("环境变量覆盖 brain.json（source=env）", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "kiro";
    const ag = resolveAgent({ agent: "opencode" });
    expect(ag.name).toBe("kiro");
    expect(ag.source).toBe("env");
  });

  it("brain.json 的 bin/args 覆盖预设细节", () => {
    clearVars();
    const ag = resolveAgent({
      agent: "opencode",
      bin: "/opt/oc",
      args: ["acp", "--x"],
      homeEnvVar: "OC_HOME",
    });
    expect(ag.bin).toBe("/opt/oc");
    expect(ag.args).toEqual(["acp", "--x"]);
    expect(ag.homeEnvVar).toBe("OC_HOME");
  });

  it("未知预设：不再静默回退 kiro，known=false 且 agentProblem 报错", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "opencod"; // 拼错
    const ag = resolveAgent();
    expect(ag.known).toBe(false);
    expect(agentProblem(ag)).toMatch(/未知大脑预设/);
  });
});

describe("resolveAgent auto 探测", () => {
  it("选中 PATH 上第一个可用的预设（伪造 opencode）", () => {
    clearVars();
    fs.writeFileSync(path.join(fakeBin, "opencode"), "");
    process.env.PATH = fakeBin;
    const ag = resolveAgent();
    expect(ag.requestedKey).toBe("auto");
    expect(ag.source).toBe("auto");
    expect(ag.name).toBe("opencode");
    expect(ag.available).toBe(true);
    expect(agentProblem(ag)).toBeNull();
  });

  it("一个都探测不到 → available=false，并给出明确说明", () => {
    clearVars();
    process.env.PATH = emptyBin;
    const ag = resolveAgent();
    expect(ag.requestedKey).toBe("auto");
    expect(ag.available).toBe(false);
    expect(agentProblem(ag)).toMatch(/自动探测/);
  });

  it("显式指定但二进制缺失 → available=false，提示安装/切换", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "kiro";
    process.env.PATH = emptyBin;
    const ag = resolveAgent();
    expect(ag.available).toBe(false);
    expect(agentProblem(ag)).toMatch(/找不到大脑/);
  });
});
