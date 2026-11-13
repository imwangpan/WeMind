import { describe, expect, it } from "vitest";
import { MessageItemType, type WeixinMessage } from "@wemind/wechat-ilink-core";

import {
  contentlessNotice,
  extractInbound,
  extractText,
  formatQuote,
  isFastLane,
  passMcpToggleToBrain,
  shouldResumeInBrainQueue,
  PROGRESS_ACK_DELAY_MS,
  PROGRESS_NOTICE_GAP_MS,
  PROGRESS_SECOND_NOTICE_MS,
  secondNoticeText,
  shouldShowAck,
  shouldShowSecondNotice,
  toolIcon,
  toolSummary,
  zhTool,
} from "./daemon-routing.js";

const msg = (items: unknown[] | undefined) => ({ item_list: items }) as unknown as WeixinMessage;

describe("extractText（入站消息文本提取）", () => {
  it("多条 TEXT 用换行拼接；TEXT + VOICE 都保留", () => {
    expect(
      extractText(
        msg([
          { type: MessageItemType.TEXT, text_item: { text: "第一行" } },
          { type: MessageItemType.TEXT, text_item: { text: "第二行" } },
        ]),
      ),
    ).toBe("第一行\n第二行");
    expect(
      extractText(
        msg([
          { type: MessageItemType.TEXT, text_item: { text: "看图" } },
          { type: MessageItemType.VOICE, voice_item: { text: "语音转文字" } },
        ]),
      ),
    ).toBe("看图\n语音转文字");
  });

  it("空 item / 纯空白 / 无 item_list → 空串（不把垃圾当消息）", () => {
    expect(extractText(msg([{ type: MessageItemType.TEXT, text_item: { text: "   " } }]))).toBe("");
    expect(extractText(msg([{ type: MessageItemType.IMAGE }]))).toBe("");
    expect(extractText(msg([]))).toBe("");
    expect(extractText(msg(undefined))).toBe("");
  });
});

describe("extractInbound（文本 + 附件 + 引用）", () => {
  it("按 item 收集文本与各类附件；有转写的语音只算文本、不算附件", () => {
    const parts = extractInbound(
      msg([
        { type: MessageItemType.TEXT, text_item: { text: "看看这些" } },
        { type: MessageItemType.IMAGE, image_item: { aeskey: "a".repeat(32) } },
        { type: MessageItemType.VOICE, voice_item: { text: "语音转写", playtime: 1200 } },
        {
          type: MessageItemType.FILE,
          file_item: { file_name: "报告.pdf", media: { aes_key: "k" } },
        },
        { type: MessageItemType.VIDEO, video_item: { play_length: 3 } },
      ]),
    );
    expect(parts.text).toBe("看看这些\n语音转写");
    expect(parts.attachments.map((a) => a.kind)).toEqual(["image", "file", "video"]);
    expect(parts.unsupportedTypes).toEqual([]);
  });

  it("无转写语音：text 为空但附件仍保留，交给 worker 下载/转码", () => {
    const parts = extractInbound(
      msg([{ type: MessageItemType.VOICE, voice_item: { media: { aes_key: "k" } } }]),
    );
    expect(parts.text).toBe("");
    expect(parts.attachments).toEqual([
      { kind: "voice", item: expect.objectContaining({ media: { aes_key: "k" } }) },
    ]);
  });

  it("未知 item 类型进 unsupportedTypes；工具进度 item 11/12 只忽略、不报不支持", () => {
    const parts = extractInbound(
      msg([
        { type: 99, text_item: { text: "x" } },
        { type: MessageItemType.TOOL_CALL_START, tool_call_start_item: { tool_name: "x" } },
      ]),
    );
    expect(parts.unsupportedTypes).toEqual([99]);
  });

  it("引用消息：内联 title + 正文；只有 svr_id 时给「未缓存」占位", () => {
    const inline = extractInbound(
      msg([
        {
          type: MessageItemType.TEXT,
          text_item: { text: "同意" },
          ref_msg: {
            title: "原消息标题",
            message_item: { type: MessageItemType.TEXT, text_item: { text: "原文内容" } },
          },
        },
      ]),
    );
    expect(inline.quote).toMatchObject({ body: "原消息标题 | 原文内容" });
    expect(formatQuote(inline.quote)).toBe("[引用消息] 原消息标题 | 原文内容");

    const idOnly = extractInbound(
      msg([
        {
          type: MessageItemType.TEXT,
          text_item: { text: "同意" },
          ref_msg: { svr_id: "123" },
        },
      ]),
    );
    expect(idOnly.quote).toEqual({ body: undefined, svrId: "123" });
    expect(formatQuote(idOnly.quote)).toBe("[引用消息内容未缓存]");
  });

  it("带任何附件都不把「继续」类短句交给旧任务", () => {
    const tasks = { awaiting: 1, active: true, interrupted: 0 };
    expect(shouldResumeInBrainQueue("继续", 1, tasks)).toBe(false);
    expect(shouldResumeInBrainQueue("继续", 0, tasks)).toBe(true);
  });

  it("有转写的语音不算附件：语音里的「结束任务」仍走快车道", () => {
    const parts = extractInbound(
      msg([{ type: MessageItemType.VOICE, voice_item: { text: "结束任务 2" } }]),
    );
    expect(parts.attachments).toEqual([]);
    expect(
      isFastLane(
        parts.text,
        { awaiting: 0, active: false, interrupted: 0 },
        parts.attachments.length,
      ),
    ).toBe(true);
  });
});

