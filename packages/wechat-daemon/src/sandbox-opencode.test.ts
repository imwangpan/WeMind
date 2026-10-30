import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * opencode 沙箱的免审批默认：`opencode acp` 不接受 `--auto`（官方 issue #52216），
 * 免审批只能写进 opencode.json 的 permission。默认值只补「用户没写」的情况：用户自己配的
 * permission（含 deny）必须原样保留，否则就是 WeMind 越权改用户配置（§4.14）。
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-sandbox-opencode-"));
const realHome = path.join(root, "real-opencode");
const dataDir = path.join(root, "data");
const brainCfg = path.join(dataDir, "brain-home", "opencode", "opencode.json");
const workerCfg = path.join(dataDir, "worker-home", "opencode", "opencode.json");

beforeAll(() => {
  fs.mkdirSync(realHome, { recursive: true });
  // 真实全局配置：没有 permission 键 → 沙箱应补 "allow"
  fs.writeFileSync(
    path.join(realHome, "opencode.json"),
    JSON.stringify({ model: "demo/model", mcp: { servers: { wechat: { command: "x" } } } }, null, 2),
  );
  process.env.WEMIND_BRAIN = "opencode";
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

describe("opencode 沙箱：免审批默认", () => {
  it("用户没配 permission 时，brain 与 worker 的沙箱配置都补 permission=allow", async () => {
    const { ensureBrainHome } = await import("./mcp-sandbox.js");
    const { ensureWorkerHome } = await import("./worker-sandbox.js");
    ensureBrainHome();
    ensureWorkerHome();
    expect(readJson(brainCfg).permission).toBe("allow");
    expect(readJson(workerCfg).permission).toBe("allow");
    // 其它键照旧继承，MCP 仍由沙箱权威覆盖（wechat 不出现）
    expect(readJson(brainCfg).model).toBe("demo/model");
    expect(readJson(brainCfg).mcp.servers).toEqual({});
  });

  it("用户显式配置的 permission 原样保留（不覆盖成 allow）", async () => {
    fs.writeFileSync(
      path.join(realHome, "opencode.json"),
      JSON.stringify({ permission: { "*": "ask", bash: "deny" } }, null, 2),
    );
    const { ensureBrainHome } = await import("./mcp-sandbox.js");
    ensureBrainHome();
    expect(readJson(brainCfg).permission).toEqual({ "*": "ask", bash: "deny" });
  });
});
