import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cline 沙箱：配置目录在 <沙箱>/cline（CLINE_DIR/CLINE_DATA_DIR/CLINE_MCP_SETTINGS_PATH 三个 env 由预设给出），
 * MCP 文件是 <沙箱>/cline/mcp.json（CLINE_MCP_SETTINGS_PATH），目录来源是真实的 data/settings/cline_mcp_settings.json。
 * 模块级常量在 import 时解析，故先设环境再动态导入（同 sandbox-qoder.test.ts）。
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-sandbox-cline-"));
const realHome = path.join(root, "real-cline");
const dataDir = path.join(root, "data");
const brainCfg = path.join(dataDir, "brain-home", "cline");
const workerCfg = path.join(dataDir, "worker-home", "cline");

const providers = {
  version: "1",
  lastUsedProvider: "openai-compatible",
  providers: {
    "openai-compatible": {
      settings: { provider: "openai-compatible", apiKey: "sk-local", model: "auto/model" },
      updatedAt: "2026-10-30T00:00:00.000Z",
      tokenSource: "manual",
    },
  },
};

const mcpSettings = {
  mcpServers: {
    wechat: { command: "wemind-mcp" },
    demo: { command: "node", args: ["demo-server.js"] },
    off: { command: "x", disabled: true },
  },
};

beforeAll(() => {
  fs.mkdirSync(path.join(realHome, "data", "settings"), { recursive: true });
  fs.writeFileSync(
    path.join(realHome, "data", "settings", "providers.json"),
    JSON.stringify(providers),
  );
  fs.writeFileSync(
    path.join(realHome, "data", "settings", "models.json"),
    JSON.stringify({ version: 1, providers: { "openai-compatible": { models: ["auto/model"] } } }),
  );
  fs.writeFileSync(
    path.join(realHome, "data", "settings", "cline_mcp_settings.json"),
    JSON.stringify(mcpSettings),
  );
  for (const d of ["rules", "skills", "agents"]) {
    fs.mkdirSync(path.join(realHome, d), { recursive: true });
    fs.writeFileSync(path.join(realHome, d, "sample.md"), `# ${d}\n`);
  }

  process.env.WEMIND_BRAIN = "cline";
  process.env.WEMIND_BRAIN_REAL_HOME = realHome;
  process.env.WECHAT_DATA_DIR = dataDir;
  delete process.env.WEMIND_BRAIN_INHERIT;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.WEMIND_BRAIN;
  delete process.env.WEMIND_BRAIN_REAL_HOME;
  delete process.env.WECHAT_DATA_DIR;
});

const readJson = (f: string): Record<string, any> => JSON.parse(fs.readFileSync(f, "utf-8"));

describe("brain 沙箱（Cline）", () => {
  it("登录态 providers.json + 模型缓存 models.json 进沙箱（data/settings 布局）", async () => {
    const { ensureBrainHome } = await import("./mcp-sandbox.js");
    ensureBrainHome();
    const copied = readJson(path.join(brainCfg, "data", "settings", "providers.json"));
    expect(copied.lastUsedProvider).toBe("openai-compatible");
    const models = readJson(path.join(brainCfg, "data", "settings", "models.json"));
    expect(models.version).toBe(1); // 缺它时 Cline 会回退到 gpt-4o
  });

  it("rules/skills/agents 以链接共享真实目录（大脑写入即落到真实目录）", async () => {
    const { ensureBrainHome } = await import("./mcp-sandbox.js");
    ensureBrainHome();
    const sandboxRules = path.join(brainCfg, "rules");
    expect(fs.readFileSync(path.join(sandboxRules, "sample.md"), "utf-8")).toBe("# rules\n");
    fs.writeFileSync(path.join(sandboxRules, "written-by-brain.md"), "x");
    expect(fs.existsSync(path.join(realHome, "rules", "written-by-brain.md"))).toBe(true);
    fs.rmSync(path.join(realHome, "rules", "written-by-brain.md"));
  });

  it("MCP 默认空；目录来自 data/settings/cline_mcp_settings.json；wechat 被拒，加载 demo 写入 cline/mcp.json", async () => {
    const { addMcp, catalogNames, ensureBrainHome } = await import("./mcp-sandbox.js");
    ensureBrainHome();

    const empty = readJson(path.join(brainCfg, "mcp.json"));
    expect(empty).toEqual({ mcpServers: {} }); // 默认不加载；真实文件未被改动

    expect(catalogNames()).toContain("demo");
    expect(catalogNames()).not.toContain("wechat");
    expect(addMcp("wechat")).toMatch(/不允许加载/);
    expect(addMcp("demo")).toMatch(/已加载 MCP「demo」/);

    ensureBrainHome();
    const cfg = readJson(path.join(brainCfg, "mcp.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual(["demo"]);
  });
});

describe("worker 沙箱（Cline）", () => {
  it("继承全量 MCP（除 wechat/disabled），并同步 providers.json + models.json", async () => {
    const { ensureWorkerHome } = await import("./worker-sandbox.js");
    ensureWorkerHome();

    const cfg = readJson(path.join(workerCfg, "mcp.json"));
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(["demo"]);
    expect(
      readJson(path.join(workerCfg, "data", "settings", "providers.json")).lastUsedProvider,
    ).toBe("openai-compatible");
    expect(readJson(path.join(workerCfg, "data", "settings", "models.json")).version).toBe(1);
    expect(fs.readFileSync(path.join(workerCfg, "rules", "sample.md"), "utf-8")).toBe("# rules\n");
  });
});
