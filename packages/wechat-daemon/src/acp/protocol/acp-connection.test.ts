import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedAgent } from "../../agents/brain-agents.js";
import {
  applyAcpModel,
  applyAcpSessionMode,
  availableAcpModes,
  beginAcpTurn,
  drainAcpReplay,
  feedAcpStdout,
  handleAcpFrame,
  newTurnState,
  promptAcp,
  requestAcp,
  type AcpHost,
  type AcpPending,
} from "./acp-connection.js";
import { LineDecoder } from "../../shared/io/line-decoder.js";

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

  it("思考帧每回合只报一次 thinking；工具 purpose/detail 从 rawInput 提取", () => {
    const { host, turn } = fakeHost();
    const events: Array<{ type: string; purpose?: string; detail?: string }> = [];
    beginAcpTurn(turn, "s1", (ev) => events.push(ev));
    const thought = {
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "想" },
        },
      },
    };
    handleAcpFrame(thought, host);
    handleAcpFrame(thought, host);
    expect(events.filter((e) => e.type === "thinking")).toHaveLength(1);

    handleAcpFrame(
      {
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "t2",
            title: "bash",
            kind: "execute",
            rawInput: { __tool_use_purpose: "跑测试" },
          },
        },
      },
      host,
    );
    expect(events.find((e) => e.type === "tool")?.purpose).toBe("跑测试");

    handleAcpFrame(
      {
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "t3",
            title: "bash",
            kind: "execute",
            rawInput: { command: "npm test\n--watch" },
          },
        },
      },
      host,
    );
    expect(events.filter((e) => e.type === "tool").at(-1)?.detail).toBe("npm test --watch");
  });

  it("工具进度：首帧 start、终态 end；重复终态不重复发", () => {
    const { host, turn } = fakeHost();
    const tools: Array<{ phase?: string; toolCallId?: string; status?: string }> = [];
    beginAcpTurn(turn, "s1", (ev) => {
      if (ev.type === "tool") tools.push(ev);
    });
    const frame = (update: Record<string, unknown>) =>
      handleAcpFrame({ method: "session/update", params: { sessionId: "s1", update } }, host);

    frame({ sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", kind: "execute" });
    expect(tools).toEqual([expect.objectContaining({ phase: "start", toolCallId: "t1" })]);

    frame({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" });
    expect(tools).toHaveLength(1);

    frame({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    frame({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    expect(tools).toEqual([
      expect.objectContaining({ phase: "start", toolCallId: "t1" }),
      expect.objectContaining({ phase: "end", toolCallId: "t1", status: "completed" }),
    ]);
    expect(turn.endedTools.has("t1")).toBe(true);
  });

  it("首帧就是终态时补一个 end；没有 toolCallId 时用 title 兜底", () => {
    const { host, turn } = fakeHost();
    const tools: Array<{ phase?: string; toolCallId?: string; status?: string }> = [];
    beginAcpTurn(turn, "s1", (ev) => {
      if (ev.type === "tool") tools.push(ev);
    });
    handleAcpFrame(
      {
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "tool_call",
            title: "read file",
            kind: "read",
            status: "failed",
          },
        },
      },
      host,
    );
    expect(tools.map((t) => t.phase)).toEqual(["start", "end"]);
    expect(tools.every((t) => t.toolCallId === "read file")).toBe(true);
    expect(tools[1]?.status).toBe("failed");
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

  it("持续出帧但超过硬上限 → cap（idle 不触发时唯一的止损）", async () => {
    vi.useFakeTimers();
    const { host, pending } = fakeHost();
    const p = promptAcp(
      host,
      { sessionId: "s", prompt: [] },
      {
        idleMs: 20_000,
        capMs: 10_000,
        firstFrameMs: 5_000,
      },
    );
    const assertion = expect(p).rejects.toThrow("cap timeout");
    await vi.advanceTimersByTimeAsync(6_000);
    handleAcpFrame({ method: "session/update", params: { sessionId: "s", update: {} } }, host);
    handleAcpFrame({ method: "session/update", params: { sessionId: "s", update: {} } }, host);
    await vi.advanceTimersByTimeAsync(11_000); // 17s：idle 只有 11s，但 total 已过 cap
    await assertion;
    expect(pending.size).toBe(0);
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

  it("applyAcpSessionMode：成功路径发出 set_mode；没配 sessionMode 时完全不写帧", async () => {
    const { host, written, logs } = fakeHost();
    const p = applyAcpSessionMode(host, fakeAgent({ sessionMode: "bypass" }), "s1", null, 1000);
    expect(written[0]).toMatchObject({
      method: "session/set_mode",
      params: { sessionId: "s1", modeId: "bypass" },
    });
    handleAcpFrame({ id: 1, result: {} }, host);
    await p;
    expect(logs.some((l) => l.includes("session mode set bypass"))).toBe(true);

    const second = fakeHost();
    await applyAcpSessionMode(second.host, fakeAgent(), "s1", null, 1000);
    expect(second.written).toEqual([]);
  });
});

describe("drainAcpReplay（load 后等历史回放安静）", () => {
  it("replayOnLoad=false 立即返回；true 时计数排空的帧", async () => {
    const off = fakeHost();
    await drainAcpReplay(off.host, fakeAgent());
    expect(off.logs).toEqual([]);

    vi.useFakeTimers();
    const { host, state, logs } = fakeHost();
    const p = drainAcpReplay(host, fakeAgent({ replayOnLoad: true }));
    setTimeout(() => {
      state.frameSeq += 1; // 回放帧到达
    }, 100);
    await vi.advanceTimersByTimeAsync(700);
    await p;
    expect(logs.some((l) => l.includes("drained 1 replay frame(s)"))).toBe(true);
  });

  it("帧一直不停 → 到封顶后返回并标 (cap)", async () => {
    vi.useFakeTimers();
    const { host, state, logs } = fakeHost();
    const iv = setInterval(() => {
      state.frameSeq += 1;
    }, 100);
    const p = drainAcpReplay(host, fakeAgent({ replayOnLoad: true }));
    await vi.advanceTimersByTimeAsync(3200);
    clearInterval(iv);
    await p;
    expect(logs.some((l) => l.includes("(cap)"))).toBe(true);
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
