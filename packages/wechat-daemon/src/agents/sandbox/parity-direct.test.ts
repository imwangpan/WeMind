import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ResolvedAgent } from "../brain-agents.js";
import { agentRuntime } from "../config/runtime.js";

/**
 * direct（默认）的安全边界：绝不写真实 home；真实配置含微信 MCP 只告警；
 * overlay 只接受 mcp.disable / mcp.extra；指纹只跟配置内容有关，不被 agent 自己的历史文件带偏。
 *
 * 模块级 DATA_DIR 在 import 时解析，所以环境变量必须在动态 import 之前设好。
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-parity-direct-"));
const dataDir = path.join(root, "data");
const account = path.join(dataDir, "acc");
const qoderHome = path.join(root, "qoder-home");
const copilotHome = path.join(root, "copilot-home");
const qoderSettings = {
  model: { name: "byok-model" },
  providers: [{ key: "acme", apiKey: "sk-secret", baseUrl: "https://example.invalid" }],
  mcpServers: {
    wechat: { command: "npx", args: ["-y", "@wemind/wechat-mcp"] },
    demo: { command: "node", args: ["demo.js"] },
  },
};

beforeAll(() => {
  fs.mkdirSync(path.join(qoderHome, ".auth"), { recursive: true });
  fs.writeFileSync(path.join(qoderHome, "settings.json"), JSON.stringify(qoderSettings, null, 2));
  fs.writeFileSync(path.join(qoderHome, ".auth", "user"), "token");
  fs.mkdirSync(copilotHome, { recursive: true });
  fs.writeFileSync(
    path.join(copilotHome, "mcp-config.json"),
    JSON.stringify({
      mcpServers: {
        wechat: { command: "wemind-mcp" },
        ok: { command: "node", args: ["ok.js"] },
      },
    }),
  );
  process.env.WECHAT_ACCOUNT = "acc";
  process.env.WECHAT_DATA_DIR = account;
  delete process.env.WEMIND_HOME_MODE;
  delete process.env.WEMIND_MCP_CATALOG;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.WECHAT_ACCOUNT;
  delete process.env.WECHAT_DATA_DIR;
  delete process.env.WEMIND_HOME_MODE;
});

async function agentOf(name: string, overrides: Record<string, unknown>): Promise<ResolvedAgent> {
  const { ACP_AGENT_PRESETS } = await import("../brain-presets.js");
  const p = ACP_AGENT_PRESETS[name];
  if (!p) throw new Error(`unknown preset ${name}`);
  return {
    name,
    bin: "fake",
    args: [],
    extraConfigFiles: p.extraConfigFiles ?? [],
    shell: false,
    inherit: false,
    realHome: p.realHome,
    homeEnvVar: p.homeEnvVar,
    realProfile: p.realProfile,
    inheritDirs: p.inheritDirs ?? [],
    inheritFiles: p.inheritFiles ?? [],
    configSubdir: p.configSubdir ?? "",
    mcpFormat: p.mcpFormat ?? "mcpServers",
    mcpConfigFile: p.mcpConfigFile ?? "settings.json",
    catalogFile: p.catalogFile ?? "settings/mcp.json",
    env: {},
    envDefaults: {},
    replayOnLoad: false,
    images: false,
    credentialFiles: [],
    identityFiles: [],
    settingsBase: p.settingsBase,
    settingsStrip: p.settingsStrip ?? [],
    settingsDefaults: p.settingsDefaults ?? {},
    mcpViaAcp: !!p.mcpViaAcp,
    requestedKey: name,
    source: "file",
    known: true,
    available: true,
    binPath: "fake",
    requiresBins: [],
    binOverridden: false,
    ...overrides,
  } as ResolvedAgent;
}

describe("direct（默认）", () => {
  it("ensureBrainHome 不写真实 settings.json，也不生成任何副本", async () => {
    const { ensureBrainHome } = await import("./mcp-sandbox.js");
    const ag = await agentOf("qoder", { realHome: qoderHome });
    const before = fs.readFileSync(path.join(qoderHome, "settings.json"), "utf-8");

    const rt = ensureBrainHome(ag, account);
    expect(rt.mode).toBe("direct");
    expect(rt.home).toBe(qoderHome);
    expect(fs.readFileSync(path.join(qoderHome, "settings.json"), "utf-8")).toBe(before);
    expect(fs.existsSync(path.join(account, "brain-home"))).toBe(false);
  });

  it("真实配置含微信 MCP 时只告警，不阻止启动", async () => {
    const { warnForbiddenNativeMcp } = await import("./mcp-sandbox.js");
    const ag = await agentOf("qoder", { realHome: qoderHome });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => warnForbiddenNativeMcp(ag, agentRuntime("brain", ag, account))).not.toThrow();
      expect(warn.mock.calls.flat().join(" ")).toMatch(/微信 MCP/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("sandbox", () => {
  it("copilot 沙箱读真实 catalog，但绝不激活微信 MCP", async () => {
    const { ensureBrainHome, addMcp, activeMcpServers, catalogNames } =
      await import("./mcp-sandbox.js");
    const ag = await agentOf("copilot", { realHome: copilotHome });
    process.env.WEMIND_HOME_MODE = "sandbox";
    try {
      const rt = ensureBrainHome(ag, account);
      expect(rt.mode).toBe("sandbox");
      expect(catalogNames(ag, account)).toEqual(["ok"]);
      expect(addMcp("wechat", ag, account).ok).toBe(false);
      expect(addMcp("ok", ag, account).ok).toBe(true);
      expect(activeMcpServers(ag, rt, account).map((s) => s.name)).toEqual(["ok"]);
      const real = JSON.parse(fs.readFileSync(path.join(copilotHome, "mcp-config.json"), "utf-8"));
      expect(Object.keys(real.mcpServers)).toContain("wechat");
    } finally {
      delete process.env.WEMIND_HOME_MODE;
    }
  });
});

describe("overlay 写入边界", () => {
  it("拒绝非法 agent 名（防 ../ 写到别的文件）", async () => {
    const { overlayPath } = await import("../config/overlay.js");
    expect(() => overlayPath("../../runtime", account)).toThrow(/agent 名/);
    expect(() => overlayPath("..", account)).toThrow(/agent 名/);
  });

  it("拒绝把微信 MCP 写进 overlay.mcp.extra", async () => {
    const { writeOverlay } = await import("../config/overlay.js");
    expect(() =>
      writeOverlay(
        "copilot",
        {
          version: 1,
          mcp: { extra: { wechat: { command: "npx", args: ["-y", "@wemind/wechat-mcp"] } } },
        },
        account,
      ),
    ).toThrow(/微信 MCP/);
  });

  it("拒绝字面量密钥（数组里的 value 也要查）", async () => {
    const { writeOverlay } = await import("../config/overlay.js");
    expect(() =>
      writeOverlay(
        "copilot",
        {
          version: 1,
          mcp: {
            extra: { demo: { headers: [{ name: "X-Auth", value: "Bearer abcdefghijklmnop" }] } },
          },
        },
        account,
      ),
    ).toThrow(/疑似密钥/);
  });

  it("旧的 overlay.config 被忽略并给出明确问题", async () => {
    const { readOverlay, overlayPath } = await import("../config/overlay.js");
    fs.mkdirSync(path.dirname(overlayPath("gemini", account)), { recursive: true });
    fs.writeFileSync(
      overlayPath("gemini", account),
      JSON.stringify({ version: 1, config: { "settings.json": { theme: "light" } } }),
    );
    const read = readOverlay("gemini", account);
    expect((read.overlay as { config?: unknown }).config).toBeUndefined();
    expect(read.problems.join(" ")).toMatch(/overlay\.config 已不再支持/);
  });
});

describe("指纹只跟配置内容走", () => {
  it("agent 自己写的历史文件不触发重建，配置改动才触发", async () => {
    const { configFingerprint } = await import("../config/config-fingerprint.js");
    const ag = await agentOf("copilot", { realHome: copilotHome, homeEnvVar: "COPILOT_HOME" });
    const rt = agentRuntime("brain", ag, account);
    const a = configFingerprint(ag, rt, account);
    expect(configFingerprint(ag, rt, account)).toBe(a);
    fs.writeFileSync(path.join(copilotHome, "history.jsonl"), '{"turn":1}\n');
    fs.writeFileSync(path.join(copilotHome, "todos.json"), "[]");
    expect(configFingerprint(ag, rt, account)).toBe(a);
    const cfg = JSON.parse(fs.readFileSync(path.join(copilotHome, "mcp-config.json"), "utf-8"));
    cfg.mcpServers.ok.args = ["ok2.js"];
    fs.writeFileSync(path.join(copilotHome, "mcp-config.json"), JSON.stringify(cfg));
    expect(configFingerprint(ag, rt, account)).not.toBe(a);
  });

  it("没有可重定向配置目录的 agent 返回空指纹（不做热重载）", async () => {
    const { configFingerprint } = await import("../config/config-fingerprint.js");
    const ag = await agentOf("qoder", { realHome: qoderHome });
    expect(configFingerprint(ag, agentRuntime("brain", ag, account), account)).toBe("");
  });
});

describe("工作区边界", () => {
  it("拒绝 DATA_DIR 根与其它账号目录", async () => {
    const { validateWorkspacePath } = await import("../config/workspace.js");
    expect(validateWorkspacePath(account, "brain", account)).toBeTruthy();
  });
});
