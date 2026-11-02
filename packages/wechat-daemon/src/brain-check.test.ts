import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkAgent } from "./brain-check.js";
import { resolveAgent } from "./brain-agents.js";

/*
 * 用假 ACP 进程验「握手成功」的判据：只回 initialize + session/new，不依赖任何真实 agent。
 * 重点覆盖失败路径——session/new 不回 sessionId 时，自检必须报失败（以前照样报 ✅，daemon 第一条消息才炸）。
 */
const FAKE_ACP = `
const readline = require("node:readline");
const withId = process.argv[2] === "with-id";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  let result;
  if (m.method === "initialize") result = { protocolVersion: 1, agentCapabilities: {} };
  else if (m.method === "session/new") result = withId ? { sessionId: "fake-session" } : {};
  else {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});
setTimeout(() => process.exit(0), 30000);
`;

function fakeAgent(script: string, withId: boolean) {
  const base = resolveAgent({ agent: "kiro" });
  return {
    ...base,
    name: "fake",
    bin: process.execPath,
    args: [script, ...(withId ? ["with-id"] : [])],
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
    const r = await checkAgent(fakeAgent(script, false), 5000);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("sessionId");
  }, 15_000);

  it("完整握手 → 成功，detail 带真实 sessionId", async () => {
    const r = await checkAgent(fakeAgent(script, true), 5000);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("sessionId=fake-session");
  }, 15_000);
});