describe("passMcpToggleToBrain（direct 下 MCP 增删交给 Agent）", () => {
  it("direct：加载/卸载都放行给 Agent", () => {
    expect(passMcpToggleToBrain({ kind: "add", name: "github" }, true)).toBe(true);
    expect(passMcpToggleToBrain({ kind: "remove", name: "github" }, true)).toBe(true);
  });

  it("sandbox：仍由 daemon 维护激活集", () => {
    expect(passMcpToggleToBrain({ kind: "add", name: "github" }, false)).toBe(false);
    expect(passMcpToggleToBrain({ kind: "remove", name: "github" }, false)).toBe(false);
  });

  it("其它指令与普通消息不受影响", () => {
    expect(passMcpToggleToBrain({ kind: "list" }, true)).toBe(false);
    expect(passMcpToggleToBrain({ kind: "help" }, true)).toBe(false);
    expect(passMcpToggleToBrain(null, true)).toBe(false);
  });
});

describe("zhTool / toolIcon（进度文案）", () => {
  it("常见英文工具标题中文化，未命中保持原样", () => {
    expect(zhTool("Searching the web for: weather")).toBe("联网搜索：weather");
    expect(zhTool("Running: npm test")).toBe("执行：npm test");
    expect(zhTool("Reading src/a.ts")).toBe("读取 src/a.ts");
    expect(zhTool("Writing out.txt")).toBe("写入 out.txt");
    expect(zhTool("Finding symbols")).toBe("查找 symbols");
    expect(zhTool("custom tool")).toBe("custom tool");
  });

  it("按工具类型给图标，未知/缺省用通用图标", () => {
    expect(toolIcon("read")).toBe("📄");
    expect(toolIcon("search")).toBe("🔍");
    expect(toolIcon("execute")).toBe("⌨️");
    expect(toolIcon("fetch")).toBe("🌐");
    expect(toolIcon("edit")).toBe("✏️");
    expect(toolIcon("write")).toBe("✏️");
    expect(toolIcon("delete")).toBe("🗑️");
    expect(toolIcon("other")).toBe("🔧");
    expect(toolIcon()).toBe("🔧");
  });
});

