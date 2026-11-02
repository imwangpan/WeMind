import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedAgent } from "./brain-agents.js";
import {
  applyAcpModel,
  applyAcpSessionMode,
  availableAcpModes,
  beginAcpTurn,
  feedAcpStdout,
  handleAcpFrame,
  newTurnState,
  promptAcp,
  requestAcp,
  type AcpHost,
  type AcpPending,
} from "./acp-connection.js";
import { LineDecoder } from "./line-decoder.js";

function fakeAgent(overrides: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return { name: "fake", ...overrides } as ResolvedAgent;
}

function fakeHost(overrides: Partial<AcpHost> = {}) {
  const pending = new Map<number, AcpPending>();
  const turn = newTurnState();
  const state = { lastFrameAt: 0, frameSeq: 0 };
  const written: Record<string, any>[] = [];
  const logs: string[] = [];
  let id = 0;
  const host: AcpHost = {
    pending,
    turn,
    state,
    hasProcess: () => true,
    noProcessMessage: "no acp process",
    nextId: () => ++id,
    write: (payload) => written.push(payload),
    log: (message) => logs.push(message),
    ...overrides,
  };
  return { host, pending, turn, state, written, logs };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("handleAcpFrame（响应 / 反向请求 / session/update）", () => {
  it("按 id 兑现普通响应，未知 id 静默忽略", () => {
    const { host, pending } = fakeHost();
    let got: unknown;
    pending.set(7, {
      resolve: (v) => {
        got = v;
      },
      reject: () => {
        throw new Error("不该 reject");
      },
      clear: () => {},
      method: "session/new",
    });
    handleAcpFrame({ id: 7, result: { sessionId: "s1" } }, host);
    handleAcpFrame({ id: 99, result: { ignored: true } }, host);
    expect(got).toEqual({ sessionId: "s1" });
    expect(pending.has(7)).toBe(false);
    expect(host.state.frameSeq).toBe(2);
  });

  it("错误响应 → reject，错误详情进日志", () => {
    const { host, pending, logs } = fakeHost();
    let err: Error | undefined;
    pending.set(3, {
      resolve: () => {
        throw new Error("不该 resolve");
      },
      reject: (e) => {
        err = e;
      },
      clear: () => {},
      method: "session/load",
    });
    handleAcpFrame({ id: 3, error: { code: -32601, message: "no" } }, host);
    expect(err?.message).toContain("-32601");
    expect(logs.some((l) => l.includes("session/load#3 ERROR"))).toBe(true);
  });

  it("反向请求走共用应答器：权限默认拒绝、未知 method 回 -32601", () => {
    const { host, written } = fakeHost();
    handleAcpFrame(
      {
        id: 11,
        method: "session/request_permission",
        params: { options: [{ optionId: "a", kind: "allow_once" }] },
      },
      host,
    );
    expect(written[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 11,
      result: { outcome: { outcome: "cancelled" } },
    });
    handleAcpFrame({ id: 12, method: "fs/read_text_file", params: {} }, host);
    expect(written[1]).toMatchObject({ id: 12, error: { code: -32601 } });
  });

  it("session/update：文本拼接、进度事件只报一次、工具按 toolCallId 去重", () => {
    const { host, turn } = fakeHost();
    const events: string[] = [];
    beginAcpTurn(turn, "s1", (ev) => events.push(ev.type));
    handleAcpFrame(
      {
        method: "session/update",
        params: {
          sessionId: "s1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你" } },
        },
      },
      host,
    );
    handleAcpFrame(
      {
        method: "session/update",
        params: {
          sessionId: "s1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "好" } },
        },
      },
      host,
    );
    expect(turn.assembling.get("s1")?.join("")).toBe("你好");
    expect(events.filter((e) => e === "answer")).toHaveLength(1);
    expect(events.filter((e) => e === "activity")).toHaveLength(2);

    const tool = {
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "运行测试",
          kind: "execute",
        },
      },
    };
    handleAcpFrame(tool, host);
    handleAcpFrame(tool, host);
    expect(events.filter((e) => e === "tool")).toHaveLength(1);
    expect(turn.seenUpdateTypes.has("tool_call")).toBe(true);
  });
});

