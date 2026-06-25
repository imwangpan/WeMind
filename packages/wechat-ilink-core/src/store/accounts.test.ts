import { describe, it, expect } from "vitest";

import { deriveAccountKey } from "./accounts.js";

describe("deriveAccountKey", () => {
  it("取 @ 之前的部分（典型 botId）", () => {
    expect(deriveAccountKey("feead781eb44@im.bot")).toBe("feead781eb44");
  });

  it("无 @ 时整体净化", () => {
    expect(deriveAccountKey("abc123")).toBe("abc123");
  });

  it("保留字母数字下划线连字符，过滤其它", () => {
    expect(deriveAccountKey("a_b-c@x")).toBe("a_b-c");
    expect(deriveAccountKey("a.b!c@im.bot")).toBe("abc");
  });

  it("空串 → 兜底 account", () => {
    expect(deriveAccountKey("")).toBe("account");
  });

  it("纯非法字符（如全角标点）→ 兜底 account", () => {
    expect(deriveAccountKey("！！！@im.bot")).toBe("account");
  });
});
