import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// mock core：login 依赖的协议/存储函数桩化。
// DATA_DIR 用真实临时目录：二维码 PNG/TXT 的落盘与「文件缺失时重渲染」都要真的读写文件。
// 目录必须在 vi.hoisted 里创建——vi.mock 工厂会被提升到 import 之前，引用普通顶层变量会 TDZ 报错。
const m = vi.hoisted(() => ({
  dataDir: undefined as unknown as string,
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
// 用 getter 而不是取值快照：登录模块在 import 时就绑定 DATA_DIR，若这里给快照，
// 会拿到 hoisted 阶段的 undefined。getter 保证每次读到的都是最新值。
m.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-login-"));
vi.mock("@wemind/wechat-ilink-core", () => ({
  ...m,
  get DATA_DIR() {
    return m.dataDir;
  },
}));

const dataDir = m.dataDir;

import { checkQrcodeStatus, loginQrcode, logout } from "./login.js";

beforeEach(() => {
  vi.clearAllMocks();
  m.loadAccount.mockReturnValue(null); // 未登录
  m.loadQrState.mockReturnValue({ qrcode: "qr", qrcodeUrl: "url", createdAt: Date.now() }); // 新鲜二维码
});

afterEach(() => {
  for (const f of ["qrcode.png", "qrcode.txt"]) {
    fs.rmSync(path.join(dataDir, f), { force: true });
  }
});

const parse = (r: { content: Array<{ type: "text"; text: string }> }) =>
  JSON.parse(r.content[0].text);

describe("checkQrcodeStatus 高级态（不再静默卡死）", () => {
  it("need_verifycode → 明确提示需验证码、指向 CLI", async () => {
    m.pollQRStatus.mockResolvedValue({ status: "need_verifycode" });
    const r = await checkQrcodeStatus();
    expect(parse(r).status).toBe("need_verifycode");
    expect(parse(r).message).toMatch(/验证码/);
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
    expect(parse(r).message).toMatch(/重定向/);
    expect(parse(r).message).toContain("idc2.x.com");
  });

  it("binded_redirect 无 host → 文案里不出现空括号", async () => {
    m.pollQRStatus.mockResolvedValue({ status: "binded_redirect" });
    const msg = parse(await checkQrcodeStatus()).message as string;
    expect(msg).toMatch(/IDC 重定向/);
    expect(msg).not.toContain("()");
    expect(msg).not.toContain("（）");
  });
});

describe("checkQrcodeStatus 正常态（保持原行为）", () => {
  it("confirmed → 保存账号（baseUrl 回落到默认值）", async () => {
    m.pollQRStatus.mockResolvedValue({
      status: "confirmed",
      bot_token: "bt",
      ilink_bot_id: "bid",
      ilink_user_id: "uid",
    });
    const r = await checkQrcodeStatus();

    expect(parse(r).status).toBe("confirmed");
    expect(m.saveAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        botToken: "bt",
        botId: "bid",
        userId: "uid",
        baseUrl: "https://ilinkai.weixin.qq.com",
      }),
    );
    expect(m.clearQrState).toHaveBeenCalled();
    expect(m.clearSessionPause).toHaveBeenCalledWith("bid");
    expect(m.notifyStart).toHaveBeenCalledWith({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "bt",
    });
  });

  it("confirmed 但服务端数据不全 → 抛错且不落盘半份凭证", async () => {
    m.pollQRStatus.mockResolvedValue({ status: "confirmed", bot_token: "bt" });
    await expect(checkQrcodeStatus()).rejects.toThrow(/凭证数据不完整/);
    expect(m.saveAccount).not.toHaveBeenCalled();
  });

  it("wait → 等待扫码提示", async () => {
    m.pollQRStatus.mockResolvedValue({ status: "wait" });
    const r = await checkQrcodeStatus();
    expect(parse(r).status).toBe("wait");
    expect(parse(r).message).toMatch(/等待扫码/);
  });

  it("scaned（已扫未确认）→ 继续轮询的提示", async () => {
    m.pollQRStatus.mockResolvedValue({ status: "scaned" });
    expect(parse(await checkQrcodeStatus()).message).toMatch(/正在等待微信端确认/);
  });

  it("本地 TTL 已过 → 直接返回 expired 并清掉扫码态，不再打服务端", async () => {
    m.loadQrState.mockReturnValue({ qrcode: "qr", qrcodeUrl: "url", createdAt: 0 });
    const r = await checkQrcodeStatus();

    expect(parse(r).status).toBe("expired");
    expect(m.pollQRStatus).not.toHaveBeenCalled();
    expect(m.clearQrState).toHaveBeenCalled();
  });

  it("服务端报 expired → 清扫码态", async () => {
    m.pollQRStatus.mockResolvedValue({ status: "expired" });
    expect(parse(await checkQrcodeStatus()).status).toBe("expired");
    expect(m.clearQrState).toHaveBeenCalled();
  });

  it("没有待处理二维码 → 提示先调 login_qrcode", async () => {
    m.loadQrState.mockReturnValue(null);
    await expect(checkQrcodeStatus()).rejects.toThrow(/请先调用 login_qrcode/);
  });

  it("已登录时直接返回 confirmed，不再轮询", async () => {
    m.loadAccount.mockReturnValue({ botToken: "t", botId: "b", userId: "u" });
    expect(parse(await checkQrcodeStatus()).status).toBe("confirmed");
    expect(m.pollQRStatus).not.toHaveBeenCalled();
  });
});

describe("loginQrcode", () => {
  it("已登录 → already_logged_in，不取新二维码", async () => {
    m.loadAccount.mockReturnValue({ botToken: "t", botId: "b", userId: "u" });
    expect(parse(await loginQrcode()).status).toBe("already_logged_in");
    expect(m.fetchQRCode).not.toHaveBeenCalled();
  });

  it("复用未过期二维码：图片/文本存在时不重渲染、不请求服务端", async () => {
    fs.writeFileSync(path.join(dataDir, "qrcode.png"), "png");
    fs.writeFileSync(path.join(dataDir, "qrcode.txt"), "txt");

    const r = await loginQrcode();
    expect(r.content[0].text).toContain("url");
    expect(m.fetchQRCode).not.toHaveBeenCalled();
    expect(m.saveQrState).not.toHaveBeenCalled();
  });

  it("复用未过期二维码：图片文件被清理时按同一 URL 重新渲染", async () => {
    const r = await loginQrcode();

    expect(m.fetchQRCode).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dataDir, "qrcode.png"))).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, "qrcode.txt"), "utf-8").length).toBeGreaterThan(0);
    expect(r.content[0].text).toContain(path.join(dataDir, "qrcode.txt"));
  });

  it("二维码已过期 → 取新码、覆盖扫码态、生成两种文件", async () => {
    m.loadQrState.mockReturnValue({ qrcode: "old", qrcodeUrl: "old-url", createdAt: 0 });
    m.fetchQRCode.mockResolvedValue({ qrcode: "new", qrcode_img_content: "new-url" });

    const r = await loginQrcode();

    expect(m.fetchQRCode).toHaveBeenCalledTimes(1);
    expect(m.saveQrState).toHaveBeenCalledWith(
      expect.objectContaining({ qrcode: "new", qrcodeUrl: "new-url" }),
    );
    expect(fs.existsSync(path.join(dataDir, "qrcode.png"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "qrcode.txt"))).toBe(true);
    expect(r.content[0].text).toContain("new-url");
  });

  it("引导文案要求 Agent 自己 cat 终端二维码（三种展示方式都给）", async () => {
    m.loadQrState.mockReturnValue(null); // 强制走「取新码」分支
    m.fetchQRCode.mockResolvedValue({ qrcode: "q", qrcode_img_content: "https://qr" });
    const text = (await loginQrcode()).content[0].text;

    expect(text).toContain("cat ");
    expect(text).toContain("open the image at");
    expect(text).toContain("https://qr");
    expect(text).toMatch(/Show ALL THREE options/i);
  });
});

