import { describe, expect, it } from "vitest";
import { MessageItemType, type WeixinMessage } from "@wemind/wechat-ilink-core";

import {
  extractText,
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
