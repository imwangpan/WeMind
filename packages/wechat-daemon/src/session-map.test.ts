import { describe, it, expect } from "vitest";

import { normalizeSessionMap, sessionKey } from "./session-map.js";

describe("sessionKey", () => {
  it("按 agent 前缀分开存", () => {
    expect(sessionKey("qoder", "o9cq@im.wechat")).toBe("qoder:o9cq@im.wechat");
    expect(sessionKey("deepseek", "task")).toBe("deepseek:task");
  });
});

describe("normalizeSessionMap", () => {
  it("旧格式（裸 key）归给当前 agent 并标记 migrated", () => {
    const { map, migrated } = normalizeSessionMap({ "o9cq@im.wechat": "sid-1" }, "qoder");
    expect(map).toEqual({ "qoder:o9cq@im.wechat": "sid-1" });
    expect(migrated).toBe(true);
  });

  it("已带前缀的条目（含其它 agent）原样保留，不触发迁移", () => {
    const raw = {
      "qoder:o9cq@im.wechat": "sid-q",
      "deepseek:o9cq@im.wechat": "sid-d",
    };
    const { map, migrated } = normalizeSessionMap(raw, "qoder");
    expect(map).toEqual(raw);
    expect(migrated).toBe(false);
  });

  it("裸 key 与同名新格式共存时，保留新格式并丢掉裸条目", () => {
    const raw = {
      "qoder:o9cq@im.wechat": "sid-new",
      "o9cq@im.wechat": "sid-legacy",
    };
    const { map, migrated } = normalizeSessionMap(raw, "qoder");
    expect(map).toEqual({ "qoder:o9cq@im.wechat": "sid-new" });
    expect(migrated).toBe(true);
  });

  it("丢弃非字符串值", () => {
    const { map } = normalizeSessionMap({ "qoder:a": 1, "qoder:b": "sid-b", c: null }, "qoder");
    expect(map).toEqual({ "qoder:b": "sid-b" });
  });

  it("非法输入返回空映射", () => {
    for (const raw of [null, undefined, 42, "x", ["sid"]]) {
      expect(normalizeSessionMap(raw, "qoder")).toEqual({ map: {}, migrated: false });
    }
  });
});
