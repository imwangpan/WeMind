import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedAgent } from "../brain-agents.js";
import {
  mcpAdapterFor,
  mcpAdapterForFile,
  mcpCatalogPath,
  mcpConfigPath,
  MCP_ADAPTERS,
} from "./mcp-adapters.js";

const tmpDirs: string[] = [];

function tmpDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wemind-mcp-adapter-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function agent(over: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    name: "demo",
    realHome: tmpDir("home"),
    catalogFile: "settings/mcp.json",
    mcpConfigFile: "settings/mcp.json",
    mcpFormat: "mcpServers",
    acpMcpServers: false,
    mcpDelivery: "config",
    ...over,
  } as ResolvedAgent;
}

afterEach(() => {
  delete process.env.WEMIND_MCP_CATALOG;
  delete process.env.WECHAT_MCP_CATALOG;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("顶层 mcpServers（JSON）adapter", () => {
  it("读 mcpServers、写回时保留同文件其它键并剥离 MCP 段", () => {
    const file = path.join(tmpDir("flat"), "settings", "mcp.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ other: 1, mcpServers: { demo: { command: "node" } } }));

    expect(MCP_ADAPTERS.jsonMcpServers.readCatalog(file)).toEqual({ demo: { command: "node" } });
    MCP_ADAPTERS.jsonMcpServers.writeCatalog(file, { next: { command: "npx" } });
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({
      other: 1,
      mcpServers: { next: { command: "npx" } },
    });

    const base: Record<string, unknown> = { mcpServers: {}, model: "x" };
    MCP_ADAPTERS.jsonMcpServers.stripSettings(base);
    expect(base).toEqual({ model: "x" });
    expect(MCP_ADAPTERS.jsonMcpServers.nativeCatalog(file)).toEqual({});
  });

  it("继承真实 settings/，但不继承 mcp.json；只读缺失目录时保持安静", () => {
    const realHome = tmpDir("flat-real");
    fs.mkdirSync(path.join(realHome, "settings"), { recursive: true });
    fs.writeFileSync(path.join(realHome, "settings", "cli.json"), JSON.stringify({ model: "x" }));
    fs.writeFileSync(
      path.join(realHome, "settings", "mcp.json"),
      JSON.stringify({ mcpServers: {} }),
    );
    const target = tmpDir("flat-target");

    MCP_ADAPTERS.jsonMcpServers.inheritSettings?.(agent({ realHome }), realHome, target);

    expect(JSON.parse(fs.readFileSync(path.join(target, "settings", "cli.json"), "utf-8"))).toEqual(
      {
        model: "x",
      },
    );
    expect(fs.existsSync(path.join(target, "settings", "mcp.json"))).toBe(false);
  });
});

describe("嵌套 mcp.servers（JSON）adapter", () => {
  it("读 mcp.servers；写入保留其它键并默认补 permission=allow", () => {
    const file = path.join(tmpDir("nested"), "opencode.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ model: "demo/model", mcp: { servers: { old: { command: ["x"] } } } }),
    );

    expect(MCP_ADAPTERS.jsonMcpNested.readCatalog(file)).toEqual({ old: { command: ["x"] } });
    MCP_ADAPTERS.jsonMcpNested.writeCatalog(file, { demo: { command: ["node", "s.js"] } });
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({
      model: "demo/model",
      mcp: { servers: { demo: { command: ["node", "s.js"] } } },
      permission: "allow",
    });

    const base: Record<string, unknown> = { mcp: {}, model: "x" };
    MCP_ADAPTERS.jsonMcpNested.stripSettings(base);
    expect(base).toEqual({ model: "x" });
  });

  it("用户显式配置的 permission 不会被默认值覆盖", () => {
    const file = path.join(tmpDir("nested-perm"), "opencode.json");
    fs.writeFileSync(file, JSON.stringify({ permission: { bash: "deny" } }));
    MCP_ADAPTERS.jsonMcpNested.writeCatalog(file, {});
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).permission).toEqual({ bash: "deny" });
  });

  it("inheritSettings 复制 model 等设置，但剔除 mcp 段", () => {
    const realHome = tmpDir("nested-real");
    fs.writeFileSync(
      path.join(realHome, "opencode.json"),
      JSON.stringify({ model: "demo/model", mcp: { servers: { wechat: {} } } }),
    );
    const target = tmpDir("nested-target");
    const ag = agent({ mcpFormat: "mcp.servers", realHome });

    MCP_ADAPTERS.jsonMcpNested.inheritSettings?.(ag, realHome, target);

    const out = JSON.parse(fs.readFileSync(mcpConfigPath(ag, target), "utf-8"));
    expect(out).toEqual({ model: "demo/model" });
  });
});

describe("TOML [mcp_servers.*] adapter", () => {
  it("只读解析 [mcp_servers.*]，写入直接报错", () => {
    const file = path.join(tmpDir("toml"), "config.toml");
    fs.writeFileSync(
      file,
      '[mcp_servers.fake]\ncommand = "node"\nargs = ["s.js"]\n\n[mcp_servers.remote]\nurl = "https://x/mcp"\n',
    );

    expect(MCP_ADAPTERS.tomlMcpServers.readCatalog(file)).toEqual({
      fake: { command: "node", args: ["s.js"] },
      remote: { url: "https://x/mcp" },
    });
    expect(MCP_ADAPTERS.tomlMcpServers.nativeCatalog(file)).toEqual(
      MCP_ADAPTERS.tomlMcpServers.readCatalog(file),
    );
    expect(() => MCP_ADAPTERS.tomlMcpServers.writeCatalog(file, {})).toThrow(/只读/);
  });
});

describe("adapter 选择与路径", () => {
  it("按 mcpFormat / 文件后缀选择；DSH profile 走 YAML 适配器", () => {
    expect(mcpAdapterFor(agent())).toBe(MCP_ADAPTERS.jsonMcpServers);
    expect(mcpAdapterFor(agent({ mcpFormat: "mcp.servers" }))).toBe(MCP_ADAPTERS.jsonMcpNested);
    expect(
      mcpAdapterFor(agent({ name: "codex", acpMcpServers: true, catalogFile: "config.toml" })),
    ).toBe(MCP_ADAPTERS.tomlMcpServers);
    expect(mcpAdapterFor(agent({ name: "deepseek", mcpFormat: "dshProfileYaml" }))).toBe(
      MCP_ADAPTERS.dshProfileYaml,
    );
    expect(
      mcpAdapterForFile(agent({ name: "custom", catalogFile: "config.toml" }), "x/config.toml"),
    ).toBe(MCP_ADAPTERS.tomlMcpServers);
  });

  it("catalog 可用环境变量覆盖；MCP 文件按配置目录拼接", () => {
    const ag = agent();
    process.env.WEMIND_MCP_CATALOG = path.join("D:", "catalog", "mcp.json");
    expect(mcpCatalogPath(ag)).toBe(process.env.WEMIND_MCP_CATALOG);
    expect(mcpConfigPath(ag, path.join("sandbox", "demo"))).toBe(
      path.join("sandbox", "demo", "settings", "mcp.json"),
    );
  });
});
