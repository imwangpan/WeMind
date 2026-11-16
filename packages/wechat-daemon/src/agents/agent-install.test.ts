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

  it("remove 拒绝路径穿越，不会删到定义目录之外", () => {
    const outside = path.join(root, "acct", "brain.json");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, "keep", "utf-8");
    const result = removeAgentDefinition("../acct/brain");
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(outside, "utf-8")).toBe("keep");
  });

  it("覆盖本机手写定义时生成 .bak 并在回执里说明", async () => {
    fs.mkdirSync(agents, { recursive: true });
    const file = path.join(agents, "ext-local.json");
    fs.writeFileSync(file, '{"old":true}\n', "utf-8");
    const dir = writePackage("local-pack", { name: "ext-local" });
    const result = await installAgentPackage(dir);
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain("覆盖本机手写定义");
    expect(fs.readFileSync(`${file}.bak`, "utf-8")).toBe('{"old":true}\n');
  });

  it(".sources.json 损坏时拒绝写入并保留原文件", async () => {
    fs.mkdirSync(agents, { recursive: true });
    const sources = path.join(agents, ".sources.json");
    fs.writeFileSync(sources, "{broken", "utf-8");
    const dir = writePackage("sources-broken", { name: "ext-sources-broken" });
    const result = await installAgentPackage(dir);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("不写入");
    expect(fs.readFileSync(sources, "utf-8")).toBe("{broken");
    expect(fs.existsSync(path.join(agents, "ext-sources-broken.json"))).toBe(false);
  });

  it("重装会清掉旧 adapter 文件；去掉 adapter 后清空目录", async () => {
    const first = writePackage(
      "adapter-a",
      { name: "ext-adapter", adapter: { module: "./a.cjs", apiVersion: 1 } },
      "a.cjs",
      "module.exports = { apiVersion: 1 };",
    );
    expect((await installAgentPackage(first)).ok).toBe(true);
    const adapterDir = path.join(agents, "adapters", "ext-adapter");
    expect(fs.existsSync(path.join(adapterDir, "a.cjs"))).toBe(true);

    const second = writePackage(
      "adapter-b",
      { name: "ext-adapter", adapter: { module: "./b.cjs", apiVersion: 1 } },
      "b.cjs",
      "module.exports = { apiVersion: 1 };",
    );
    expect((await installAgentPackage(second)).ok).toBe(true);
    expect(fs.existsSync(path.join(adapterDir, "a.cjs"))).toBe(false);
    expect(fs.existsSync(path.join(adapterDir, "b.cjs"))).toBe(true);

    const third = writePackage("adapter-none", { name: "ext-adapter" });
    expect((await installAgentPackage(third)).ok).toBe(true);
    expect(fs.existsSync(adapterDir)).toBe(false);
  });

  it("并发安装不同定义时不会丢掉先写者的来源记录", async () => {
    const a = writePackage("parallel-a", { name: "ext-parallel-a" });
    const b = writePackage("parallel-b", { name: "ext-parallel-b" });
    const [ra, rb] = await Promise.all([installAgentPackage(a), installAgentPackage(b)]);
    expect(ra.ok, ra.text).toBe(true);
    expect(rb.ok, rb.text).toBe(true);
    const sources = JSON.parse(fs.readFileSync(path.join(agents, ".sources.json"), "utf-8"));
    expect(sources["ext-parallel-a"]?.kind).toBe("package");
    expect(sources["ext-parallel-b"]?.kind).toBe("package");
  });
});
