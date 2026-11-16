import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

const { spawnAgent } = vi.hoisted(() => ({ spawnAgent: vi.fn() }));
vi.mock("../shared/process/spawn-agent.js", () => ({ spawnAgent }));

import { probeAgent } from "./agent-probe.js";

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
  readonly methods: string[] = [];

  constructor(private readonly fatal = false) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line) continue;
        const frame = JSON.parse(line) as { id?: number; method?: string };
        if (frame.id === undefined || !frame.method) continue;
        this.methods.push(frame.method);
        if (frame.method === "initialize" && this.fatal) {
          this.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: frame.id,
              error: { code: -32603, message: "initialize failed" },
            }) + "\n",
          );
          continue;
        }
        const result =
          frame.method === "initialize"
            ? { protocolVersion: 1, agentCapabilities: {} }
            : frame.method === "session/new"
              ? { sessionId: "probe-session" }
              : {};
        this.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\n");
      }
    });
  }
}

function fakeAgent(fatal = false): FakeAcpProcess {
  const proc = new FakeAcpProcess(fatal);
  spawnAgent.mockReturnValueOnce(proc);
  return proc;
}

function expectDisposed(proc: FakeAcpProcess): void {
  expect(proc.killed).toBe(true);
  expect(proc.stdin.destroyed).toBe(true);
  expect(proc.stdout.destroyed).toBe(true);
  expect(proc.stderr.destroyed).toBe(true);
  expect(proc.unref).toHaveBeenCalledOnce();
}

describe("probeAgent 进程清理", () => {
  it("成功路径杀掉两个 ACP 进程，并关闭三路管道、unref", async () => {
    const first = fakeAgent();
    const second = fakeAgent();

    const result = await probeAgent({
      bin: process.execPath,
      args: [],
      testMcp: false,
      timeoutMs: 2000,
    });

    expect(result.ok, result.fatal).toBe(true);
    expect(first.methods).toContain("session/close");
    expectDisposed(first);
    expectDisposed(second);
  });

  it("fatal 路径也清理已经启动的进程", async () => {
    const first = fakeAgent(true);

    const result = await probeAgent({
      bin: process.execPath,
      args: [],
      testMcp: false,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    expect(result.fatal).toContain("initialize failed");
    expectDisposed(first);
  });

  it("--hard-kill 跳过 session/close，但仍清理两个进程", async () => {
    const first = fakeAgent();
    const second = fakeAgent();

    const result = await probeAgent({
      bin: process.execPath,
      args: [],
      testMcp: false,
      timeoutMs: 2000,
      hardKill: true,
    });

    expect(result.ok, result.fatal).toBe(true);
    expect(first.methods).not.toContain("session/close");
    expectDisposed(first);
    expectDisposed(second);
  });
});
