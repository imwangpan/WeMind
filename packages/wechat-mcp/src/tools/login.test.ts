import { describe, it, expect, vi, beforeEach } from "vitest";

// mock core：login 依赖的协议/存储函数桩化（checkQrcodeStatus 主要用 loadAccount/loadQrState/pollQRStatus）
const m = vi.hoisted(() => ({
  fetchQRCode: vi.fn(),
  pollQRStatus: vi.fn(),
  notifyStart: vi.fn(() => Promise.resolve()),
  notifyStop: vi.fn(() => Promise.resolve()),
  clearSessionPause: vi.fn(),
  loadAccount: vi.fn(),
  saveAccount: vi.fn(),
  clearAccount: vi.fn(),
  loadQrState: vi.fn(),
  saveQrState: vi.fn(),
  clearQrState: vi.fn(),
  resetState: vi.fn(),
}));
vi.mock("@wemind/wechat-ilink-core", () => ({ ...m, DATA_DIR: "/tmp/wemind-test" }));

import { checkQrcodeStatus } from "./login.js";

beforeEach(() => {
  vi.clearAllMocks();
  m.loadAccount.mockReturnValue(null); // 未登录
  m.loadQrState.mockReturnValue({ qrcode: "qr", qrcodeUrl: "url", createdAt: Date.now() }); // 新鲜二维码
});

const parse = (r: { content: Array<{ type: "text"; text: string }> }) =>
  JSON.parse(r.content[0].text);

describe("checkQrcodeStatus 高级态（不再静默卡死）", () => {
  it("need_verifycode → 明确提示需验证码、指向 CLI", async () => {
    m.pollQRStatus.mockResolvedValue({ status: "need_verifycode" });
    const r = await checkQrcodeStatus();
    expect(parse(r).status).toBe("need_verifycode");
    expect(parse(r).message).toMatch(/verification code/i);
    expect(parse(r).message).toMatch(/wemind login/);
  });

  it("verify_code_blocked → 同样明确提示", async () => {
    m.pollQRStatus.mockResolvedValue({ status: "verify_code_blocked" });
    expect(parse(await checkQrcodeStatus()).status).toBe("verify_code_blocked");
  });

  it("scaned_but_redirect → 提示重定向并带 host", async () => {
    m.pollQRStatus.mockResolvedValue({
      status: "scaned_but_redirect",
      redirect_host: "idc2.x.com",
    });
    const r = await checkQrcodeStatus();
    expect(parse(r).status).toBe("scaned_but_redirect");
    expect(parse(r).message).toMatch(/redirect/i);
    expect(parse(r).message).toContain("idc2.x.com");
  });
});

describe("checkQrcodeStatus 正常态（保持原行为）", () => {
  it("confirmed → 保存账号", async () => {
    m.pollQRStatus.mockResolvedValue({
      status: "confirmed",
      bot_token: "bt",
      ilink_bot_id: "bid",
      ilink_user_id: "uid",
      baseurl: "https://x",
    });
    const r = await checkQrcodeStatus();
    expect(parse(r).status).toBe("confirmed");
    expect(m.saveAccount).toHaveBeenCalled();
  });

  it("wait → 等待扫码提示", async () => {
    m.pollQRStatus.mockResolvedValue({ status: "wait" });
    const r = await checkQrcodeStatus();
    expect(parse(r).status).toBe("wait");
    expect(parse(r).message).toMatch(/Waiting/i);
  });
});
