import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACP_AGENT_PRESETS,
  findBrokenAgentDefinition,
  getAgentRegistry,
  resetAgentRegistryCache,
} from "./agent-registry.js";
import { resetAgentAdapterCache, preloadAgentAdapters } from "./agent-adapter-loader.js";
import { agentEnv, authHint, resolveAgentByName } from "./brain-agents.js";

describe("外部 adapter 插件", () => {
  const prev = process.env.WEMIND_AGENTS_DIR;
  let dir = "";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-adapter-"));
    process.env.WEMIND_AGENTS_DIR = dir;
    resetAgentRegistryCache();
    resetAgentAdapterCache();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.WEMIND_AGENTS_DIR;
    else process.env.WEMIND_AGENTS_DIR = prev;
    resetAgentRegistryCache();
  });

  function writeDefinition(name: string, adapter: string): string {
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          schemaVersion: 1,
          name,
          bin: process.execPath,
          args: [],
          adapter: { module: adapter, apiVersion: 1 },
        },
        null,
        2,
      ),
      "utf-8",
    );
    return file;
  }

  it("CJS 插件可同步加载，hook 生效且来源可见", () => {
    writeDefinition("ext-cjs", "./adapter.cjs");
    fs.writeFileSync(
      path.join(dir, "adapter.cjs"),
      `module.exports = {
  apiVersion: 1,
  env: { derive: () => ({ FROM_ADAPTER: "yes" }) },
  hints: { auth: () => "custom-auth-hint" },
};`,
      "utf-8",
    );
    resetAgentRegistryCache();

    const preset = ACP_AGENT_PRESETS["ext-cjs"];
    expect(preset.hooks?.env?.derive).toBeTypeOf("function");
    expect(preset.adapterSource).toBe(path.join(dir, "adapter.cjs"));
    const ag = resolveAgentByName("ext-cjs");
    expect(agentEnv(ag, dir).FROM_ADAPTER).toBe("yes");
    expect(authHint("ext-cjs", "authentication required")).toBe("custom-auth-hint");
  });

  it("ESM 插件可被预加载；同步 require 不支持时按坏定义 fail-closed", async () => {
    writeDefinition("ext-esm", "./adapter.mjs");
    fs.writeFileSync(
      path.join(dir, "adapter.mjs"),
      `export default {
  apiVersion: 1,
  hints: { install: () => "esm-install-hint" },
};`,
      "utf-8",
    );
    resetAgentRegistryCache();

    // Node ≥22.12 可以同步 require 无 TLA 的 ESM；更早版本会在这里留下可读的坏定义。
    const before = ACP_AGENT_PRESETS["ext-esm"];
    if (!before?.hooks) {
      expect(findBrokenAgentDefinition("ext-esm")?.problems[0].path).toBe("adapter.module");
      expect(findBrokenAgentDefinition("ext-esm")?.problems[0].message).toContain("ESM");
    }

    const preloaded = await preloadAgentAdapters({ refresh: true });
    expect(preloaded.problems).toEqual([]);
    resetAgentRegistryCache();
    expect(ACP_AGENT_PRESETS["ext-esm"].hooks?.hints?.install).toBeTypeOf("function");
    expect(ACP_AGENT_PRESETS["ext-esm"].adapterSource).toBe(path.join(dir, "adapter.mjs"));
  });

  it("apiVersion 不匹配或含未知 hook 时拒绝加载（不做静默忽略）", () => {
    writeDefinition("ext-bad-version", "./bad-version.cjs");
    fs.writeFileSync(
      path.join(dir, "bad-version.cjs"),
      `module.exports = { apiVersion: 2 };`,
      "utf-8",
    );
    writeDefinition("ext-bad-hook", "./bad-hook.cjs");
    fs.writeFileSync(
      path.join(dir, "bad-hook.cjs"),
      `module.exports = { apiVersion: 1, engin: { prepareArgs() {} } };`,
      "utf-8",
    );
    resetAgentRegistryCache();

    expect(findBrokenAgentDefinition("ext-bad-version")?.problems[0].message).toContain(
      "apiVersion 应为 1",
    );
    expect(findBrokenAgentDefinition("ext-bad-hook")?.problems[0].message).toContain(
      "未知顶层键「engin」",
    );
  });

  it("插件可以给自定义 mcpFormat 提供读写实现", () => {
    writeDefinition("ext-mcp", "./mcp-adapter.cjs");
    const file = path.join(dir, "ext-mcp.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    raw.mcpFormat = "custom-yaml";
    raw.realHome = path.join(dir, "ext-home");
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), "utf-8");
    fs.writeFileSync(
      path.join(dir, "mcp-adapter.cjs"),
      `module.exports = {
  apiVersion: 1,
  mcp: {
    id: "custom-yaml",
    nativeOwned: false,
    readCatalog: () => ({}),
    writeCatalog: () => {},
    stripSettings: () => {},
    toAcp: () => ({ servers: [], skipped: [] }),
    nativeCatalog: () => ({}),
  },
};`,
      "utf-8",
    );
    resetAgentRegistryCache();

    const ag = resolveAgentByName("ext-mcp");
    expect(getAgentRegistry().broken["ext-mcp"]).toBeUndefined();
    expect(ag.mcpFormat).toBe("custom-yaml");
    expect(ag.hooks?.mcp?.id).toBe("custom-yaml");
  });

  it("mcp 必须实现完整接口；嵌套对象里的未知键也不静默忽略", () => {
    writeDefinition("ext-bad-mcp", "./bad-mcp.cjs");
    const file = path.join(dir, "ext-bad-mcp.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    raw.mcpFormat = "custom-yaml";
    raw.realHome = path.join(dir, "ext-home");
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), "utf-8");
    fs.writeFileSync(
      path.join(dir, "bad-mcp.cjs"),
      `module.exports = {
  apiVersion: 1,
  mcp: {
    id: "custom-yaml",
    nativeOwned: false,
    readCatalog: () => ({}),
    writeCatalog: () => {},
    stripSettings: () => {},
    toAcp: () => ({ servers: [], skipped: [] }),
    nativeCatalg: () => ({}),
  },
};`,
      "utf-8",
    );
    resetAgentRegistryCache();

    const message = findBrokenAgentDefinition("ext-bad-mcp")?.problems[0].message ?? "";
    expect(message).toContain(
      "adapter.mcp.nativeCatalg 是未知字段（可用：id / nativeOwned / readCatalog / writeCatalog / stripSettings / toAcp / nativeCatalog）",
    );
    expect(message).toContain("adapter.mcp.nativeCatalog 应为函数");
  });
});
