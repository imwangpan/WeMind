import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ResolvedAgent } from "../brain-agents.js";

/**
 * real / mirror 模式的安全边界：没有配置目录环境变量的 agent 绝不写真实 home；有视图的 agent 必须剔除微信 MCP；
 * overlay 的坏键/穿越/微信条目在写入时就拒绝；指纹只跟配置内容有关，不被 agent 自己的历史文件带偏。
 *
 * 模块级 DATA_DIR 在 import 时解析，所以环境变量必须在动态 import 之前设好。
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-parity-real-"));
const dataDir = path.join(root, "data");
const account = path.join(dataDir, "acc");
const qoderHome = path.join(root, "qoder-home");
const copilotHome = path.join(root, "copilot-home");
const geminiHome = path.join(root, "gemini-home");
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
  fs.mkdirSync(geminiHome, { recursive: true });
  fs.writeFileSync(
    path.join(geminiHome, "settings.json"),
    JSON.stringify({ theme: "dark", model: "g" }),
  );
  process.env.WECHAT_ACCOUNT = "acc";
  process.env.WECHAT_DATA_DIR = account;
  process.env.WEMIND_HOME_MODE = "real";
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
    realEnv: {},
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

describe("real 模式：没有配置目录环境变量的 agent", () => {
  it("ensureBrainHome 不写真实 settings.json，也不生成视图", async () => {
    const { ensureBrainHome } = await import("./mcp-sandbox.js");
    const { configFingerprint } = await import("../config/config-fingerprint.js");
    const ag = await agentOf("qoder", { realHome: qoderHome });
    const before = fs.readFileSync(path.join(qoderHome, "settings.json"), "utf-8");

    const rt = ensureBrainHome(ag);
    expect(rt.view).toBeUndefined();
    expect(fs.readFileSync(path.join(qoderHome, "settings.json"), "utf-8")).toBe(before);
    // 没有视图 → 没有需要重建的东西；指纹不能因为 enableBrainHome 自己而变化
    expect(configFingerprint(ag)).toBe("");
  });

  it("真实配置含微信 MCP 时拒绝启动（不改、不剥离）", async () => {
    const { assertNoForbiddenNativeMcp } = await import("./mcp-sandbox.js");
    const ag = await agentOf("qoder", { realHome: qoderHome });
    expect(() => assertNoForbiddenNativeMcp(ag)).toThrow(/微信 MCP/);
  });
});

describe("real 模式：有视图的 agent", () => {
  it("copilot 视图里的微信 MCP 被剔除，真实文件保持原样", async () => {
    const { ensureBrainHome } = await import("./mcp-sandbox.js");
    const ag = await agentOf("copilot", { realHome: copilotHome });
    const rt = ensureBrainHome(ag);
    expect(rt.view?.root).toBe(path.join(account, "agent-view", "brain", "copilot"));
    const viewFile = path.join(rt.view!.configDir, "mcp-config.json");
    const view = JSON.parse(fs.readFileSync(viewFile, "utf-8"));
    expect(Object.keys(view.mcpServers)).toEqual(["ok"]);
    const real = JSON.parse(fs.readFileSync(path.join(copilotHome, "mcp-config.json"), "utf-8"));
    expect(Object.keys(real.mcpServers)).toContain("wechat");
  });
});

describe("overlay 写入边界", () => {
  it("拒绝非法 agent 名（防 ../ 写到别的文件）", async () => {
    const { overlayPath } = await import("../config/overlay.js");
    expect(() => overlayPath("../../runtime", account)).toThrow(/agent 名/);
    expect(() => overlayPath("..", account)).toThrow(/agent 名/);
  });

  it("拒绝把微信 MCP 写进 overlay（会进入视图副本）", async () => {
    const { writeOverlay } = await import("../config/overlay.js");
    expect(() =>
      writeOverlay(
        "copilot",
        {
          version: 1,
          config: {
            "mcp-config.json": {
              mcpServers: { wechat: { command: "npx", args: ["-y", "@wemind/wechat-mcp"] } },
            },
          },
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
          config: {
            "mcp-config.json": {
              headers: [{ name: "X-Auth", value: "Bearer abcdefghijklmnop" }],
            },
          },
        },
        account,
      ),
    ).toThrow(/疑似密钥/);
  });

  it("拒绝把 key 指到 real home 之外", async () => {
    const { writeOverlay } = await import("../config/overlay.js");
    expect(() =>
      writeOverlay("copilot", { version: 1, config: { "../../evil.json": { a: 1 } } }, account),
    ).toThrow(/相对路径|real home/);
  });
});

describe("配置视图：overlay 回退与真实文件更新", () => {
  it("overlay 改了文件后，真实值更新仍能刷新；撤掉 overlay 回到真实值", async () => {
    const { ensureBrainHome } = await import("./mcp-sandbox.js");
    const { writeOverlay } = await import("../config/overlay.js");
    const ag = await agentOf("gemini", { realHome: geminiHome });
    const realFile = path.join(geminiHome, "settings.json");
    const viewFile = path.join(
      account,
      "agent-view",
      "brain",
      "gemini",
      ".gemini",
      "settings.json",
    );

    writeOverlay(
      "gemini",
      { version: 1, config: { "settings.json": { theme: "light" } } },
      account,
    );
    let rt = ensureBrainHome(ag);
    expect(JSON.parse(fs.readFileSync(viewFile, "utf-8")).theme).toBe("light");

    // 终端侧改了真实值（overlay 未覆盖的键）→ 下一次重建必须看到
    fs.writeFileSync(realFile, JSON.stringify({ theme: "blue", model: "g2" }));
    rt = ensureBrainHome(ag);
    expect(JSON.parse(fs.readFileSync(viewFile, "utf-8"))).toMatchObject({
      theme: "light",
      model: "g2",
    });

    // 撤掉 overlay → 回到真实值，而不是停在旧的 light
    writeOverlay("gemini", { version: 1 }, account);
    rt = ensureBrainHome(ag);
    expect(rt.view).toBeDefined();
    expect(JSON.parse(fs.readFileSync(viewFile, "utf-8"))).toMatchObject({
      theme: "blue",
      model: "g2",
    });
  });

  it("链接位置被 Agent 换成真实文件时保留用户改动，不删", async () => {
    const { ensureBrainHome } = await import("./mcp-sandbox.js");
    const ag = await agentOf("gemini", { realHome: geminiHome });
    const realFile = path.join(geminiHome, "notes.md");
    fs.writeFileSync(realFile, "from-terminal");
    ensureBrainHome(ag);
    const viewFile = path.join(account, "agent-view", "brain", "gemini", ".gemini", "notes.md");
    fs.rmSync(viewFile, { force: true });
    fs.writeFileSync(viewFile, "edited-in-view");
    ensureBrainHome(ag);
    expect(fs.readFileSync(viewFile, "utf-8")).toBe("edited-in-view");
    expect(fs.lstatSync(viewFile).isFile()).toBe(true);
  });

  it("真实配置文件不是合法 JSON 时不覆盖（宁可只告警）", async () => {
    const { ensureBrainHome } = await import("./mcp-sandbox.js");
    const ag = await agentOf("gemini", { realHome: geminiHome });
    const realFile = path.join(geminiHome, "settings.json");
    fs.writeFileSync(realFile, "{ broken");
    expect(() => ensureBrainHome(ag)).not.toThrow();
    expect(fs.readFileSync(realFile, "utf-8")).toBe("{ broken");
  });
});

describe("指纹只跟配置内容走", () => {
  it("agent 自己写的历史文件不触发重建，配置改动才触发", async () => {
    const { configFingerprint } = await import("../config/config-fingerprint.js");
    const ag = await agentOf("copilot", { realHome: copilotHome, homeEnvVar: "COPILOT_HOME" });
    const a = configFingerprint(ag);
    expect(configFingerprint(ag)).toBe(a);
    fs.writeFileSync(path.join(copilotHome, "history.jsonl"), '{"turn":1}\n');
    fs.writeFileSync(path.join(copilotHome, "todos.json"), "[]");
    expect(configFingerprint(ag)).toBe(a);
    const cfg = JSON.parse(fs.readFileSync(path.join(copilotHome, "mcp-config.json"), "utf-8"));
    cfg.mcpServers.ok.args = ["ok2.js"];
    fs.writeFileSync(path.join(copilotHome, "mcp-config.json"), JSON.stringify(cfg));
    expect(configFingerprint(ag)).not.toBe(a);
  });

  it("mirror 下没有视图的 agent 也返回空指纹（与 real 等价）", async () => {
    const { configFingerprint } = await import("../config/config-fingerprint.js");
    const dir = path.join(root, "mirror-data");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "runtime.json"),
      JSON.stringify({ version: 1, homeMode: "mirror" }),
    );
    const ag = await agentOf("qoder", { realHome: qoderHome });
    expect(configFingerprint(ag, dir)).toBe("");
  });
});

describe("工作区边界", () => {
  it("拒绝 DATA_DIR 根与其它账号目录", async () => {
    const { validateWorkspacePath } = await import("../config/workspace.js");
    expect(validateWorkspacePath(dataDir, "brain", account)).toBeTruthy();
  });
});