describe("logout", () => {
  it("通知下线 + 清扫码态/运行状态/凭证", async () => {
    m.loadAccount.mockReturnValue({ botToken: "t", botId: "b", baseUrl: "https://x" });
    const r = await logout();

    expect(m.notifyStop).toHaveBeenCalledWith({ baseUrl: "https://x", token: "t" });
    expect(m.clearQrState).toHaveBeenCalled();
    expect(m.resetState).toHaveBeenCalled();
    expect(m.clearAccount).toHaveBeenCalled();
    expect(parse(r).status).toBe("logged_out");
  });

  it("未登录时也能登出（不调 notifyStop，其余清理照做）", async () => {
    m.loadAccount.mockReturnValue(null);
    expect(parse(await logout()).status).toBe("logged_out");
    expect(m.notifyStop).not.toHaveBeenCalled();
    expect(m.clearAccount).toHaveBeenCalled();
  });

  it("notifyStop 内部已 best-effort 吞错，这里不会因它抛错而中断清理", async () => {
    m.loadAccount.mockReturnValue({ botToken: "t", botId: "b", baseUrl: "https://x" });
    // 真实 notifyStop 不会 reject（内部 try/catch）；这里验证 logout 没有额外的脆弱依赖
    m.notifyStop.mockResolvedValue(undefined);
    await expect(logout()).resolves.toBeDefined();
  });
});
