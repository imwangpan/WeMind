import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetAgentRegistryCache } from "../../agents/agent-registry.js";
import { cmdAgent } from "./cli-agent.js";

let dir = "";
let draftDir = "";
const prev = process.env.WEMIND_AGENTS_DIR;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-cli-agent-"));
  draftDir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-cli-agent-draft-"));
  process.env.WEMIND_AGENTS_DIR = dir;
  fs.writeFileSync(
    path.join(dir, "test-agent.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "test-agent",
      bin: "test-agent-acp",
      args: ["--acp"],
      fallbackBinPaths: [process.execPath],
      realHome: "~/.test-agent",
      notes: ["这是本机定义"],
    }),
    "utf-8",
  );
  fs.writeFileSync(path.join(dir, "bad-agent.json"), "{ nope", "utf-8");
  resetAgentRegistryCache();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(draftDir, { recursive: true, force: true });
  if (prev === undefined) delete process.env.WEMIND_AGENTS_DIR;
  else process.env.WEMIND_AGENTS_DIR = prev;
  resetAgentRegistryCache();
});

beforeEach(() => {
  process.exitCode = undefined;
});

describe("wemind agent list", () => {
  it("列出内置与本机定义、来源与损坏文件", () => {
    const out = cmdAgent(["list"]);
    expect(out).toContain("agent 定义目录");
    expect(out).toContain("test-agent");
    expect(out).toContain("本机");
    expect(out).toContain("bad-agent");
    expect(out).toContain("定义损坏");
    expect(out).toContain("wemind agent check bad-agent");
    expect(out).toContain("kiro");
  });
});

describe("wemind agent show", () => {
  it("显示最终生效值与本机来源", () => {
    const out = cmdAgent(["show", "test-agent"]);
    expect(out).toContain("agent：test-agent");
    expect(out).toContain("定义：本机");
    expect(out).toContain(`bin=${process.execPath}`);
    expect(out).toContain("args=[--acp]");
    expect(out).toContain("这是本机定义");
  });

  it("--explain 打印优先级链与环境变量层", () => {
    const out = cmdAgent(["show", "test-agent", "--explain"]);
    expect(out).toContain("来源链（优先级从低到高");
    expect(out).toContain("1. 内置");
    expect(out).toContain("2. 本机");
    expect(out).toContain("4. 环境变量");
    expect(out).toContain("定义本体（数据面）");
  });

  it("坏定义：报文件、全部问题与修法，退出码 1", () => {
    const out = cmdAgent(["show", "bad-agent"]);
    expect(out).toContain("bad-agent.json");
    expect(out).toContain("JSON 解析失败");
    expect(out).toContain("wemind agent check bad-agent");
    expect(process.exitCode).toBe(1);
  });
});

describe("wemind agent check", () => {
  it("按名字校验有效定义", () => {
    const out = cmdAgent(["check", "test-agent"]);
    expect(out).toContain("✅ 数据面有效");
    expect(out).toContain("test-agent.json");
    expect(process.exitCode).toBeUndefined();
  });

  it("按文件校验并一次报全问题", () => {
    const file = path.join(draftDir, "broken.json");
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: "broken", bin: "x" }), "utf-8");
    const out = cmdAgent(["check", file]);
    expect(out).toContain("定义不合法");
    expect(out).toContain("args");
    expect(process.exitCode).toBe(1);
  });

  it("草稿文件名与 name 不一致只警告；装进 .agents 才拒绝", () => {
    const draft = path.join(draftDir, "draft.json");
    fs.writeFileSync(
      draft,
      JSON.stringify({ schemaVersion: 1, name: "draft-agent", bin: "x", args: [] }),
      "utf-8",
    );
    const out = cmdAgent(["check", draft]);
    expect(out).toContain("✅ 数据面有效");
    expect(out).toContain("⚠️");
    expect(process.exitCode).toBeUndefined();
  });

  it("定义文件必须用 .json 后缀", () => {
    const file = path.join(draftDir, "draft.txt");
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, name: "draft", bin: "x", args: [] }),
      "utf-8",
    );
    const out = cmdAgent(["check", file]);
    expect(out).toContain("必须以 .json 结尾");
    expect(process.exitCode).toBe(1);
  });

  it("装进 .agents 后文件名大小写也必须与 name 完全一致", () => {
    const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-cli-agent-case-"));
    const saved = process.env.WEMIND_AGENTS_DIR;
    process.env.WEMIND_AGENTS_DIR = caseDir;
    resetAgentRegistryCache();
    try {
      const file = path.join(caseDir, "Case-Agent.json");
      fs.writeFileSync(
        file,
        JSON.stringify({
          schemaVersion: 1,
          name: "case-agent",
          bin: "x",
          args: [],
        }),
        "utf-8",
      );
      const out = cmdAgent(["check", file]);
      expect(out).toContain("必须命名为 case-agent.json");
      expect(process.exitCode).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.WEMIND_AGENTS_DIR;
      else process.env.WEMIND_AGENTS_DIR = saved;
      resetAgentRegistryCache();
      fs.rmSync(caseDir, { recursive: true, force: true });
    }
  });
});
