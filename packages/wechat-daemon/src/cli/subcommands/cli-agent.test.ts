import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetAgentRegistryCache } from "../../agents/agent-registry.js";
import { cmdAgent } from "./cli-agent.js";

const FAKE_ACP = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(payload) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n"); }
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && m.method === undefined) return;
  if (m.method === "initialize") {
    send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: true }, promptCapabilities: { image: true } }, agentInfo: { name: "fake", version: "1.0.0" } } });
    return;
  }
  if (m.method === "session/new") {
    send({ id: m.id, result: { sessionId: "fake-session", modes: { availableModes: [{ id: "default" }, { id: "yolo" }] }, configOptions: [{ id: "mode", options: [{ value: "default" }, { value: "yolo" }] }, { id: "model" }] } });
    return;
  }
  if (m.method === "session/load" || m.method === "session/resume" || m.method === "session/set_mode" || m.method === "session/close" || m.method === "session/set_config_option") {
    send({ id: m.id, result: {} });
    return;
  }
  if (m.method === "session/prompt") {
    const text = (m.params.prompt || []).map((p) => p.text || "").join(" ");
    const answer = /secret word/i.test(text) ? "PINEAPPLE" : "OK";
    send({ method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } } } });
    send({ id: m.id, result: { stopReason: "end_turn" } });
    return;
  }
  send({ id: m.id, error: { code: -32601, message: "no" } });
});
setTimeout(() => process.exit(0), 30000);
`;

let dir = "";
let draftDir = "";
let fakeAcp = "";
const prev = process.env.WEMIND_AGENTS_DIR;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-cli-agent-"));
  draftDir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-cli-agent-draft-"));
  fakeAcp = path.join(draftDir, "fake-acp.cjs");
  fs.writeFileSync(fakeAcp, FAKE_ACP, "utf-8");
  process.env.WEMIND_AGENTS_DIR = dir;
  fs.writeFileSync(
    path.join(dir, "test-agent.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "test-agent",
      bin: process.execPath,
      args: [fakeAcp],
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
  it("列出内置与本机定义、来源与损坏文件", async () => {
    const out = await cmdAgent(["list"]);
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
  it("显示最终生效值与本机来源", async () => {
    const out = await cmdAgent(["show", "test-agent"]);
    expect(out).toContain("agent：test-agent");
    expect(out).toContain("定义：本机");
    expect(out).toContain(`bin=${process.execPath}`);
    expect(out).toContain("这是本机定义");
  });

  it("--explain 打印优先级链与环境变量层", async () => {
    const out = await cmdAgent(["show", "test-agent", "--explain"]);
    expect(out).toContain("来源链（优先级从低到高");
    expect(out).toContain("1. 内置");
    expect(out).toContain("2. 本机");
    expect(out).toContain("4. 环境变量");
    expect(out).toContain("定义本体（数据面）");
  });

  it("坏定义：报文件、全部问题与修法，退出码 1", async () => {
    const out = await cmdAgent(["show", "bad-agent"]);
    expect(out).toContain("bad-agent.json");
    expect(out).toContain("JSON 解析失败");
    expect(out).toContain("wemind agent check bad-agent");
    expect(process.exitCode).toBe(1);
  });
});

describe("wemind agent spec", () => {
  it("输出字段表、正反例与自助接入命令", async () => {
    const out = await cmdAgent(["spec"]);
    expect(out).toContain("自助接入流程");
    expect(out).toContain("realHome");
    expect(out).toContain("realhome");
    expect(out).toContain("wemind agent probe");
    expect(out).toContain("wemind agent check");
    expect(out).toContain("JSON Schema");
  });

  it("--json 输出机器可读规格与 JSON Schema", async () => {
    const parsed = JSON.parse(await cmdAgent(["spec", "--json"]));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.jsonSchema.type).toBe("object");
    expect(parsed.fields.some((f: any) => f.key === "acpMcpServers" && f.probe === "probe")).toBe(
      true,
    );
    expect(parsed.fields.some((f: any) => f.key === "images" && f.probe === "deep")).toBe(true);
  });
});

describe("wemind agent check", () => {
  it("--schema 只校验数据面，不启动进程", async () => {
    const out = await cmdAgent(["check", "test-agent", "--schema"]);
    expect(out).toContain("✅ 数据面有效");
    expect(out).toContain("test-agent.json");
    expect(process.exitCode).toBeUndefined();
  });

  it("默认做真实 ACP 握手", async () => {
    const out = await cmdAgent(["check", "test-agent"]);
    expect(out).toContain("ACP 握手成功");
    expect(out).toContain("sessionId=fake-session");
    expect(process.exitCode).toBeUndefined();
  });

  it("--deep 再发一条真实 prompt", async () => {
    const out = await cmdAgent(["check", "test-agent", "--deep"]);
    expect(out).toContain("真实 prompt 成功");
    expect(out).toContain("OK");
    expect(process.exitCode).toBeUndefined();
  }, 15_000);

  it("按文件校验并一次报全问题", async () => {
    const file = path.join(draftDir, "broken.json");
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: "broken", bin: "x" }), "utf-8");
    const out = await cmdAgent(["check", file, "--schema"]);
    expect(out).toContain("定义不合法");
    expect(out).toContain("args");
    expect(process.exitCode).toBe(1);
  });

  it("草稿文件名与 name 不一致只警告；--schema 不启动进程", async () => {
    const draft = path.join(draftDir, "draft.json");
    fs.writeFileSync(
      draft,
      JSON.stringify({ schemaVersion: 1, name: "draft-agent", bin: "x", args: [] }),
      "utf-8",
    );
    const out = await cmdAgent(["check", draft, "--schema"]);
    expect(out).toContain("✅ 数据面有效");
    expect(out).toContain("⚠️");
    expect(process.exitCode).toBeUndefined();
  });

  it("定义文件必须用 .json 后缀", async () => {
    const file = path.join(draftDir, "draft.txt");
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, name: "draft", bin: "x", args: [] }),
      "utf-8",
    );
    const out = await cmdAgent(["check", file, "--schema"]);
    expect(out).toContain("必须以 .json 结尾");
    expect(process.exitCode).toBe(1);
  });

  it("装进 .agents 后文件名大小写也必须与 name 完全一致", async () => {
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
      const out = await cmdAgent(["check", file, "--schema"]);
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

describe("wemind agent probe --draft", () => {
  it("--image / --prompt 等真实回合选项必须配合 --deep", async () => {
    await expect(cmdAgent(["probe", process.execPath, "--image"])).rejects.toThrow(
      "需要同时加 --deep",
    );
  });

  it("用真实握手产出可校验草稿，deep 时验证上下文", async () => {
    const out = await cmdAgent([
      "probe",
      process.execPath,
      "--args",
      JSON.stringify([fakeAcp]),
      "--name",
      "probe-agent",
      "--draft",
      "--deep",
      "--no-mcp-test",
    ]);
    const draft = JSON.parse(out);
    expect(draft.name).toBe("probe-agent");
    expect(draft.bin).toBe(process.execPath);
    expect(draft.restore).toBe("load");
    expect(draft.probe.agentVersion).toBe("1.0.0");
    expect(draft.notes.join("\n")).toContain("session/new 报告的模式");
    expect(draft.notes.join("\n")).toContain("未测试 ACP mcpServers");
    expect(process.exitCode).toBeUndefined();
  }, 20_000);
});
