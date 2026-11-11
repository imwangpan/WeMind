import { describe, expect, it, vi } from "vitest";

import {
  compareMessageIds,
  maxMessageId,
  normalizeMessageId,
  parseJsonWithLosslessIds,
  rememberMessageId,
} from "./message-id.js";

describe("parseJsonWithLosslessIds", () => {
  it("改写结果解析失败时告警并退回原文（不静默掩盖改写 bug）", () => {
    const originalParse = JSON.parse;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(JSON, "parse").mockImplementation(((text: string) => {
      if (text === '{"message_id":"123"}') throw new SyntaxError("rewritten broken");
      return originalParse(text);
    }) as typeof JSON.parse);
    try {
      expect(
        parseJsonWithLosslessIds<{ message_id: number }>('{"message_id":123}', "test"),
      ).toEqual({
        message_id: 123,
      });
      expect(warn).toHaveBeenCalledOnce();
      // logger 把 `[wemind/...][WARN]` 放在第一个参数、正文在后面，断言拼接后的整行。
      expect(warn.mock.calls[0]?.join(" ")).toContain("test");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("把 message_id/msg_id/svr_id 的数字转成字符串", () => {
    const parsed = parseJsonWithLosslessIds<{
      message_id: string;
      item: { msg_id: string; ref: { svr_id: string } };
    }>('{"message_id":7525055299038555001,"item":{"msg_id":2,"ref":{"svr_id":3}}}', "test");
    expect(parsed.message_id).toBe("7525055299038555001");
    expect(parsed.item.msg_id).toBe("2");
    expect(parsed.item.ref.svr_id).toBe("3");
  });

  it("不碰字符串内容、非 ID 字段与已带引号的 ID", () => {
    const parsed = parseJsonWithLosslessIds<{
      message_id: string;
      seq: number;
      text: string;
    }>('{"message_id":"7","seq":7,"text":"message_id: 9"}', "test");
    expect(parsed.message_id).toBe("7");
    expect(parsed.seq).toBe(7);
    expect(parsed.text).toBe("message_id: 9");
  });

  it("负数 ID 与字符串里的转义引号", () => {
    const parsed = parseJsonWithLosslessIds<{ message_id: string; text: string }>(
      '{"message_id":-42,"text":"quote: \\"message_id\\": 9"}',
      "test",
    );
    expect(parsed.message_id).toBe("-42");
    expect(parsed.text).toBe('quote: "message_id": 9');
  });

  it("小数/指数数字原样保留，不把 JSON 改坏（ID 按协议是整数）", () => {
    const parsed = parseJsonWithLosslessIds<{
      message_id: number;
      svr_id: number;
      n: number;
    }>('{"message_id":1.5,"svr_id":7.0e2,"n":-1e-3}', "test");
    expect(parsed.message_id).toBe(1.5);
    expect(parsed.svr_id).toBe(700);
    expect(parsed.n).toBe(-0.001);
  });

  it("容忍 key 与冒号/数字之间的空白", () => {
    const parsed = parseJsonWithLosslessIds<{ message_id: string }>(
      '{ "message_id" :  42 }',
      "test",
    );
    expect(parsed.message_id).toBe("42");
  });

  it("非法 JSON → 带 label 的清晰错误", () => {
    expect(() => parseJsonWithLosslessIds("{ nope", "getUpdates")).toThrow(
      /getUpdates：响应不是合法 JSON/,
    );
  });
});

describe("compareMessageIds / maxMessageId", () => {
  it("按 uint64 数值比较，而不按 JS number 精度", () => {
    expect(compareMessageIds("7525055299038555000", "7525055299038555001")).toBe(-1);
    expect(compareMessageIds("7525055299038555001", "7525055299038555000")).toBe(1);
    expect(compareMessageIds("7525055299038555001", "7525055299038555001")).toBe(0);
    expect(maxMessageId("7525055299038555000", "7525055299038555001")).toBe("7525055299038555001");
  });

  it("非数字字符串按字典序兜底", () => {
    expect(compareMessageIds("abc", "abd")).toBe(-1);
    expect(compareMessageIds("10", "abc")).toBe(1); // 数字优先于非数字
  });
});

describe("normalizeMessageId", () => {
  it("字符串/数字/非法值", () => {
    expect(normalizeMessageId(" 42 ")).toBe("42");
    expect(normalizeMessageId(42)).toBe("42");
    expect(normalizeMessageId(undefined)).toBe("0");
    expect(normalizeMessageId(NaN)).toBe("0");
  });
});

describe("rememberMessageId", () => {
  it("去重并只保留最近 N 个", () => {
    let seen: string[] = [];
    seen = rememberMessageId(seen, "1", 2);
    seen = rememberMessageId(seen, "2", 2);
    seen = rememberMessageId(seen, "1", 2); // 已存在：不改变顺序
    expect(seen).toEqual(["1", "2"]);
    seen = rememberMessageId(seen, "3", 2);
    expect(seen).toEqual(["2", "3"]);
  });
});
