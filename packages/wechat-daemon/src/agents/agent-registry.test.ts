import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateAgentDefinition } from "./agent-definition.js";
import {
  ACP_AGENT_PRESETS,
  BUILTIN_AGENT_DEFINITIONS,
  builtinDefinitionNames,
} from "./agent-registry.js";

const EXPECTED_NAMES = [
  "kiro",
  "gemini",
  "copilot",
  "opencode",
  "deepseek",
  "qoder",
  "cline",
  "pi",
  "claude-code",
  "codex",
];

describe("内置 agent 定义注册表", () => {
  it("10 份内置定义都在，顺序稳定（帮助文案按这个顺序展示）", () => {
    expect(builtinDefinitionNames()).toEqual(EXPECTED_NAMES);
    expect(Object.keys(ACP_AGENT_PRESETS)).toEqual(EXPECTED_NAMES);
  });

  it("每份定义都通过数据面契约校验（未知字段/类型错误在加载时就该炸）", () => {
    for (const name of EXPECTED_NAMES) {
      const result = validateAgentDefinition(BUILTIN_AGENT_DEFINITIONS[name]);
      expect(result.ok, name).toBe(true);
      expect(BUILTIN_AGENT_DEFINITIONS[name].schemaVersion).toBe(1);
      expect(BUILTIN_AGENT_DEFINITIONS[name].name).toBe(name);
    }
  });

  it("每份定义都带维护者说明（JSON 没注释，实测结论不能丢）", () => {
    for (const name of EXPECTED_NAMES)
      expect(BUILTIN_AGENT_DEFINITIONS[name].notes?.length, name).toBeGreaterThan(0);
  });

  it("`~` 在绝对路径字段里被展开；相对字段保持原写法", () => {
    for (const def of Object.values(BUILTIN_AGENT_DEFINITIONS)) {
      for (const p of [
        def.realHome,
        ...(def.fallbackBinPaths ?? []),
        ...(def.extraConfigFiles ?? []),
      ])
        expect(p ?? "", def.name).not.toContain("~");
    }
    expect(BUILTIN_AGENT_DEFINITIONS.kiro.realHome).toBe(path.join(os.homedir(), ".kiro"));
    expect(BUILTIN_AGENT_DEFINITIONS["claude-code"].extraConfigFiles).toEqual([
      path.join(os.homedir(), ".claude.json"),
    ]);
    expect(BUILTIN_AGENT_DEFINITIONS["claude-code"].catalogFile).toBe("../.claude.json");
  });

  it("只有 cline 把凭据派生挂成代码 hook（其余仍是纯数据）", () => {
    expect(typeof ACP_AGENT_PRESETS.cline.credentialEnv).toBe("function");
    for (const name of EXPECTED_NAMES.filter((n) => n !== "cline"))
      expect(ACP_AGENT_PRESETS[name].credentialEnv, name).toBeUndefined();
  });

  it("关键能力字段没有在迁移中丢失", () => {
    const d = BUILTIN_AGENT_DEFINITIONS;
    expect(d.kiro.kiroEngine).toBe(true);
    expect(d.gemini).toMatchObject({
      configSubdir: ".gemini",
      modelArg: "--model",
      replayOnLoad: true,
      shell: true,
    });
    expect(d.copilot.mcpDelivery).toBe("config");
    expect(d.opencode.mcpFormat).toBe("mcp.servers");
    expect(d.deepseek).toMatchObject({
      restore: "resume",
      images: false,
      realProfile: "acp",
      mcpDelivery: "acp",
      acpMcpServers: true,
      isolateSessions: true,
      firstFrameMs: 60_000,
      heartbeatMs: 60_000,
    });
    expect(d.qoder.fallbackBinPaths?.[0]).toBe(
      path.join(os.homedir(), ".qoder", "bin", "qodercli", "qodercli.exe"),
    );
    expect(d.qoder.identityFiles).toEqual([".auth/machine_id"]);
    expect(d.cline.images).toBe(false);
    expect(d.pi.requiresBins).toEqual(["pi"]);
    expect(d.pi.settingsDefaults).toEqual({ quietStartup: true });
    expect(d["claude-code"]).toMatchObject({
      acpMcpServers: true,
      mcpDelivery: "acp",
      sessionMode: "bypassPermissions",
    });
    expect(d.codex).toMatchObject({
      acpMcpServers: true,
      mcpDelivery: "acp",
      sessionMode: "agent-full-access",
      heartbeatMs: 60_000,
    });
    expect(d.codex.envDefaults).toEqual({ INITIAL_AGENT_MODE: "agent-full-access" });
  });
});
