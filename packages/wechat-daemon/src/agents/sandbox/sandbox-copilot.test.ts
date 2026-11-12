import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-sandbox-copilot-"));
const realHome = path.join(root, "real-copilot");
const dataDir = path.join(root, "data");
const brainHome = path.join(dataDir, "brain-home");
const workerHome = path.join(dataDir, "worker-home");
const sampleServerName = "sample";
const mcpConfig = {
  mcpServers: {
    wechat: { type: "local", command: "wemind-mcp" },
    "renamed-wechat": {
      type: "local",
      command: "npx",
      args: ["-y", "@wemind/wechat-mcp"],
    },
    [sampleServerName]: {
      type: "local",
      command: "node",
      args: ["demo-server.js"],
      env: { DEMO: "1" },
    },
  },
};

beforeAll(() => {
  fs.mkdirSync(path.join(realHome, "skills"), { recursive: true });
  fs.writeFileSync(path.join(realHome, "skills", "sample.md"), "# skill\n");
  fs.writeFileSync(path.join(realHome, "copilot-instructions.md"), "# instructions\n");
  fs.writeFileSync(path.join(realHome, "config.json"), JSON.stringify({ loggedInUsers: [] }));
  fs.writeFileSync(path.join(realHome, "mcp-config.json"), JSON.stringify(mcpConfig));

  process.env.WEMIND_BRAIN = "copilot";
  process.env.WEMIND_WORKER_BRAIN = "copilot";
  process.env.WEMIND_BRAIN_REAL_HOME = realHome;
  process.env.WECHAT_DATA_DIR = dataDir;
  process.env.WEMIND_HOME_MODE = "sandbox";
  delete process.env.WEMIND_MCP_CATALOG;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.WEMIND_BRAIN;
  delete process.env.WEMIND_WORKER_BRAIN;
  delete process.env.WEMIND_BRAIN_REAL_HOME;
  delete process.env.WECHAT_DATA_DIR;
  delete process.env.WEMIND_HOME_MODE;
  delete process.env.WEMIND_MCP_CATALOG;
});

describe("Copilot 沙箱", () => {
  it("隔离 COPILOT_HOME，只同步登录配置与用户指令/技能", async () => {
    const { ensureBrainHome } = await import("./mcp-sandbox.js");
    ensureBrainHome();

    expect(fs.readFileSync(path.join(brainHome, "config.json"), "utf-8")).toBe(
      JSON.stringify({ loggedInUsers: [] }),
    );
    expect(fs.readFileSync(path.join(brainHome, "copilot-instructions.md"), "utf-8")).toBe(
      "# instructions\n",
    );
    expect(fs.readFileSync(path.join(brainHome, "skills", "sample.md"), "utf-8")).toBe("# skill\n");
    expect(fs.existsSync(path.join(brainHome, "mcp-config.json"))).toBe(false);
  });

  it("ACP MCP catalog 从 mcp-config.json 读取并按名字/定义排除 wechat", async () => {
    const { addMcp, activeMcpServers, catalogNames, ensureBrainHome } =
      await import("./mcp-sandbox.js");
    const { resolveAgent } = await import("../brain-agents.js");
    const agent = resolveAgent();
    ensureBrainHome();

    expect(catalogNames()).toEqual([sampleServerName]);
    expect(addMcp("renamed-wechat")).toMatchObject({ ok: false, changed: false });
    expect(addMcp(sampleServerName)).toMatchObject({ ok: true, changed: true });
    expect(activeMcpServers()).toEqual([
      {
        name: sampleServerName,
        command: "node",
        args: ["demo-server.js"],
        env: [{ name: "DEMO", value: "1" }],
      },
    ]);

    const { ensureWorkerHome, workerMcpServers } = await import("./worker-sandbox.js");
    ensureWorkerHome(agent);
    expect(fs.readFileSync(path.join(workerHome, "config.json"), "utf-8")).toBe(
      JSON.stringify({ loggedInUsers: [] }),
    );
    expect(workerMcpServers(agent)).toEqual([
      {
        name: sampleServerName,
        command: "node",
        args: ["demo-server.js"],
        env: [{ name: "DEMO", value: "1" }],
      },
    ]);
    expect(fs.existsSync(path.join(workerHome, "mcp-config.json"))).toBe(false);
  });
});
