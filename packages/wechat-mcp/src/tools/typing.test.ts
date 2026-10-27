import { describe, it, expect, vi, beforeEach } from "vitest";

// mock core：typing 只依赖协议/存储函数（getConfig + sendTyping 是重点验证对象）
const m = vi.hoisted(() => ({
  loadAccount: vi.fn(),
  loadState: vi.fn(),
  isSessionPaused: vi.fn(),
  getConfig: vi.fn(),
  sendTyping: vi.fn(() => Promise.resolve()),
  getRemainingPauseMs: vi.fn(() => 60_000),
}));
vi.mock("@wemind/wechat-ilink-core", async (importOriginal) => ({
  ...m,
  // ILinkError 是纯类（无副作用），用真实实现，避免测试里再造一个假的错误类型
  ILinkError: (await importOriginal<typeof import("@wemind/wechat-ilink-core")>()).ILinkError,
  SESSION_EXPIRED_ERRCODE: -14,
  TypingStatus: { TYPING: 1, CANCEL: 2 },
}));

import { ILinkError } from "@wemind/wechat-ilink-core";

import { sendTypingIndicator } from "./typing.js";

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
  m.getConfig.mockResolvedValue({ ret: 0, typing_ticket: "ticket" });
});

describe("sendTypingIndicator 前置校验", () => {
  it("未登录 → 抛错并指路 login_qrcode", async () => {
    m.loadAccount.mockReturnValue(null);
    await expect(sendTypingIndicator({ to: "u1" })).rejects.toThrow(/Not logged in/);
    expect(m.sendTyping).not.toHaveBeenCalled();
  });

  it("会话冷却中 → 返回 session_expired，不打接口", async () => {
    m.isSessionPaused.mockReturnValue(true);
    const r = await sendTypingIndicator({ to: "u1" });

    expect(parse(r).status).toBe("session_expired");
    expect(m.getConfig).not.toHaveBeenCalled();
    expect(m.sendTyping).not.toHaveBeenCalled();
  });

  it("没有该用户的 context_token → 抛错，不打接口", async () => {
    await expect(sendTypingIndicator({ to: "stranger" })).rejects.toThrow(
      /No conversation found with user stranger/,
    );
    expect(m.getConfig).not.toHaveBeenCalled();
  });

  it("只按 (botId, to) 取 token——别的用户/别的 bot 的 token 不能串用", async () => {
    m.loadState.mockReturnValue({
      updatesBuf: "",
      contextTokens: { "bot2:u1": "other-bot", "bot1:u2": "other-user" },
      lastMessageId: 0,
    });
    await expect(sendTypingIndicator({ to: "u1" })).rejects.toThrow(/No conversation found/);
  });
});

describe("sendTypingIndicator 取 ticket", () => {
  it("getConfig 使用的是该用户的 context_token", async () => {
    await sendTypingIndicator({ to: "u1" });
    expect(m.getConfig).toHaveBeenCalledWith({
      baseUrl: "https://x",
      token: "tok",
      ilinkUserId: "u1",
      contextToken: "ctx-1",
    });
  });

  it("拿不到 typing_ticket → 抛错且不发 sendTyping（不带空 ticket 硬发）", async () => {
    m.getConfig.mockResolvedValue({ ret: 0 });
    await expect(sendTypingIndicator({ to: "u1" })).rejects.toThrow(/no typing_ticket/);
    expect(m.sendTyping).not.toHaveBeenCalled();
  });

  it("errmsg 会带进错误信息，便于排查", async () => {
    // getConfig 现在对非 0 ret 直接抛 ILinkError（core 层统一校验），errmsg 已在错误消息里
    m.getConfig.mockRejectedValue(new ILinkError("getConfig", -2, "context token invalid"));
    await expect(sendTypingIndicator({ to: "u1" })).rejects.toThrow(/context token invalid/);
    expect(m.sendTyping).not.toHaveBeenCalled();
  });
});

describe("sendTypingIndicator 发送", () => {
  it("默认显示 typing（status=1）", async () => {
    const r = await sendTypingIndicator({ to: "u1" });

    expect(m.sendTyping).toHaveBeenCalledWith({
      baseUrl: "https://x",
      token: "tok",
      body: { ilink_user_id: "u1", typing_ticket: "ticket", status: 1 },
    });
    expect(parse(r)).toMatchObject({ status: "typing", to: "u1" });
  });

  it("status=cancel → 发 2 并回报 typing_cancelled", async () => {
    const r = await sendTypingIndicator({ to: "u1", status: "cancel" });

    type SentTyping = { body: { status: number } };
    const calls = m.sendTyping.mock.calls as unknown as SentTyping[][];
    expect(calls[0][0].body.status).toBe(2);
    expect(parse(r)).toMatchObject({ status: "typing_cancelled", to: "u1" });
  });
});
