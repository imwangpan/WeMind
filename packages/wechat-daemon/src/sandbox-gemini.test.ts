import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * gemini 沙箱：GEMINI_CLI_HOME 指向沙箱根，而 Gemini 的配置目录是 `<沙箱>/.gemini`（实测），
 * MCP 与设置同在 `<配置目录>/settings.json`。
 * - 设置基底只剥 `mcpServers`（保留 model / security / ui），MCP 由沙箱 curated 权威写入；
 * - `.env`（GEMINI_API_KEY / GOOGLE_GEMINI_BASE_URL）作为凭据同步；
 * - skills/ 与 GEMINI.md 是它的全局技能与记忆，继承进沙箱。
 * 模块级常量在 import 时解析，故先设环境再动态导入（同 sandbox-pi.test.ts）。
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-sandbox-gemini-"));
const realHome = path.join(root, "real-gemini");
const dataDir = path.join(root, "data");
const brainCfg = path.join(dataDir, "brain-home", ".gemini");
const workerCfg = path.join(dataDir, "worker-home", ".gemini");

const realSettings = {
  model: { name: "auto/hy3" },
  security: { auth: { selectedType: "gemini-api-key" } },
  ui: { theme: "Default Light" },
  general: { vimMode: true },
  mcpServers: {
    wechat: { command: "wemind-mcp" },
    demo: { command: "node", args: ["demo-server.js"] },
  },
};
const envFile = "GEMINI_API_KEY=sk-test\nGOOGLE_GEMINI_BASE_URL=http://127.0.0.1:3425\n";

beforeAll(() => {
  fs.mkdirSync(path.join(realHome, "skills"), { recursive: true });
  fs.writeFileSync(path.join(realHome, "skills", "sample.md"), "# gemskills\n");
  fs.writeFileSync(path.join(realHome, "GEMINI.md"), "# global memory\n");
  fs.writeFileSync(path.join(realHome, "settings.json"), JSON.stringify(realSettings, null, 2));
  fs.writeFileSync(path.join(realHome, ".env"), envFile);

  process.env.WEMIND_BRAIN = "gemini";
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

describe("brain 沙箱（gemini）", () => {
  it("settings.json 镜像 model/security/ui/general，剥掉 mcpServers 并关自动更新", async () => {
    const { ensureBrainHome } = await import("./mcp-sandbox.js");
    ensureBrainHome();

    const cfg = readJson(path.join(brainCfg, "settings.json"));
    expect(cfg.model).toEqual({ name: "auto/hy3" }); // 用户自己的默认模型必须保留
    expect(cfg.security.auth.selectedType).toBe("gemini-api-key");
    expect(cfg.ui.theme).toBe("Default Light");
    expect(cfg.general.vimMode).toBe(true); // 用户已有的 general 键不丢
    expect(cfg.general.enableAutoUpdate).toBe(false);
    expect(cfg.mcpServers).toEqual({}); // 大脑默认空激活集，真实配置里的 server 不进沙箱
    // 真实配置不动
    expect(Object.keys(readJson(path.join(realHome, "settings.json")).mcpServers)).toEqual([
      "wechat",
      "demo",
    ]);
  });

  it(".env 凭据、skills/ 与 GEMINI.md 都继承进沙箱", async () => {
    const { ensureBrainHome } = await import("./mcp-sandbox.js");
    ensureBrainHome();

    expect(fs.readFileSync(path.join(brainCfg, ".env"), "utf-8")).toBe(envFile);
    expect(fs.readFileSync(path.join(brainCfg, "skills", "sample.md"), "utf-8")).toBe(
      "# gemskills\n",
    );
    expect(fs.readFileSync(path.join(brainCfg, "GEMINI.md"), "utf-8")).toBe("# global memory\n");
  });

  it("加载 MCP 后写回同一个 settings.json，且 wechat 仍被拒、设置不被冲掉", async () => {
    const { addMcp } = await import("./mcp-sandbox.js");
    expect(addMcp("wechat")).toMatch(/不允许/);
    expect(addMcp("demo")).toMatch(/已加载/);

    const cfg = readJson(path.join(brainCfg, "settings.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual(["demo"]);
    expect(cfg.model).toEqual({ name: "auto/hy3" });
  });
});

describe("worker 沙箱（gemini）", () => {
  it("settings.json 同样镜像，MCP 全量但排除 wechat", async () => {
    const { ensureWorkerHome } = await import("./worker-sandbox.js");
    ensureWorkerHome();

    const cfg = readJson(path.join(workerCfg, "settings.json"));
    expect(cfg.model).toEqual({ name: "auto/hy3" });
    expect(cfg.general.enableAutoUpdate).toBe(false);
    expect(Object.keys(cfg.mcpServers)).toEqual(["demo"]);
    expect(fs.readFileSync(path.join(workerCfg, ".env"), "utf-8")).toBe(envFile);
    expect(fs.readFileSync(path.join(workerCfg, "skills", "sample.md"), "utf-8")).toBe(
      "# gemskills\n",
    );
  });
});
