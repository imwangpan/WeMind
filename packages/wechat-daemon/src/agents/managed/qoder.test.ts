import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Qoder 副本：设置基底（整份复制、只剥 MCP 段 + 强制关自动更新）、凭据/标识文件同步、以及 brain/worker 的 MCP curated 策略。模块级常量在 import 时解析，故先设环境再动态导入。
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-managed-qoder-"));
const realHome = path.join(root, "real-qoder");
const dataDir = path.join(root, "data");
const brainCfg = path.join(dataDir, "brain-home", "qoder");
const workerCfg = path.join(dataDir, "worker-home", "qoder");

const realSettings = {
  model: { name: "byok-model" },
  providers: [{ key: "acme", apiKey: "sk-secret", baseUrl: "https://example.invalid" }],
  enabledPlugins: { "demo@marketplace": true },
  general: { enableAutoUpdate: true, theme: "dark" },
  mcpServers: {
    wechat: { command: "wemind-mcp" },
    demo: { command: "node", args: ["demo-server.js"] },
    off: { command: "x", disabled: true },
  },
};

beforeAll(() => {
  fs.mkdirSync(path.join(realHome, ".auth"), { recursive: true });
  fs.writeFileSync(path.join(realHome, "settings.json"), JSON.stringify(realSettings, null, 2));
  fs.writeFileSync(path.join(realHome, ".auth", "user"), "real-token");
  fs.writeFileSync(path.join(realHome, ".auth", "machine_id"), "real-machine");
  fs.writeFileSync(path.join(realHome, "AGENTS.md"), "# memory\n");
  fs.mkdirSync(path.join(realHome, "memory"), { recursive: true });
  fs.writeFileSync(path.join(realHome, "memory", "MEMORY.md"), "# profile\n");

  process.env.WEMIND_BRAIN = "qoder";
  process.env.WEMIND_BRAIN_REAL_HOME = realHome;
  process.env.WECHAT_DATA_DIR = dataDir;
  process.env.WEMIND_HOME_MODE = "managed";
  delete process.env.WEMIND_BRAIN_INHERIT;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.WEMIND_BRAIN;
  delete process.env.WEMIND_BRAIN_REAL_HOME;
  delete process.env.WECHAT_DATA_DIR;
  delete process.env.WEMIND_HOME_MODE;
});

const readJson = (f: string): Record<string, any> => JSON.parse(fs.readFileSync(f, "utf-8"));

describe("brain 副本（Qoder）", () => {
  it("以真实 settings.json 为基底：整份复制，只剥 MCP 段并关闭自动更新", async () => {
    const { ensureBrainHome } = await import("./mcp-brain.js");
    ensureBrainHome();

    const cfg = readJson(path.join(brainCfg, "settings.json"));
    expect(cfg.mcpServers).toEqual({}); // 默认不加载；wechat 永不出现
    expect(cfg.providers).toEqual(realSettings.providers); // 整份复制：不替用户剥 BYOK 供应商
    expect(cfg.model).toEqual(realSettings.model);
    expect(cfg.enabledPlugins).toEqual(realSettings.enabledPlugins);
    expect(cfg.general).toEqual({ enableAutoUpdate: false, theme: "dark" }); // 只强制关自动更新
  });

  it("同步登录态：user 与 machine_id 都进副本；AGENTS.md 也继承", async () => {
    const { ensureBrainHome } = await import("./mcp-brain.js");
    ensureBrainHome();
    expect(fs.readFileSync(path.join(brainCfg, ".auth", "user"), "utf-8")).toBe("real-token");
    expect(fs.readFileSync(path.join(brainCfg, ".auth", "machine_id"), "utf-8")).toBe(
      "real-machine",
    );
    expect(fs.readFileSync(path.join(brainCfg, "AGENTS.md"), "utf-8")).toBe("# memory\n");
  });

  it("memory/ 以链接共享真实目录（大脑写入即落到真实 memory）", async () => {
    const { ensureBrainHome } = await import("./mcp-brain.js");
    ensureBrainHome();
    const copyMemory = path.join(brainCfg, "memory");
    expect(fs.readFileSync(path.join(copyMemory, "MEMORY.md"), "utf-8")).toBe("# profile\n");
    fs.writeFileSync(path.join(copyMemory, "written-by-brain.md"), "x");
    expect(fs.existsSync(path.join(realHome, "memory", "written-by-brain.md"))).toBe(true);
    fs.rmSync(path.join(realHome, "memory", "written-by-brain.md"));
  });

  it("machine_id 内容不同即纠正；user 仍是新者胜（副本刷新过则保留）", async () => {
    const { ensureBrainHome } = await import("./mcp-brain.js");
    const copyMachine = path.join(brainCfg, ".auth", "machine_id");
    const copyUser = path.join(brainCfg, ".auth", "user");
    fs.writeFileSync(copyMachine, "generated-by-agent");
    fs.writeFileSync(copyUser, "refreshed-in-copy");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(copyMachine, future, future);
    fs.utimesSync(copyUser, future, future);

    ensureBrainHome();
    expect(fs.readFileSync(copyMachine, "utf-8")).toBe("real-machine"); // 标识必须一致
    expect(fs.readFileSync(copyUser, "utf-8")).toBe("refreshed-in-copy"); // 新者胜
  });

  it("MCP 目录来自真实 settings.json；wechat 被拒，加载 demo 后写入副本", async () => {
    const { addMcp, catalogNames, ensureBrainHome } = await import("./mcp-brain.js");
    ensureBrainHome();
    expect(catalogNames()).toContain("demo");
    expect(catalogNames()).not.toContain("wechat");

    expect(addMcp("wechat").text).toMatch(/不允许加载/);
    expect(addMcp("demo").text).toMatch(/已加载 MCP「demo」/);
    ensureBrainHome();

    const cfg = readJson(path.join(brainCfg, "settings.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual(["demo"]);
    expect(cfg.general.enableAutoUpdate).toBe(false); // 合并 MCP 不清掉其它设置
  });
});

describe("worker 副本（Qoder）", () => {
  it("继承全量 MCP（除 wechat/disabled），供应商照原样带进副本并关闭自动更新", async () => {
    const { ensureWorkerHome } = await import("./mcp-worker.js");
    ensureWorkerHome();

    const cfg = readJson(path.join(workerCfg, "settings.json"));
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(["demo"]);
    expect(cfg.providers).toEqual(realSettings.providers);
    expect(cfg.general.enableAutoUpdate).toBe(false);
    expect(fs.readFileSync(path.join(workerCfg, ".auth", "machine_id"), "utf-8")).toBe(
      "real-machine",
    );
    expect(fs.readFileSync(path.join(workerCfg, "memory", "MEMORY.md"), "utf-8")).toBe(
      "# profile\n",
    );
  });
});
