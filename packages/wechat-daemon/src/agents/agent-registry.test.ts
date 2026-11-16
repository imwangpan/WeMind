import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validateAgentDefinition } from "./agent-definition.js";
import {
  ACP_AGENT_PRESETS,
  BUILTIN_AGENT_DEFINITIONS,
  brokenAgentDefinitionMessage,
  builtinDefinitionNames,
  findAgentDefinition,
  findAgentDefinitionSource,
  findBrokenAgentDefinition,
  getAgentRegistry,
  isAgentToken,
  resetAgentRegistryCache,
} from "./agent-registry.js";
import { agentProblem, presetNames, resolvePresetByName } from "./brain-agents.js";

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

  it("声明 adapter 的定义都解析出了 hooks，且来源可见", () => {
    expect(typeof ACP_AGENT_PRESETS.cline.hooks?.env?.derive).toBe("function");
    expect(typeof ACP_AGENT_PRESETS.kiro.hooks?.engine?.prepareArgs).toBe("function");
    expect(typeof ACP_AGENT_PRESETS.deepseek.hooks?.spawn?.prepare).toBe("function");
    expect(typeof ACP_AGENT_PRESETS.opencode.hooks?.settings?.inherit).toBe("function");
    expect(ACP_AGENT_PRESETS.cline.adapterSource).toBe("builtin:cline-credentials");
    expect(ACP_AGENT_PRESETS.copilot.hooks).toBeUndefined();
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

describe("本机定义层", () => {
  const prev = process.env.WEMIND_AGENTS_DIR;
  let dir = "";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-agent-defs-"));
    process.env.WEMIND_AGENTS_DIR = dir;
    resetAgentRegistryCache();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.WEMIND_AGENTS_DIR;
    else process.env.WEMIND_AGENTS_DIR = prev;
    resetAgentRegistryCache();
  });

  function write(name: string, definition: unknown): string {
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(definition, null, 2), "utf-8");
    return file;
  }

  const minimal = (name: string) => ({
    schemaVersion: 1,
    name,
    bin: `${name}-acp`,
    args: ["--acp"],
  });

  it("目录不存在时只有内置定义，不报错", () => {
    fs.rmSync(dir, { recursive: true, force: true });
    resetAgentRegistryCache();
    const registry = getAgentRegistry();
    expect(Object.keys(registry.definitions)).toEqual(builtinDefinitionNames());
    expect(Object.keys(registry.broken)).toEqual([]);
    expect(registry.dirError).toBeUndefined();
  });

  it("新增本机定义后无需重启即可见；同名整条替换内置", () => {
    // 先建一次缓存（空目录），再写文件：下一次访问应按目录指纹自动重读。
    getAgentRegistry();
    write("test-agent", { ...minimal("test-agent"), model: "test-model", images: false });
    expect(findAgentDefinition("test-agent")?.model).toBe("test-model");
    expect(findAgentDefinitionSource("test-agent")?.kind).toBe("local");
    expect(presetNames()).toContain("test-agent");
    expect(isAgentToken("test-agent")).toBe(true);

    // 同名覆盖是整条替换：内置 kiro 的 kiroEngine 不应残留
    getAgentRegistry();
    write("kiro", { ...minimal("kiro"), bin: "my-kiro", args: ["acp"] });
    expect(findAgentDefinition("kiro")).toMatchObject({ bin: "my-kiro", args: ["acp"] });
    expect(findAgentDefinition("kiro")?.kiroEngine).toBeUndefined();
    expect(findAgentDefinitionSource("kiro")?.kind).toBe("local");
  });

  it("合并视图只把自有键当 agent，同时保留普通对象的原型语义", () => {
    expect(findAgentDefinition("constructor")).toBeUndefined();
    expect(findAgentDefinitionSource("constructor")).toBeUndefined();
    expect(ACP_AGENT_PRESETS["constructor"]).toBe(Object);
    expect(ACP_AGENT_PRESETS.hasOwnProperty("constructor")).toBe(false);
    expect("toString" in ACP_AGENT_PRESETS).toBe(true);
    expect(isAgentToken("constructor")).toBe(false);
  });

  it("坏定义遮住同名内置，并给出文件与修法", () => {
    const file = write("kiro", { schemaVersion: 1, name: "kiro", bin: "kiro-cli" });
    resetAgentRegistryCache();
    expect(ACP_AGENT_PRESETS.kiro).toBeUndefined();
    expect(findAgentDefinition("kiro")).toBeUndefined();
    const broken = findBrokenAgentDefinition("kiro");
    expect(broken?.file).toBe(file);
    const text = brokenAgentDefinitionMessage(broken!);
    expect(text).toContain("args");
    expect(text).toContain(file);
    expect(text).toContain("wemind agent check kiro");

    const r = resolvePresetByName("kiro");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain(file);
  });

  it("文件名与 name 不一致、name=auto、无法解析的外部 adapter 都按坏定义处理", () => {
    write("wrong-file", minimal("other-name"));
    write("auto", minimal("auto"));
    write("adapter-agent", {
      ...minimal("adapter-agent"),
      adapter: { module: "some-plugin", apiVersion: 1 },
    });
    resetAgentRegistryCache();
    expect(findBrokenAgentDefinition("wrong-file")?.problems[0].path).toBe("name");
    expect(findBrokenAgentDefinition("auto")?.problems[0].message).toContain("自动探测");
    expect(findBrokenAgentDefinition("adapter-agent")?.problems[0].message).toContain("无法解析");
  });

  it("自定义 mcpFormat 在 P1 明确失败（不猜格式）", () => {
    write("yaml-agent", {
      ...minimal("yaml-agent"),
      realHome: "~/.yaml-agent",
      mcpFormat: "yaml",
      adapter: { module: "builtin:cline-credentials", apiVersion: 1 },
    });
    resetAgentRegistryCache();
    expect(findBrokenAgentDefinition("yaml-agent")?.problems[0].path).toBe("adapter.module");
  });

  it("本机定义能解析为可切换的 agent；坏定义选择时返回可读原因", () => {
    write("test-agent", { ...minimal("test-agent"), realHome: "~/.test-agent" });
    resetAgentRegistryCache();
    const r = resolvePresetByName("test-agent", {
      agent: "test-agent",
      presets: { "test-agent": { bin: process.execPath } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.agent.name).toBe("test-agent");
      expect(r.agent.definitionProblem).toBeUndefined();
      expect(agentProblem(r.agent)).toBeNull();
      expect(r.agent.realHome).toBe(path.join(os.homedir(), ".test-agent"));
    }
  });

  it("运行期修改 adapter 文件会被指纹发现并重新加载", () => {
    const adapter = path.join(dir, "live-adapter.cjs");
    fs.writeFileSync(
      adapter,
      "module.exports = { apiVersion: 1, hints: { autoProbe: 1 } };\n",
      "utf-8",
    );
    write("live-agent", {
      ...minimal("live-agent"),
      adapter: { module: "./live-adapter.cjs", apiVersion: 1 },
    });
    resetAgentRegistryCache();
    expect(getAgentRegistry().presets["live-agent"]?.hooks?.hints?.autoProbe).toBe(1);

    fs.writeFileSync(
      adapter,
      "module.exports = { apiVersion: 1, hints: { autoProbe: 9 } };\n",
      "utf-8",
    );
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(adapter, future, future);

    expect(getAgentRegistry().presets["live-agent"]?.hooks?.hints?.autoProbe).toBe(9);
  });
});
