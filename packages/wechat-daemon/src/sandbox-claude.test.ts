import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Claude Code 沙箱：配置目录在 <沙箱>/claude（预设用 CLAUDE_CONFIG_DIR 指到目录本身），
 * MCP 走 ACP session/new|load 的 mcpServers（mcpViaAcp=true）——**不写** settings.json / mcp.json；
 * 目录取真实 ~/.claude.json（与 realHome 同级，预设 catalogFile="../.claude.json"）。
 * 模块级常量在 import 时解析，故先设环境再动态导入（同 sandbox-cline.test.ts）。
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-sandbox-claude-"));
const realHome = path.join(root, "real-claude");
const dataDir = path.join(root, "data");
const brainCfg = path.join(dataDir, "brain-home", "claude");
const workerCfg = path.join(dataDir, "worker-home", "claude");
const realClaudeJson = path.join(root, ".claude.json");

const claudeJson = {
  mcpServers: {
    wechat: { command: "wemind-mcp" },
    demo: { command: "node", args: ["demo-server.js"], env: { DEMO: "1" } },
    off: { command: "x", disabled: true },
  },
};

beforeAll(() => {
  for (const d of ["skills", "agents", "commands"]) {
    fs.mkdirSync(path.join(realHome, d), { recursive: true });
    fs.writeFileSync(path.join(realHome, d, "sample.md"), `# ${d}\n`);
  }
  fs.writeFileSync(path.join(realHome, "CLAUDE.md"), "# memory\n");
  fs.writeFileSync(path.join(realHome, ".credentials.json"), JSON.stringify({ token: "x" }));
  fs.writeFileSync(realClaudeJson, JSON.stringify(claudeJson));

  process.env.WEMIND_BRAIN = "claude-code";
  process.env.WEMIND_WORKER_BRAIN = "claude-code";
  process.env.WEMIND_BRAIN_REAL_HOME = realHome;
  process.env.WECHAT_DATA_DIR = dataDir;
  delete process.env.WEMIND_BRAIN_INHERIT;
  delete process.env.WEMIND_MCP_CATALOG;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.WEMIND_BRAIN;
  delete process.env.WEMIND_WORKER_BRAIN;
  delete process.env.WEMIND_BRAIN_REAL_HOME;
  delete process.env.WECHAT_DATA_DIR;
});

const readJson = (f: string): Record<string, any> => JSON.parse(fs.readFileSync(f, "utf-8"));

describe("brain 沙箱（Claude Code）", () => {
  it("CLAUDE.md/skills/agents/commands 与日常共用；OAuth 凭据进沙箱", async () => {
    const { ensureBrainHome } = await import("./mcp-sandbox.js");
    ensureBrainHome();

    expect(fs.readFileSync(path.join(brainCfg, "CLAUDE.md"), "utf-8")).toBe("# memory\n");
    for (const d of ["skills", "agents", "commands"]) {
      expect(fs.readFileSync(path.join(brainCfg, d, "sample.md"), "utf-8")).toBe(`# ${d}\n`);
    }
    expect(readJson(path.join(brainCfg, ".credentials.json"))).toEqual({ token: "x" });

    // 写入共享目录会落到真实目录（junction/symlink）
    const probe = path.join(brainCfg, "skills", "written-by-brain.md");
    fs.writeFileSync(probe, "x");
    expect(fs.existsSync(path.join(realHome, "skills", "written-by-brain.md"))).toBe(true);
    fs.rmSync(probe, { force: true });
    fs.rmSync(path.join(realHome, "skills", "written-by-brain.md"), { force: true });
  });

  it("mcpViaAcp：不写 settings.json / mcp.json；catalog 来自真实 ~/.claude.json，wechat 被拒", async () => {
    const { ensureBrainHome, addMcp, catalogNames, activeMcpServers } = await import(
      "./mcp-sandbox.js"
    );
    ensureBrainHome();

    expect(fs.existsSync(path.join(brainCfg, "settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(brainCfg, "settings", "mcp.json"))).toBe(false);

    expect(catalogNames()).toContain("demo");
    expect(catalogNames()).not.toContain("wechat");
    expect(addMcp("wechat")).toMatch(/不允许加载/);
    expect(addMcp("demo")).toMatch(/已加载 MCP「demo」/);

    // 激活集 → ACP 声明（不落盘）
    expect(activeMcpServers()).toEqual([
      {
        name: "demo",
        command: "node",
        args: ["demo-server.js"],
        env: [{ name: "DEMO", value: "1" }],
      },
    ]);
    expect(fs.existsSync(path.join(brainCfg, "settings", "mcp.json"))).toBe(false);
  });
});

describe("worker 沙箱（Claude Code）", () => {
  it("全量 MCP（除 wechat / disabled）走 ACP；记忆共享", async () => {
    const { ensureWorkerHome, workerMcpServers } = await import("./worker-sandbox.js");
    ensureWorkerHome();

    expect(workerMcpServers().map((s: any) => s.name)).toEqual(["demo"]);
    expect(fs.readFileSync(path.join(workerCfg, "skills", "sample.md"), "utf-8")).toBe("# skills\n");
    expect(fs.existsSync(path.join(workerCfg, "settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(workerCfg, "settings", "mcp.json"))).toBe(false);
  });
});
