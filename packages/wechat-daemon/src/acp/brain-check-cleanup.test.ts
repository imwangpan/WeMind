import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

const { spawnAgent } = vi.hoisted(() => ({ spawnAgent: vi.fn() }));
vi.mock("../shared/process/spawn-agent.js", () => ({ spawnAgent }));

import { checkAgent } from "./brain-check.js";
import { resolveAgent } from "../agents/brain-agents.js";

class FakeAcpProcess extends EventEmitter {
  pid = undefined;
  killed = false;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  unref = vi.fn();
  kill = vi.fn(() => {
    this.killed = true;
    this.emit("exit", 0);
    return true;
  });

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line) continue;
        const frame = JSON.parse(line) as { id?: number; method?: string };
        if (frame.id === undefined) continue;
        const result =
          frame.method === "initialize"
            ? { protocolVersion: 1, agentCapabilities: {} }
            : { sessionId: "fake-session" };
        this.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\n");
      }
    });
  }
}

function fakeAgent() {
  const base = resolveAgent({ agent: "kiro" });
  return {
    ...base,
    name: "fake",
    bin: process.execPath,
    args: [],
    shell: false,
    available: true,
    binPath: process.execPath,
    requiresBins: [],
  };
}

describe("checkAgent 进程清理", () => {
  it("自检结束后杀掉子进程、关闭管道并 unref，避免 CLI 常驻", async () => {
    const proc = new FakeAcpProcess();
    spawnAgent.mockReturnValueOnce(proc);

    const result = await checkAgent(fakeAgent(), 5000);

    expect(result.ok).toBe(true);
    expect(proc.killed).toBe(true);
    expect(proc.stdin.destroyed).toBe(true);
    expect(proc.stdout.destroyed).toBe(true);
    expect(proc.stderr.destroyed).toBe(true);
    expect(proc.unref).toHaveBeenCalledOnce();
  });
});
