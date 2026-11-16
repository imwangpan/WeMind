import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACP_AGENT_PRESETS, getAgentRegistry, resetAgentRegistryCache } from "./agent-registry.js";
import { agentsDir } from "./agent-paths.js";
import { installAgentPackage, removeAgentDefinition } from "./agent-install.js";

describe("agent add/remove（复制即安装）", () => {
  const prev = process.env.WEMIND_AGENTS_DIR;
  let root = "";
  let agents = "";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-install-"));
    agents = path.join(root, "defs");
    process.env.WEMIND_AGENTS_DIR = agents;
    resetAgentRegistryCache();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.WEMIND_AGENTS_DIR;
    else process.env.WEMIND_AGENTS_DIR = prev;
    resetAgentRegistryCache();
  });

  function writePackage(
    name: string,
    def: Record<string, unknown>,
    adapter?: string,
    adapterSource?: string,
  ): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, wemind: { definition: "wemind-agent.json" } }, null, 2),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dir, "wemind-agent.json"),
      JSON.stringify({ schemaVersion: 1, bin: process.execPath, args: [], ...def }, null, 2),
      "utf-8",
    );
    if (adapter)
      fs.writeFileSync(
        path.join(dir, adapter),
        adapterSource ?? "module.exports = { apiVersion: 1 };",
        "utf-8",
      );
    return dir;
  }

  it("安装包：定义与相对 adapter 一起复制，来源标为数据包", async () => {
    const dir = writePackage(
      "demo-pack",
      { name: "ext-pack", adapter: { module: "./adapter.cjs", apiVersion: 1 } },
      "adapter.cjs",
      `module.exports = {
  apiVersion: 1,
  hints: { install: () => "pack-install" },
};`,
    );

    const result = await installAgentPackage(dir);
    expect(result.ok, result.text).toBe(true);
    expect(result.installed).toEqual(["ext-pack"]);

    const installed = JSON.parse(fs.readFileSync(path.join(agents, "ext-pack.json"), "utf-8"));
    expect(installed.adapter.module).toBe("./adapters/ext-pack/adapter.cjs");
    expect(fs.existsSync(path.join(agents, "adapters", "ext-pack", "adapter.cjs"))).toBe(true);
    expect(getAgentRegistry().sources["ext-pack"].kind).toBe("package");
    expect(
      ACP_AGENT_PRESETS["ext-pack"].hooks?.hints?.install?.({ agentName: "ext-pack", bin: "x" }),
    ).toBe("pack-install");

    const removed = removeAgentDefinition("ext-pack");
    expect(removed.ok).toBe(true);
    expect(fs.existsSync(path.join(agents, "ext-pack.json"))).toBe(false);
    expect(fs.existsSync(path.join(agents, "adapters", "ext-pack"))).toBe(false);
    expect(getAgentRegistry().sources["ext-pack"]).toBeUndefined();
  });

  it("覆盖同名内置后 remove：内置定义恢复", async () => {
    const dir = writePackage("kiro-pack", { name: "kiro", args: ["acp"] });
    expect((await installAgentPackage(dir)).ok).toBe(true);
    expect(getAgentRegistry().sources.kiro.kind).toBe("package");
    expect(ACP_AGENT_PRESETS.kiro.kiroEngine).toBeUndefined();

    const removed = removeAgentDefinition("kiro");
    expect(removed.ok).toBe(true);
    expect(getAgentRegistry().sources.kiro.kind).toBe("builtin");
    expect(ACP_AGENT_PRESETS.kiro.kiroEngine).toBe(true);
  });

  it("坏 adapter 安装失败并回滚，不留下半套定义", async () => {
    const dir = writePackage(
      "bad-pack",
      { name: "ext-bad", adapter: { module: "./adapter.cjs", apiVersion: 1 } },
      "adapter.cjs",
      "module.exports = { apiVersion: 2 };",
    );

    const result = await installAgentPackage(dir);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("apiVersion 应为 1");
    expect(fs.existsSync(path.join(agents, "ext-bad.json"))).toBe(false);
    expect(fs.existsSync(path.join(agents, "adapters", "ext-bad"))).toBe(false);
    expect(getAgentRegistry().sources["ext-bad"]).toBeUndefined();
  });

  it("单个 JSON 定义也能安装；remove 只影响本机层", async () => {
    const file = path.join(root, "single.json");
    fs.writeFileSync(
      file,
      JSON.stringify(
        { schemaVersion: 1, name: "ext-single", bin: process.execPath, args: [] },
        null,
        2,
      ),
      "utf-8",
    );
    const result = await installAgentPackage(file);
    expect(result.ok, result.text).toBe(true);
    expect(fs.existsSync(path.join(agentsDir(), "ext-single.json"))).toBe(true);
    expect(getAgentRegistry().sources["ext-single"].kind).toBe("package");
    expect(removeAgentDefinition("builtin-does-not-exist").ok).toBe(false);
  });

  it("直接传 package.json 时按包根安装（不会被当成定义 JSON）", async () => {
    const dir = writePackage("pkg-json-entry", { name: "ext-pkg-json" });
    const result = await installAgentPackage(path.join(dir, "package.json"));
    expect(result.ok, result.text).toBe(true);
    expect(result.installed).toEqual(["ext-pkg-json"]);
    expect(fs.existsSync(path.join(agents, "ext-pkg-json.json"))).toBe(true);
  });

  it("包内重复 agent 名整包拒绝，不留下半套定义", async () => {
    const dir = path.join(root, "duplicate-pack");
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "duplicate-pack", wemind: { definitions: "agents" } }),
      "utf-8",
    );
    for (const name of ["one.json", "two.json"])
      fs.writeFileSync(
        path.join(dir, "agents", name),
        JSON.stringify({ schemaVersion: 1, name: "ext-dup", bin: "x", args: [] }),
        "utf-8",
      );

    const result = await installAgentPackage(dir);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("重复的 agent 名");
    expect(fs.existsSync(path.join(agents, "ext-dup.json"))).toBe(false);
  });
});
