import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * pi 沙箱：配置目录就是沙箱根（PI_CODING_AGENT_DIR），MCP 是 <沙箱根>/mcp.json（kiro 格式）。
 * settings.json / auth.json / models*.json 由 credentialFiles 原样同步；预设再补 quietStartup——
 * pi-acp 会把 pi 的启动横幅（## Context / ## Skills …）当 agent_message_chunk 发出来，进微信回复就是噪声。
 * 模块级常量在 import 时解析，故先设环境再动态导入（同 sandbox-cline.test.ts）。
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-sandbox-pi-"));
const realHome = path.join(root, "real-pi");
const dataDir = path.join(root, "data");
const brainCfg = path.join(dataDir, "brain-home");
const workerCfg = path.join(dataDir, "worker-home");

const realSettings = {
  defaultProvider: "magpie",
  defaultModel: "auto/glm-5.3-flash",
  defaultTools: ["+powershell"],
};

const mcpCatalog = {
  mcpServers: {
    wechat: { command: "wemind-mcp" },
    demo: { command: "node", args: ["demo-server.js"] },
    off: { command: "x", disabled: true },
  },
};

const writeRealSettings = (extra: Record<string, unknown> = {}): void => {
  fs.writeFileSync(
    path.join(realHome, "settings.json"),
    JSON.stringify({ ...realSettings, ...extra }, null, 2),
  );
};

beforeAll(() => {
  fs.mkdirSync(path.join(realHome, "skills"), { recursive: true });
  fs.writeFileSync(path.join(realHome, "skills", "sample.md"), "# skills\n");
  fs.writeFileSync(path.join(realHome, "AGENTS.md"), "# pi rules\n");
  writeRealSettings();
  fs.writeFileSync(path.join(realHome, "auth.json"), "{}\n");
  fs.writeFileSync(path.join(realHome, "models.json"), JSON.stringify({ providers: {} }));
  fs.writeFileSync(path.join(realHome, "mcp.json"), JSON.stringify(mcpCatalog));

  process.env.WEMIND_BRAIN = "pi";
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

describe("brain 沙箱（pi）", () => {
  it("settings/auth/models 原样同步，并补上 quietStartup（用户没显式设过时）", async () => {
    const { ensureBrainHome } = await import("./mcp-sandbox.js");
    ensureBrainHome();

    const cfg = readJson(path.join(brainCfg, "settings.json"));
    expect(cfg.defaultProvider).toBe("magpie");
    expect(cfg.defaultModel).toBe("auto/glm-5.3-flash");
    expect(cfg.quietStartup).toBe(true);
    expect(fs.existsSync(path.join(brainCfg, "auth.json"))).toBe(true);
    expect(fs.existsSync(path.join(brainCfg, "models.json"))).toBe(true);
    expect(fs.readFileSync(path.join(brainCfg, "skills", "sample.md"), "utf-8")).toBe("# skills\n");
    expect(fs.readFileSync(path.join(brainCfg, "AGENTS.md"), "utf-8")).toBe("# pi rules\n");
  });

  it("大脑 MCP 仍走激活集（默认空）：wechat 与未加载的目录项都不出现", async () => {
    const { ensureBrainHome } = await import("./mcp-sandbox.js");
    ensureBrainHome();
    expect(Object.keys(readJson(path.join(brainCfg, "mcp.json")).mcpServers)).toEqual([]);
  });

  it("用户显式设了 quietStartup 就保留用户的值（真实配置不动）", async () => {
    writeRealSettings({ quietStartup: false });
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(realHome, "settings.json"), future, future); // 「新者胜」才会重新同步
    const { ensureBrainHome } = await import("./mcp-sandbox.js");
    ensureBrainHome();
    expect(readJson(path.join(brainCfg, "settings.json")).quietStartup).toBe(false);
    expect(readJson(path.join(realHome, "settings.json")).quietStartup).toBe(false);
    writeRealSettings(); // 复原，避免影响 worker 用例
  });
});

describe("worker 沙箱（pi）", () => {
  it("settings/models 进沙箱、补 quietStartup，MCP 全量但排除 wechat/disabled", async () => {
    const { ensureWorkerHome } = await import("./worker-sandbox.js");
    ensureWorkerHome();

    const cfg = readJson(path.join(workerCfg, "settings.json"));
    expect(cfg.defaultProvider).toBe("magpie");
    expect(cfg.quietStartup).toBe(true);
    expect(fs.existsSync(path.join(workerCfg, "models.json"))).toBe(true);

    const servers = readJson(path.join(workerCfg, "mcp.json")).mcpServers;
    expect(Object.keys(servers)).toEqual(["demo"]);
  });
});
