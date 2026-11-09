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
  isAllowed: vi.fn(() => false),
}));
vi.mock("@wemind/wechat-ilink-core", () => ({
  ...m,
  SESSION_EXPIRED_ERRCODE: -14,
  // 枚举是纯数据，照抄真实取值（不桩成函数，避免测试与协议常量脱节）
  MessageType: { NONE: 0, USER: 1, BOT: 2 },
  // ID 比较/取最大值：测试里的 fixture 仍用 number，所以按字符串再转 BigInt。
  compareMessageIds: (a: string | number, b: string | number) => {
    const x = BigInt(String(a));
    const y = BigInt(String(b));
    return x < y ? -1 : x > y ? 1 : 0;
  },
  maxMessageId: (a: string | number, b: string | number) =>
    BigInt(String(a)) >= BigInt(String(b)) ? String(a) : String(b),
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
  m.isAllowed.mockReturnValue(false);
});

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe("getMessages", () => {
  it("未登录 → 抛 McpError", async () => {
    m.loadAccount.mockReturnValue(null);
    await expect(getMessages({})).rejects.toThrow(/尚未登录/);
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
          from_user_id: "u",
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

  it("媒体消息明确标注「未下载」；语音带微信转写文本", async () => {
    m.getUpdates.mockResolvedValue({
      ret: 0,
      msgs: [
        {
          message_type: 1,
          message_id: 11,
          from_user_id: "u",
          item_list: [
            { type: 2 },
            { type: 5 },
            { type: 4, file_item: { file_name: "a.pdf" } },
            { type: 3, voice_item: { text: "你好" } },
          ],
        },
      ],
      get_updates_buf: "buf6",
    });
    const r = await getMessages({});
    const text = parse(r).messages[0].text as string;
    expect(text).toContain("[Image: not downloaded");
    expect(text).toContain("[Video: not downloaded");
    expect(text).toContain("a.pdf (not downloaded)");
    expect(text).toContain("[Voice: 你好]");
  });

  it("取消信号中止在途长轮询 → 立即 cancelled，不等超时/不重试", async () => {
    const ac = new AbortController();
    m.getUpdates.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    );
    const p = getMessages({ wait: true }, ac.signal);
    setTimeout(() => ac.abort(), 10);
    const r = await p;
    expect(parse(r).cancelled).toBe(true);
  });

  it("处理响应前重读 state：别的调用刚写入的 token 不会被旧 state 覆盖", async () => {
    m.loadState
      .mockReturnValueOnce({ updatesBuf: "", contextTokens: {}, lastMessageId: 0 })
      .mockReturnValueOnce({
        updatesBuf: "",
        contextTokens: { "bot1:other": "ct-other" },
        lastMessageId: 0,
      });
    m.getUpdates.mockResolvedValue({
      ret: 0,
      msgs: [
        {
          message_type: 1,
          message_id: 3,
          from_user_id: "u",
          context_token: "ct-new",
          item_list: [{ type: 1, text_item: { text: "hi" } }],
        },
      ],
      get_updates_buf: "buf5",
    });
    await getMessages({});
    const saved = m.saveState.mock.calls.at(-1)![0] as {
      contextTokens: Record<string, string>;
    };
    expect(saved.contextTokens).toMatchObject({ "bot1:other": "ct-other", "bot1:u": "ct-new" });
  });

  it("非登录者消息被忽略，但游标照常推进（不会每轮重复判断）", async () => {
    m.getUpdates.mockResolvedValue({
      ret: 0,
      msgs: [
        {
          message_type: 1,
          message_id: 9,
          from_user_id: "stranger",
          context_token: "ct",
          item_list: [{ type: 1, text_item: { text: "do something" } }],
        },
      ],
      get_updates_buf: "buf3",
    });
    const r = await getMessages({});
    expect(parse(r).message_count).toBe(0);
    const saved = m.saveState.mock.calls.at(-1)![0] as { lastMessageId: string };
    expect(saved.lastMessageId).toBe("9");
  });

  it("allowFrom 白名单里的发件人放行（与 daemon 同一道兜底校验）", async () => {
    m.isAllowed.mockReturnValue(true);
    m.getUpdates.mockResolvedValue({
      ret: 0,
      msgs: [
        {
          message_type: 1,
          message_id: 10,
          from_user_id: "trusted",
          item_list: [{ type: 1, text_item: { text: "hi" } }],
        },
      ],
      get_updates_buf: "buf4",
    });
    const r = await getMessages({});
    expect(parse(r).messages[0].text).toBe("hi");
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
