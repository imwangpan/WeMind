import { describe, expect, it } from "vitest";

import { isAuthorizedSender } from "./access.js";

describe("isAuthorizedSender（登录者兜底校验）", () => {
  it("登录者始终放行，不受白名单影响", () => {
    expect(isAuthorizedSender("owner-1", "owner-1", () => false)).toBe(true);
  });

  it("白名单里的其它 userId 放行", () => {
    expect(isAuthorizedSender("friend-1", "owner-1", (id) => id === "friend-1")).toBe(true);
  });

  it("不在白名单、也不是登录者 → 拒绝", () => {
    expect(isAuthorizedSender("stranger", "owner-1", () => false)).toBe(false);
  });

  it("空发件人（缺 from_user_id）→ 拒绝，即使白名单函数错误地返回 true", () => {
    expect(isAuthorizedSender("", "owner-1", () => true)).toBe(false);
  });
});
