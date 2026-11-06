import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * kiro 沙箱：v2 / v3 的免审批落点不同。
 * - v2：启动参数 `--trust-all-tools`（不写 settings/permissions.yaml）。
 * - v3：v3 会拒绝 v2 的信任参数，改用 `settings/permissions.yaml` 的 allow-all 规则；真实配置里已有这份文件时原样同步、不覆盖用户的规则。
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-sandbox-kiro-"));
const v3Home = path.join(root, "kiro-v3");
const v2Home = path.join(root, "kiro-v2");
const dataDir = path.join(root, "data");

const brainSettings = (home = "brain-home") =>
  path.join(dataDir, home, "settings", "permissions.yaml");

const writeSettings = (home: string, acpEngine: string) => {
  fs.mkdirSync(path.join(home, "settings"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "settings", "cli.json"),
    JSON.stringify({ "chat.agentEngine": "v3", "acp.agentEngine": acpEngine }),
    "utf-8",
  );
};

let ensureBrainHome: typeof import("./mcp-sandbox.js").ensureBrainHome;
let ensureWorkerHome: typeof import("./worker-sandbox.js").ensureWorkerHome;
let resolveAgent: typeof import("../brain-agents.js").resolveAgent;
let resetSlotsForTest: typeof import("../agent-slot.js").resetSlotsForTest;

beforeAll(async () => {
  writeSettings(v3Home, "v3");
  writeSettings(v2Home, "v2");
  process.env.WEMIND_BRAIN = "kiro";
  process.env.WEMIND_BRAIN_REAL_HOME = v3Home;
  process.env.WECHAT_DATA_DIR = dataDir;
  delete process.env.WEMIND_BRAIN_INHERIT;
  ({ ensureBrainHome } = await import("./mcp-sandbox.js"));
  ({ ensureWorkerHome } = await import("./worker-sandbox.js"));
  ({ resolveAgent } = await import("../brain-agents.js"));
  ({ resetSlotsForTest } = await import("../agent-slot.js"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.WEMIND_BRAIN;
  delete process.env.WEMIND_BRAIN_REAL_HOME;
  delete process.env.WECHAT_DATA_DIR;
  delete process.env.WEMIND_BRAIN_INHERIT;
});

describe("kiro 沙箱（v3 免审批）", () => {
  it("v3：brain/worker 沙箱都补上 allow-all 的 permissions.yaml", () => {
    ensureBrainHome();
    ensureWorkerHome();
    const body = "rules:\n  - capability: all\n    effect: allow\n";
    expect(fs.readFileSync(brainSettings(), "utf-8")).toBe(body);
    expect(fs.readFileSync(brainSettings("worker-home"), "utf-8")).toBe(body);
    expect(resolveAgent().kiroV3).toBe(true);
    expect(resolveAgent().args).toEqual(["acp", "--agent-engine", "v3"]);
  });

  it("真实设置里已有 permissions.yaml → 原样同步，不覆盖用户规则", () => {
    const custom = "rules:\n  - capability: fs_write\n    effect: ask\n";
    fs.writeFileSync(path.join(v3Home, "settings", "permissions.yaml"), custom, "utf-8");
    resetSlotsForTest();
    ensureBrainHome();
    expect(fs.readFileSync(brainSettings(), "utf-8")).toBe(custom);
  });

  it("v2：不写 permissions.yaml（免审批仍由 --trust-all-tools 承担）", () => {
    fs.rmSync(brainSettings("worker-home"), { force: true }); // 清掉上一轮 v3 留下的文件
    process.env.WEMIND_BRAIN_REAL_HOME = v2Home;
    resetSlotsForTest();
    ensureWorkerHome();
    expect(resolveAgent().kiroV3).toBe(false);
    expect(resolveAgent().args).toEqual(["acp", "--trust-all-tools"]);
    expect(fs.existsSync(brainSettings("worker-home"))).toBe(false);
  });
});
