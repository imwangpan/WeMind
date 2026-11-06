import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkAgent } from "./brain-check.js";
import { resolveAgent } from "../agents/brain-agents.js";

/*
 * 用假 ACP 进程验「握手成功」的判据：只回 initialize + session/new，不依赖任何真实 agent。
 * 重点覆盖失败路径——session/new 不回 sessionId 时，自检必须报失败（以前照样报 ✅，daemon 第一条消息才炸）。
 */
const FAKE_ACP = `
const readline = require("node:readline");
const mode = process.argv[2] || "";
const withId = mode === "with-id" || mode === "reverse";
const rl = readline.createInterface({ input: process.stdin });
function send(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
}
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }

  // 客户端对我们反向请求的应答（有 id、没有 method）
  if (m.id !== undefined && m.method === undefined) {
    if (mode === "reverse" && m.id === 100) {
      if (m.result?.outcome?.outcome !== "cancelled") {
        send({ id: 1, error: { code: -32603, message: "permission was not rejected" } });
      } else {
        send({ id: 1, result: { protocolVersion: 1, agentCapabilities: {} } });
      }
    }
    return;
  }
  if (m.id === undefined) return;

  if (m.method === "initialize" && mode === "reverse") {
    // 先发权限请求，等客户端应答后才回 initialize —— 不应答会挂到 checkAgent 超时
    send({ id: 100, method: "session/request_permission", params: { options: [{ kind: "reject_once", optionId: "no" }] } });
    return;
  }
  if (m.method === "initialize" && mode === "exit") process.exit(1);
  if (m.method === "initialize" && mode === "silent") return; // 永不回应 → 客户端超时

  let result;
  if (m.method === "initialize") result = { protocolVersion: 1, agentCapabilities: {} };
  else if (m.method === "session/new") result = withId ? { sessionId: "fake-session" } : {};
  else {
    send({ id: m.id, error: { code: -32601, message: "no" } });
    return;
  }
  send({ id: m.id, result });
});
setTimeout(() => process.exit(0), 30000);
`;

function fakeAgent(script: string, mode: "" | "with-id" | "reverse" | "exit" | "silent") {
  const base = resolveAgent({ agent: "kiro" });
  return {
    ...base,
    name: "fake",
    bin: process.execPath,
    args: [script, ...(mode ? [mode] : [])],
    shell: false,
    available: true,
    binPath: process.execPath,
    requiresBins: [],
  };
}

describe("checkAgent（真 ACP 握手自检）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-check-"));
  const script = path.join(dir, "fake-acp.cjs");
  fs.writeFileSync(script, FAKE_ACP, "utf-8");

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("session/new 没有 sessionId → 失败（不再报 ✅）", async () => {
    const r = await checkAgent(fakeAgent(script, ""), 5000);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("sessionId");
  }, 15_000);

  it("完整握手 → 成功，detail 带真实 sessionId", async () => {
    const r = await checkAgent(fakeAgent(script, "with-id"), 5000);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("sessionId=fake-session");
  }, 15_000);

  it("握手期间收到权限请求 → 默认拒绝并继续，不挂到超时", async () => {
    const r = await checkAgent(fakeAgent(script, "reverse"), 5000);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("sessionId=fake-session");
  }, 15_000);

  it("进程在握手期间退出 → 失败并给出退出码，不挂到超时", async () => {
    const r = await checkAgent(fakeAgent(script, "exit"), 5000);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("进程已退出");
  }, 15_000);

  it("agent 不回 initialize → 超时失败，pending 被清理", async () => {
    const r = await checkAgent(fakeAgent(script, "silent"), 500);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("超时");
  }, 15_000);
});
