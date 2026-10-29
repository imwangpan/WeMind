import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * DSH 沙箱：把真实 `~/.dsh/profiles/<profile>/cordis.patch.yml`（桌面端维护的用户层，含 provider 目录与默认模型）同步进 sandbox。
 * **原样复制**——`- id: acp` 这类覆盖由用户自己在真实 profile 里维护（缺了 `wemind brain` 会提示），WeMind 不替 agent 合成配置，
 * 这样「终端 dsh」与「微信大脑」行为一致。模块级常量（DATA_DIR/沙箱根）在 import 时解析，故先设环境再动态导入（同 sandbox-qoder.test.ts）。
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-sandbox-dsh-"));
const realHome = path.join(root, "real-dsh");
const dataDir = path.join(root, "data");
const realPatch = path.join(realHome, "profiles", "acp", "cordis.patch.yml");
const brainPatch = path.join(dataDir, "brain-home", "profiles", "acp", "cordis.patch.yml");
const workerPatch = path.join(dataDir, "worker-home", "profiles", "acp", "cordis.patch.yml");

const patch = (model: string) =>
  [
    "- id: llm-pi-ai # magpie",
    "  config:",
    "    providers:",
    "      magpie:",
    "        displayName: Magpie",
    "- id: agent-default-model # magpie",
    "  config:",
    "    provider: magpie",
    `    model: "${model}"`,
    "",
  ].join("\n");

let ensureBrainHome: typeof import("./mcp-sandbox.js").ensureBrainHome;
let ensureWorkerHome: typeof import("./worker-sandbox.js").ensureWorkerHome;
let resetSlotsForTest: typeof import("./agent-slot.js").resetSlotsForTest;

beforeAll(async () => {
  fs.mkdirSync(path.dirname(realPatch), { recursive: true });
  fs.writeFileSync(realPatch, patch("auto/deepseek-v4.1-flash"));
  fs.writeFileSync(path.join(realHome, ".credentials.yaml"), "version: 1\n");
  process.env.WEMIND_BRAIN = "deepseek";
  process.env.WEMIND_BRAIN_REAL_HOME = realHome;
  process.env.WECHAT_DATA_DIR = dataDir;
  delete process.env.WEMIND_BRAIN_INHERIT;
  ({ ensureBrainHome } = await import("./mcp-sandbox.js"));
  ({ ensureWorkerHome } = await import("./worker-sandbox.js"));
  ({ resetSlotsForTest } = await import("./agent-slot.js"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.WEMIND_BRAIN;
  delete process.env.WEMIND_BRAIN_REAL_HOME;
  delete process.env.WECHAT_DATA_DIR;
  delete process.env.WEMIND_BRAIN_INHERIT;
});

describe("DSH 沙箱（profile 用户层同步）", () => {
  it("brain：真实 profiles/acp/cordis.patch.yml 原样进沙箱（WeMind 不追加任何条目）", () => {
    ensureBrainHome();
    const text = fs.readFileSync(brainPatch, "utf-8");
    expect(text).toBe(patch("auto/deepseek-v4.1-flash"));
    expect(text).not.toMatch(/^\s*- id: acp\s*$/m); // 用户没写就不补——那是用户自己的配置
    // 凭据仍照常同步（登录态）
    expect(fs.existsSync(path.join(dataDir, "brain-home", ".credentials.yaml"))).toBe(true);
  });

  it("worker：同一份用户层也进 worker 沙箱（同样原样）", () => {
    ensureWorkerHome();
    expect(fs.readFileSync(workerPatch, "utf-8")).toBe(patch("auto/deepseek-v4.1-flash"));
  });

  it("用户在真实 profile 里加了 - id: acp → 原样带进沙箱（终端与微信大脑同一个模型）", () => {
    const own = `${patch("auto/from-default")}- id: acp\n  config:\n    provider: magpie\n    model: auto/from-acp\n`;
    fs.writeFileSync(realPatch, own);
    resetSlotsForTest(); // 真实 daemon 里由重启/切脑重新解析；测试手动模拟
    ensureBrainHome();
    expect(fs.readFileSync(brainPatch, "utf-8")).toBe(own);
    expect(fs.readFileSync(realPatch, "utf-8")).toBe(own); // 真实文件不动
  });

  it("桌面端更新（比如换了默认模型）→ 下一次 ensure 覆盖沙箱里的旧副本", () => {
    fs.writeFileSync(realPatch, patch("auto/glm-5.3"));
    resetSlotsForTest();
    ensureBrainHome();
    expect(fs.readFileSync(brainPatch, "utf-8")).toBe(patch("auto/glm-5.3"));
  });

  it("用户在真实 profile 里挂了微信 MCP → 只从沙箱副本剔除它（其余原样，真实文件不动）", () => {
    const withMcp = [
      patch("auto/with-mcp"),
      "- id: mcp-wemind # 我自己的微信 MCP",
      "  name: '@deepseek-ai/dsh-mcp-client'",
      "  config:",
      "    serverName: wechat",
      "    transport: stdio",
      "    command: npx",
      "    args: ['-y', '@wemind/wechat-mcp']",
      "- id: mcp-github",
      "  name: '@deepseek-ai/dsh-mcp-client'",
      "  config:",
      "    serverName: github",
      "    transport: stdio",
      "    command: npx",
      "    args: ['-y', '@modelcontextprotocol/server-github']",
      "",
    ].join("\n");
    fs.writeFileSync(realPatch, withMcp);
    resetSlotsForTest();
    ensureBrainHome();
    const brain = fs.readFileSync(brainPatch, "utf-8");
    expect(brain).not.toContain("mcp-wemind");
    expect(brain).not.toContain("wemind-mcp");
    expect(brain).toContain("- id: mcp-github"); // 其它 MCP 原样继承
    expect(brain).toContain("- id: agent-default-model");
    expect(fs.readFileSync(realPatch, "utf-8")).toBe(withMcp); // 真实文件不动
    ensureWorkerHome();
    const worker = fs.readFileSync(workerPatch, "utf-8");
    expect(worker).not.toContain("wemind-mcp");
    expect(worker).toContain("- id: mcp-github");
  });

  it("关掉继承（WEMIND_BRAIN_INHERIT=0）就不再同步", () => {
    process.env.WEMIND_BRAIN_INHERIT = "0";
    resetSlotsForTest();
    const before = fs.readFileSync(brainPatch, "utf-8");
    fs.writeFileSync(realPatch, patch("auto/never-copy"));
    ensureBrainHome();
    expect(fs.readFileSync(brainPatch, "utf-8")).toBe(before); // 保持上一次内容
  });
});
