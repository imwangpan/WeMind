import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * 登录归档：同一微信号重新扫码必须能并入现有账号目录（logout 保留目录就是为了重登），
 * 且不能覆盖会话/白名单/别名。`WEMIND_ROOT` 在模块加载时定死，所以设好 WEMIND_HOME 后重新加载模块。
 */
describe("finalizeStaging（首次归档与重登并入）", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-login-"));
  const prevHome = process.env.WEMIND_HOME;
  let finalize: typeof import("./cli-login.js").finalizeStaging;
  let createStaging: typeof import("./cli-login.js").createLoginStagingDir;
  let saveAccountTo: typeof import("@wemind/wechat-ilink-core").saveAccountTo;
  let loadAccount: typeof import("@wemind/wechat-ilink-core").loadAccount;
  let readAllowFrom: typeof import("@wemind/wechat-ilink-core").readAllowFrom;
  let listAccounts: typeof import("@wemind/wechat-ilink-core").listAccounts;

  const writeCred = (dir: string, token: string, botId = "bot1@im") => {
    fs.mkdirSync(dir, { recursive: true });
    saveAccountTo(dir, {
      botToken: token,
      botId,
      userId: "u1",
      baseUrl: "https://ilink.example",
      savedAt: 1,
    });
  };

  beforeAll(async () => {
    process.env.WEMIND_HOME = home;
    vi.resetModules();
    const cli = await import("./cli-login.js");
    const core = await import("@wemind/wechat-ilink-core");
    finalize = cli.finalizeStaging;
    createStaging = cli.createLoginStagingDir;
    saveAccountTo = core.saveAccountTo;
    loadAccount = core.loadAccount;
    readAllowFrom = core.readAllowFrom;
    listAccounts = core.listAccounts;
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.WEMIND_HOME;
    else process.env.WEMIND_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("首次登录：登记、种子白名单、清掉二维码等临时文件", () => {
    const staging = createStaging();
    writeCred(staging, "t1");
    fs.writeFileSync(path.join(staging, "qrcode.png"), "png", "utf-8");

    const { key, msg } = finalize(staging, "工作号");

    expect(key).toBe("bot1");
    expect(msg).toContain("已登录");
    expect(fs.existsSync(staging)).toBe(false);
    const dest = path.join(home, key);
    expect(loadAccount(dest)?.botToken).toBe("t1");
    expect(fs.existsSync(path.join(dest, "qrcode.png"))).toBe(false);
    expect(readAllowFrom(dest)).toEqual(["u1"]);
    expect(listAccounts().find((a) => a.key === key)?.label).toBe("工作号");
  });

  it("同一微信号重登：并入现有目录，保留会话/白名单/别名，只换凭证", () => {
    const dest = path.join(home, "bot1");
    fs.writeFileSync(path.join(dest, "brain-sessions.json"), '{"gemini:u1":"s1"}', "utf-8");
    fs.writeFileSync(
      path.join(dest, "allowFrom.json"),
      JSON.stringify({ version: 1, allowFrom: ["u1", "old-friend"] }),
      "utf-8",
    );

    const staging = createStaging();
    writeCred(staging, "t2");

    const { key, msg } = finalize(staging); // 不带 --label：保留原别名

    expect(key).toBe("bot1");
    expect(msg).toContain("已并入现有账号");
    expect(loadAccount(dest)?.botToken).toBe("t2");
    expect(fs.readFileSync(path.join(dest, "brain-sessions.json"), "utf-8")).toContain("s1");
    expect(readAllowFrom(dest).sort()).toEqual(["old-friend", "u1"]);
    expect(listAccounts().find((a) => a.key === key)?.label).toBe("工作号");
    expect(fs.existsSync(staging)).toBe(false);
  });

  it("账号路径被同名文件占用：明确报错，不覆盖该文件", () => {
    const staging = createStaging();
    writeCred(staging, "t3", "bot2@im");
    const dest = path.join(home, "bot2");
    fs.writeFileSync(dest, "not a directory", "utf-8");

    expect(() => finalize(staging)).toThrow(/不是目录/);
    expect(fs.readFileSync(dest, "utf-8")).toBe("not a directory");
  });
});

describe("loginUnsupportedHint（高级登录态直接失败并给下一步）", () => {
  it("验证码类说明需要人工处理，不再静默等到 15 分钟超时", async () => {
    const { loginUnsupportedHint } = await import("./cli-login.js");
    expect(loginUnsupportedHint("need_verifycode")).toContain("验证码");
    expect(loginUnsupportedHint("verify_code_blocked")).toContain("暂时阻止");
  });

  it("IDC 重定向带出目标 host，便于用户/支持人员判断", async () => {
    const { loginUnsupportedHint } = await import("./cli-login.js");
    expect(loginUnsupportedHint("scaned_but_redirect", "idc.example.com")).toContain(
      "idc.example.com",
    );
    expect(loginUnsupportedHint("binded_redirect")).toContain("接入点");
  });
});
