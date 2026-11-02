import { describe, it, expect, afterEach } from "vitest";
import { clearSessionPause, pauseSession } from "@wemind/wechat-ilink-core";

import { sessionExpiredResult } from "./session-result.js";

const parse = (r: ReturnType<typeof sessionExpiredResult>) =>
  JSON.parse(r.content[0].text) as { status: string; message: string };

afterEach(() => clearSessionPause("bot-test"));

describe("sessionExpiredResult（-14 的恢复指引）", () => {
  it("已登录时先 logout 再 login_qrcode——直接 login_qrcode 只会回 already_logged_in", () => {
    pauseSession("bot-test");
    const { status, message } = parse(sessionExpiredResult("bot-test"));
    expect(status).toBe("session_expired");
    expect(message).toMatch(/先调用 logout/);
    expect(message).toMatch(/login_qrcode/);
    expect(message).toMatch(/重启 MCP 客户端/);
    expect(message).toMatch(/约 \d+ 分钟/);
  });
});
