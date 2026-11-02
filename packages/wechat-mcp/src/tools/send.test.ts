import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  loadAccount: vi.fn(),
  loadState: vi.fn(),
  isSessionPaused: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock("@wemind/wechat-ilink-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wemind/wechat-ilink-core")>();
  return {
    ...actual,
    loadAccount: m.loadAccount,
    loadState: m.loadState,
    isSessionPaused: m.isSessionPaused,
    sendMessage: m.sendMessage,
  };
});

import { ILinkError } from "@wemind/wechat-ilink-core";

import { sendTextMessage } from "./send.js";

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

beforeEach(() => {
  vi.clearAllMocks();
  m.loadAccount.mockReturnValue({
    botToken: "tok",
    botId: "bot1",
    userId: "owner",
    baseUrl: "https://x",
    savedAt: 1,
  });
  m.loadState.mockReturnValue({
    updatesBuf: "",
    contextTokens: { "bot1:u1": "ctx-1" },
    lastMessageId: 0,
  });
  m.isSessionPaused.mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sendTextMessage", () => {
  it("没有会话记录 → 拒绝（iLink 不能主动发起对话）", async () => {
    await expect(sendTextMessage({ to: "nobody", text: "hi" })).rejects.toThrow(/没有会话记录/);
    expect(m.sendMessage).not.toHaveBeenCalled();
  });

  it("正常发送 → sent，且带上该用户的 context_token", async () => {
    m.sendMessage.mockResolvedValue(undefined);
    const r = await sendTextMessage({ to: "u1", text: "hi" });
    expect(parse(r).status).toBe("sent");
    expect(m.sendMessage).toHaveBeenCalledTimes(1);
    const req = m.sendMessage.mock.calls[0][0];
    expect(req.body.msg.context_token).toBe("ctx-1");
  });

  it("ret=-2 → 退避重试一次；仍失败则给出可操作错误，不谎称已发送", async () => {
    vi.useFakeTimers();
    m.sendMessage
      .mockRejectedValueOnce(new ILinkError("sendMessage", -2, "rate limited"))
      .mockRejectedValueOnce(new ILinkError("sendMessage", -2, "rate limited"));
    const p = expect(sendTextMessage({ to: "u1", text: "hi" })).rejects.toThrow(
      /发送被服务端拒绝（ret=-2/,
    );
    await vi.advanceTimersByTimeAsync(1600);
    await p;
    expect(m.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("ret=-2 一次后成功 → 不报错（限流靠退避恢复）", async () => {
    vi.useFakeTimers();
    m.sendMessage
      .mockRejectedValueOnce(new ILinkError("sendMessage", -2, "rate limited"))
      .mockResolvedValueOnce(undefined);
    const p = expect(sendTextMessage({ to: "u1", text: "hi" })).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(1600);
    await p;
    expect(m.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("非 -2 错误直接抛出（鉴权/传输问题不重试）", async () => {
    m.sendMessage.mockRejectedValue(new ILinkError("sendMessage", -1, "bad"));
    await expect(sendTextMessage({ to: "u1", text: "hi" })).rejects.toThrow(/bad/);
    expect(m.sendMessage).toHaveBeenCalledTimes(1);
  });
});