describe("toolSummary（步骤文案可读性）", () => {
  it("优先用人话 purpose；否则用类型动词 + 短参数；最后回退标题", () => {
    expect(toolSummary("execute", "bash", "跑测试", "npm test")).toBe("跑测试");
    expect(toolSummary("execute", "bash", undefined, "npm test")).toBe("执行 npm test");
    expect(toolSummary("read", "read", undefined, "src/a.ts")).toBe("读取 src/a.ts");
    expect(toolSummary("search", "web_search", undefined, "深圳天气")).toBe("搜索 深圳天气");
    expect(toolSummary("other", "custom_tool", undefined, undefined)).toBe("custom_tool");
    expect(toolSummary("other", undefined, undefined, undefined)).toBe("调用工具");
  });
});

describe("三档进度提示（快 / 中 / 慢）", () => {
  it("5s 确认只在还没有任何可见进度时发", () => {
    expect(shouldShowAck(false)).toBe(true);
    expect(shouldShowAck(true)).toBe(false);
  });

  it("15s 第二条要求最终答案未开始、且距上一条非确认进度 ≥5s", () => {
    expect(shouldShowSecondNotice(14_999, false, 15_000)).toBe(false);
    expect(shouldShowSecondNotice(15_000, false, 4_999)).toBe(false);
    expect(shouldShowSecondNotice(15_000, false, 5_000)).toBe(true);
    expect(shouldShowSecondNotice(15_000, true, 15_000)).toBe(false);
    expect(shouldShowSecondNotice(30_000, false, 20_000)).toBe(true);
  });

  it("第 15s 第二条的措辞随正文是否开始切换", () => {
    expect(secondNoticeText(false)).toBe("⏳ 还在处理中…");
    expect(secondNoticeText(true)).toBe("✍️ 正在整理回复…");
  });

  it("阈值：确认 5s、第二条 15s；确认本身不能挡住 15s 的第二条", () => {
    expect(PROGRESS_ACK_DELAY_MS).toBe(5_000);
    expect(PROGRESS_SECOND_NOTICE_MS).toBe(15_000);
    expect(PROGRESS_NOTICE_GAP_MS).toBeLessThanOrEqual(
      PROGRESS_SECOND_NOTICE_MS - PROGRESS_ACK_DELAY_MS,
    );
  });
});

describe("contentlessNotice（只引用 / 未知类型时给明确提示）", () => {
  it("有正文或有媒体 → null（正常交给大脑）", () => {
    expect(
      contentlessNotice({ text: "你好", mediaCount: 0, unsupportedTypes: [], quote: undefined }),
    ).toBeNull();
    expect(
      contentlessNotice({ text: "", mediaCount: 1, unsupportedTypes: [], quote: { svrId: "1" } }),
    ).toBeNull();
  });

  it("只引用 → 提示用户补文字，不进大脑", () => {
    const notice = contentlessNotice({
      text: "",
      mediaCount: 0,
      unsupportedTypes: [],
      quote: { svrId: "99" },
    });
    expect(notice).toContain("只收到一条引用");
    expect(notice).toContain("请把要说的话一起打出来");
  });

  it("只有不认识的 item 类型 → 保留原提示", () => {
    const notice = contentlessNotice({
      text: "",
      mediaCount: 0,
      unsupportedTypes: [7, 8],
      quote: undefined,
    });
    expect(notice).toContain("暂不支持这条消息的类型");
    expect(notice).toContain("item type=7,8");
  });

  it("引用 + 未知类型 → 两条提示合并", () => {
    const notice = contentlessNotice({
      text: "",
      mediaCount: 0,
      unsupportedTypes: [7],
      quote: {},
    });
    expect(notice).toContain("暂不支持这条消息的类型");
    expect(notice).toContain("只收到一条引用");
    expect(notice).toContain("\n");
  });

  it("全空且没有引用/未知类型 → null（poller 静默跳过）", () => {
    expect(
      contentlessNotice({ text: "", mediaCount: 0, unsupportedTypes: [], quote: undefined }),
    ).toBeNull();
  });
});
