import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { validateAgentDefinition } from "../agents/agent-definition.js";
import {
  draftFromProbe,
  probeAgent,
  probeUsesShell,
  type AgentProbeOptions,
} from "./agent-probe.js";

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
    if (
      mode === "no-restore" ||
      (mode === "no-load" && m.method === "session/load")
    ) send({ id: m.id, error: { code: -32602, message: "session not found" } });
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
    if (mode === "image-fail" && (m.params.prompt || []).some((p) => p.type === "image")) {
      send({ id: m.id, error: { code: -32603, message: "image prompt rejected" } });
      return;
    }
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
  it(".cmd/.bat 在 Windows 自动经 shell，显式值优先", () => {
    expect(probeUsesShell("pi-acp.cmd", undefined, "win32")).toBe(true);
    expect(probeUsesShell("C:\\tools\\agent.BAT", undefined, "win32")).toBe(true);
    expect(probeUsesShell("pi-acp.exe", undefined, "win32")).toBe(false);
    expect(probeUsesShell("pi-acp.cmd", false, "win32")).toBe(false);
    expect(probeUsesShell("pi-acp.cmd", true, "linux")).toBe(true);
    expect(probeUsesShell("pi-acp.cmd", undefined, "linux")).toBe(false);
  });

  it.skipIf(process.platform !== "win32")(
    "未显式 --shell 也能探测 .cmd 适配器",
    async () => {
      const wrapper = path.join(root, "fake-acp.cmd");
      fs.writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf-8");
      const r = await probeAgent({
        bin: wrapper,
        args: ["ok"],
        timeoutMs: 15_000,
        testMcp: false,
      });
      expect(r.shell).toBe(true);
      expect(r.ok).toBe(true);
      expect(r.sessionId).toBe("probe-session");
    },
    20_000,
  );

  it.skipIf(process.platform !== "win32")(
    "裸名探针按 PATH + PATHEXT 找到 .cmd 适配器",
    async () => {
      const wrapper = path.join(root, "fake-bare-acp.cmd");
      fs.writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf-8");
      const oldPath = process.env.PATH;
      process.env.PATH = `${root};${oldPath ?? ""}`;
      try {
        const r = await probeAgent({
          bin: "fake-bare-acp",
          args: ["ok"],
          timeoutMs: 15_000,
          testMcp: false,
        });
        expect(r.shell).toBe(true);
        expect(r.ok, r.fatal).toBe(true);
        expect(r.sessionId).toBe("probe-session");
      } finally {
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
      }
    },
    20_000,
  );

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
    process.env.FAKE_PROBE_LOG = log;
    try {
      const r = await probeAgent({ ...opts("reject-mcp"), testMcp: true });
      expect(r.sessionId).toBe("probe-session");
      expect(r.mcpServers.accepted).toBe(false);
      expect(r.restore.used).toBe("load");
      const loadLine = readLog()
        .split(/\r?\n/)
        .find((line) => line.startsWith("session/load "));
      const loadParams = JSON.parse(loadLine!.slice("session/load ".length));
      expect(loadParams.mcpServers).toEqual([]);
      const draft = draftFromProbe(r, { name: "probe-agent" });
      expect(draft.acpMcpServers).toBe(false);
      expect(draft.mcpDelivery).toBe("config");
      expect(validateAgentDefinition(draft).ok).toBe(true);
    } finally {
      delete process.env.FAKE_PROBE_LOG;
    }
  });

  it("--mcp [] 不把 MCP 误报为已测试；显式条目会补 ACP env 数组", async () => {
    const empty = await probeAgent({ ...opts("ok"), mcpServers: [] });
    expect(empty.mcpServers.tested).toBe(false);

    process.env.FAKE_PROBE_LOG = log;
    try {
      const custom = await probeAgent({
        ...opts("ok"),
        mcpServers: [{ name: "custom", command: "node", env: { TOKEN: 1 } }],
      });
      expect(custom.mcpServers.tested).toBe(true);
      const newLine = readLog()
        .split(/\r?\n/)
        .find((line) => line.startsWith("session/new "));
      const params = JSON.parse(newLine!.slice("session/new ".length));
      expect(params.mcpServers[0].env).toEqual([{ name: "TOKEN", value: "1" }]);
    } finally {
      delete process.env.FAKE_PROBE_LOG;
    }
  });

  it("load / resume 复用 session/new 时实际传入的 mcpServers", async () => {
    process.env.FAKE_PROBE_LOG = log;
    try {
      const loadResult = await probeAgent({ ...opts("ok"), testMcp: true });
      expect(loadResult.restore.used).toBe("load");
      const loadLine = readLog()
        .split(/\r?\n/)
        .find((line) => line.startsWith("session/load "));
      expect(loadLine).toBeTruthy();
      const loadParams = JSON.parse(loadLine!.slice("session/load ".length));
      expect(loadParams.mcpServers).toEqual([
        expect.objectContaining({
          name: "wemind_probe",
          command: process.execPath,
          env: [],
        }),
      ]);

      const resumeResult = await probeAgent({ ...opts("no-load"), testMcp: true });
      expect(resumeResult.restore.used).toBe("resume");
      const resumeLine = readLog()
        .split(/\r?\n/)
        .find((line) => line.startsWith("session/resume "));
      expect(resumeLine).toBeTruthy();
      const resumeParams = JSON.parse(resumeLine!.slice("session/resume ".length));
      expect(resumeParams.mcpServers).toEqual([
        expect.objectContaining({ name: "wemind_probe", command: process.execPath }),
      ]);
    } finally {
      delete process.env.FAKE_PROBE_LOG;
    }
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

  it("--deep 的恢复、工具与图片任一失败都不能假绿", async () => {
    const noRestore = await probeAgent({ ...opts("no-restore"), deep: true });
    expect(noRestore.restore.used).toBeUndefined();
    expect(noRestore.ok).toBe(false);

    const toolFailed = await probeAgent({ ...opts("ok"), deep: true, tool: true });
    expect(toolFailed.deep?.tool?.fileWritten).toBe(false);
    expect(toolFailed.deep?.tool?.ok).toBe(false);
    expect(toolFailed.ok).toBe(false);

    const imageFailed = await probeAgent({
      ...opts("image-fail"),
      deep: true,
      image: true,
    });
    expect(imageFailed.deep?.image?.ok).toBe(false);
    expect(imageFailed.deep?.contextKept).toBe(true);
    expect(imageFailed.ok).toBe(false);
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
