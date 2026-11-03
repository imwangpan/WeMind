import { describe, expect, it } from "vitest";
import { MessageItemType, type WeixinMessage } from "@wemind/wechat-ilink-core";

import {
  extractText,
  PROGRESS_ACK_DELAY_MS,
  PROGRESS_ANSWER_MIN_MS,
  shouldShowAnswerNotice,
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

describe("shouldShowAnswerNotice（快回合不刷整理提示）", () => {
  it("回合未满 5s 不发；满 5s 且尚未发过即时确认才发", () => {
    expect(shouldShowAnswerNotice(4_999, false)).toBe(false);
    expect(shouldShowAnswerNotice(4_999, true)).toBe(false);
    expect(shouldShowAnswerNotice(5_000, false)).toBe(true);
    expect(shouldShowAnswerNotice(8_000, false)).toBe(true);
  });

  it("已经发过即时确认就不再发整理提示", () => {
    expect(shouldShowAnswerNotice(5_000, true)).toBe(false);
    expect(shouldShowAnswerNotice(30_000, true)).toBe(false);
  });

  it("确认延迟必须晚于整理阈值，保证两条进度互斥", () => {
    expect(PROGRESS_ACK_DELAY_MS).toBeGreaterThan(PROGRESS_ANSWER_MIN_MS);
  });
});
