import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { validateAgentDefinition } from "../agents/agent-definition.js";
import { draftFromProbe, probeAgent, type AgentProbeOptions } from "./agent-probe.js";

vi.setConfig({ testTimeout: 20_000 });

const FAKE = `
const fs = require("node:fs");
const readline = require("node:readline");
const mode = process.argv[2] || "ok";
const log = process.env.FAKE_PROBE_LOG;
const rl = readline.createInterface({ input: process.stdin });
function send(payload) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n"); }
function record(method, params) { if (log) fs.appendFileSync(log, method + " " + JSON.stringify(params || {}) + "\\n"); }
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && m.method === undefined) return;
  record(m.method, m.params);
  if (m.method === "initialize") {
    send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: true }, promptCapabilities: { image: true } }, agentInfo: { name: "fake", version: "9.9.9" } } });
    return;
  }
  if (m.method === "session/new") {
    if (mode === "reject-mcp" && (m.params.mcpServers || []).length) {
      send({ id: m.id, error: { code: -32603, message: "mcpServers not supported" } });
      return;
    }
    send({ id: m.id, result: { sessionId: "probe-session", modes: { availableModes: [{ id: "default" }, { id: "yolo" }] }, configOptions: [{ id: "mode", options: [{ value: "default" }, { value: "yolo" }] }, { id: "model", currentValue: "auto" }] } });
    return;
  }
  if (m.method === "session/load" || m.method === "session/resume") {
    if (mode === "no-restore") send({ id: m.id, error: { code: -32602, message: "session not found" } });
    else {
      send({ id: m.id, result: {} });
      if (mode === "replay") {
        setTimeout(() => {
          send({ method: "session/update", params: { sessionId: "probe-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old history" } } } });
        }, 50);
      }
    }
    return;
  }
  if (m.method === "session/set_config_option" || m.method === "session/set_mode" || m.method === "session/close") {
    send({ id: m.id, result: {} });
    return;
  }
  if (m.method === "session/prompt") {
    const text = (m.params.prompt || []).map((p) => p.text || "").join(" ");
    const answer = /remember the secret word/i.test(text) ? "STORED" : /secret word/i.test(text) ? "PINEAPPLE" : "OK";
    send({ method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } } } });
    send({ id: m.id, result: { stopReason: "end_turn" } });
    return;
  }
  send({ id: m.id, error: { code: -32601, message: "no" } });
});
setTimeout(() => process.exit(0), 30000);
`;

let root = "";
let script = "";
let log = "";

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-probe-test-"));
  script = path.join(root, "fake-acp.cjs");
  log = path.join(root, "methods.log");
  fs.writeFileSync(script, FAKE, "utf-8");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function readLog(): string {
  try {
    return fs.readFileSync(log, "utf-8");
  } catch {
    return "";
  }
}

function opts(mode = "ok"): AgentProbeOptions {
  fs.rmSync(log, { force: true });
  return {
    bin: process.execPath,
    args: [script, mode] as string[],
    timeoutMs: 5000,
    testMcp: false,
    onLog: () => {},
  };
}

describe("probeAgent", () => {
  it("默认只做握手与恢复，不发真实 prompt", async () => {
    process.env.FAKE_PROBE_LOG = log;
    try {
      const r = await probeAgent(opts("ok"));
      expect(r.ok).toBe(true);
      expect(r.sessionId).toBe("probe-session");
      expect(r.restore.used).toBe("load");
      expect(r.deep).toBeUndefined();
      expect(readLog()).not.toContain("session/prompt");
    } finally {
      delete process.env.FAKE_PROBE_LOG;
    }
  });

  it("--deep 发真实 prompt 并验证恢复后的上下文", async () => {
    process.env.FAKE_PROBE_LOG = log;
    try {
      const r = await probeAgent({ ...opts("ok"), deep: true });
      expect(r.ok).toBe(true);
      expect(r.deep?.prompt1?.answer).toBe("STORED");
      expect(r.deep?.prompt2?.answer).toBe("PINEAPPLE");
      expect(r.deep?.contextKept).toBe(true);
      const text = readLog();
      expect(text.match(/session\/prompt/g)?.length).toBe(2);
    } finally {
      delete process.env.FAKE_PROBE_LOG;
    }
  });

  it("非空 mcpServers 被拒绝时回退空会话，并写进草稿", async () => {
    const r = await probeAgent({ ...opts("reject-mcp"), testMcp: true });
    expect(r.sessionId).toBe("probe-session");
    expect(r.mcpServers.accepted).toBe(false);
    const draft = draftFromProbe(r, { name: "probe-agent" });
    expect(draft.acpMcpServers).toBe(false);
    expect(draft.mcpDelivery).toBe("config");
    expect(validateAgentDefinition(draft).ok).toBe(true);
  });

  it("恢复失败不伪造 restore，草稿仍可校验", async () => {
    const r = await probeAgent(opts("no-restore"));
    expect(r.ok).toBe(true);
    expect(r.restore.used).toBeUndefined();
    const draft = draftFromProbe(r, { name: "probe-agent" });
    expect(draft.restore).toBeUndefined();
    expect((draft.notes ?? []).join("\n")).toContain("实际恢复未成功");
    expect(validateAgentDefinition(draft).ok).toBe(true);
  });

  it("草稿写出探针时间与 agent 版本", async () => {
    const r = await probeAgent(opts("ok"));
    const draft = draftFromProbe(r, { name: "probe-agent" });
    expect(draft.probe?.at).toBe(r.at);
    expect(draft.probe?.agentVersion).toBe("9.9.9");
    expect((draft.notes ?? []).join("\n")).toContain("realHome");
  });

  it("恢复后有历史回放时草稿自动写 replayOnLoad", async () => {
    const r = await probeAgent({ ...opts("replay"), deep: true });
    expect(r.restore.replayFrames).toBeGreaterThan(0);
    const draft = draftFromProbe(r, { name: "probe-agent" });
    expect(draft.replayOnLoad).toBe(true);
    expect((draft.notes ?? []).join("\n")).toContain("历史回放");
    expect(validateAgentDefinition(draft).ok).toBe(true);
  });

  it("可执行文件不存在时立即失败，不等请求超时", async () => {
    const started = Date.now();
    const r = await probeAgent({
      bin: path.join(root, "missing-agent.exe"),
      args: [],
      timeoutMs: 5000,
      testMcp: false,
    });
    expect(r.ok).toBe(false);
    expect(r.fatal).toContain("进程启动或运行失败");
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