describe("requestAcp（写帧 / 超时）", () => {
  it("写出 JSON-RPC 帧；响应到达后兑现", async () => {
    const { host, written } = fakeHost();
    const p = requestAcp(host, "session/new", { cwd: "/x" }, 1000);
    expect(written[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "session/new" });
    handleAcpFrame({ id: 1, result: { sessionId: "s1" } }, host);
    await expect(p).resolves.toEqual({ sessionId: "s1" });
  });

  it("超时按方法名报错，并把 pending 清掉", async () => {
    vi.useFakeTimers();
    const { host, pending } = fakeHost();
    const p = requestAcp(host, "initialize", {}, 50);
    const assertion = expect(p).rejects.toThrow("initialize timeout after 50ms");
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    expect(pending.size).toBe(0);
  });

  it("没有进程时直接拒绝（不写帧）", async () => {
    const { host, written } = fakeHost({ hasProcess: () => false });
    await expect(requestAcp(host, "initialize", {}, 1000)).rejects.toThrow("no acp process");
    expect(written).toEqual([]);
  });
});

describe("promptAcp（首帧 / 空闲 / 硬上限）", () => {
  it("本回合从未出帧 → no-first-frame", async () => {
    vi.useFakeTimers();
    const { host } = fakeHost();
    const p = promptAcp(
      host,
      { sessionId: "s", prompt: [] },
      {
        idleMs: 20_000,
        capMs: 100_000,
        firstFrameMs: 10_000,
      },
    );
    const assertion = expect(p).rejects.toThrow("no-first-frame timeout");
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
  });

  it("出过帧后长时间静默 → idle（不是首帧超时）", async () => {
    vi.useFakeTimers();
    const { host } = fakeHost();
    const p = promptAcp(
      host,
      { sessionId: "s", prompt: [] },
      {
        idleMs: 10_000,
        capMs: 100_000,
        firstFrameMs: 5_000,
      },
    );
    const assertion = expect(p).rejects.toThrow("idle timeout");
    await vi.advanceTimersByTimeAsync(6_000);
    handleAcpFrame({ method: "session/update", params: { sessionId: "s", update: {} } }, host);
    await vi.advanceTimersByTimeAsync(16_000);
    await assertion;
  });
});

describe("模型与模式设置", () => {
  it("applyAcpModel：无 model / modelArg 时跳过；有 model 时发 set_config_option", async () => {
    const { host, written } = fakeHost();
    await applyAcpModel(host, fakeAgent(), "s1", 1000);
    await applyAcpModel(host, fakeAgent({ model: "m", modelArg: "--model" }), "s1", 1000);
    expect(written).toEqual([]);

    const p = applyAcpModel(host, fakeAgent({ model: "m" }), "s1", 1000);
    expect(written[0]).toMatchObject({
      method: "session/set_config_option",
      params: { sessionId: "s1", configId: "model", value: "m" },
    });
    handleAcpFrame({ id: 1, result: {} }, host);
    await p;
  });

  it("availableAcpModes：无 modes → null；有则取 id", () => {
    expect(availableAcpModes({})).toBeNull();
    expect(availableAcpModes({ modes: { availableModes: [{ id: "a" }, "b"] } })).toEqual([
      "a",
      "b",
    ]);
  });

  it("applyAcpSessionMode：可用列表不含目标 → 跳过；请求失败只记日志不抛", async () => {
    const { host, written, logs } = fakeHost();
    await applyAcpSessionMode(host, fakeAgent({ sessionMode: "bypass" }), "s1", ["ask"], 1000);
    expect(written).toEqual([]);
    expect(logs.some((l) => l.includes("跳过"))).toBe(true);

    const p = applyAcpSessionMode(host, fakeAgent({ sessionMode: "bypass" }), "s1", null, 1000);
    handleAcpFrame({ id: 1, error: { code: -32601, message: "no" } }, host);
    await expect(p).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("session mode set failed"))).toBe(true);
  });
});

describe("feedAcpStdout", () => {
  it("逐行解析 JSON，非 JSON 日志行与半截行都不抛", () => {
    const decoder = new LineDecoder();
    const frames: Record<string, any>[] = [];
    const onFrame = (f: Record<string, any>) => frames.push(f);
    feedAcpStdout(decoder, Buffer.from('not json\n{"id":1,"result":{}}'), onFrame);
    expect(frames).toEqual([]); // 第二行还没换行，留着与下一段拼
    feedAcpStdout(decoder, Buffer.from('\n{"id":2,"result":{}}\n'), onFrame);
    expect(frames).toEqual([
      { id: 1, result: {} },
      { id: 2, result: {} },
    ]);
  });
});
