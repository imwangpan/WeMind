import { describe, it, expect, vi, beforeEach } from "vitest";

// mock core：getMessages 依赖的协议/存储函数全部桩化
const m = vi.hoisted(() => ({
  loadAccount: vi.fn(),
  isSessionPaused: vi.fn(),
  loadState: vi.fn(),
  saveState: vi.fn(),
  getUpdates: vi.fn(),
  pauseSession: vi.fn(),
  getRemainingPauseMs: vi.fn(() => 60_000),
  classifyTransportError: vi.fn(),
}));
vi.mock("@wemind/wechat-ilink-core", () => ({
  ...m,
  SESSION_EXPIRED_ERRCODE: -14,
}));

import { getMessages } from "./messages.js";

beforeEach(() => {
  vi.clearAllMocks();
  m.loadAccount.mockReturnValue({
    botToken: "t",
    botId: "bot1",
    baseUrl: "https://x",
    userId: "u",
  });
  m.isSessionPaused.mockReturnValue(false);
  m.loadState.mockReturnValue({ updatesBuf: "", contextTokens: {}, lastMessageId: 0 });
});

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe("getMessages", () => {
  it("未登录 → 抛 McpError", async () => {
    m.loadAccount.mockReturnValue(null);
    await expect(getMessages({})).rejects.toThrow(/Not logged in/);
  });

  it("会话暂停 → 直接返回 session_expired，不轮询", async () => {
    m.isSessionPaused.mockReturnValue(true);
    const r = await getMessages({});
    expect(parse(r).status).toBe("session_expired");
    expect(m.getUpdates).not.toHaveBeenCalled();
  });

  it("取消信号已 abort → 立即返回 cancelled，不轮询（防孤儿长轮询）", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await getMessages({ wait: true }, ac.signal);
    expect(parse(r).cancelled).toBe(true);
    expect(m.getUpdates).not.toHaveBeenCalled();
  });

  it("收到新消息 → 返回消息并推进游标", async () => {
    m.getUpdates.mockResolvedValue({
      ret: 0,
      msgs: [
        {
          message_type: 1,
          message_id: 5,
          from_user_id: "u1",
          context_token: "ct",
          item_list: [{ type: 1, text_item: { text: "hi" } }],
        },
      ],
      get_updates_buf: "buf2",
    });
    const r = await getMessages({});
    const j = parse(r);
    expect(j.message_count).toBe(1);
    expect(j.messages[0].text).toBe("hi");
    expect(m.saveState).toHaveBeenCalled();
  });

  it("errcode -14 → pauseSession + session_expired", async () => {
    m.getUpdates.mockResolvedValue({ errcode: -14 });
    const r = await getMessages({});
    expect(parse(r).status).toBe("session_expired");
    expect(m.pauseSession).toHaveBeenCalledWith("bot1");
  });

  it("非 wait 无新消息 → message_count 0", async () => {
    m.getUpdates.mockResolvedValue({ ret: 0, msgs: [], get_updates_buf: "b" });
    const r = await getMessages({ wait: false });
    expect(parse(r).message_count).toBe(0);
  });
});
