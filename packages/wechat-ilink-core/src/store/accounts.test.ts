import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/*
 * 注册表的「默认账号」语义：首个登记的账号自动成为默认；`default` 字段缺失时回落第一个账号；删掉默认账号自动轮到下一个。
 * `WEMIND_ROOT` 是模块加载时定死的，所以要在设好 WEMIND_HOME 之后**重新加载模块**（与 sandbox-qoder.test.ts 的手法一致）。
 */
describe("账号注册表（默认账号 / 别名）", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-accounts-"));
  const prevHome = process.env.WEMIND_HOME;
  let api: typeof import("./accounts.js");

  beforeAll(async () => {
    process.env.WEMIND_HOME = home;
    vi.resetModules();
    api = await import("./accounts.js");
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.WEMIND_HOME;
    else process.env.WEMIND_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("首个登记的账号自动成为默认；后登记的不会抢默认；label 默认等于 key", () => {
    api.registerAccount({
      key: "aaa",
      botId: "a@x",
      userId: "u1",
      baseUrl: "https://x",
      label: "",
    });
    expect(api.getDefaultKey()).toBe("aaa");
    api.registerAccount({
      key: "bbb",
      botId: "b@x",
      userId: "u2",
      baseUrl: "https://x",
      label: "副号",
    });
    expect(api.getDefaultKey()).toBe("aaa");
    expect(api.listAccounts().find((a) => a.key === "aaa")?.label).toBe("aaa");
    expect(api.listAccounts().find((a) => a.key === "bbb")?.label).toBe("副号");
  });

  it("setDefaultKey 改默认、setLabel 改别名", () => {
    api.setDefaultKey("bbb");
    expect(api.getDefaultKey()).toBe("bbb");
    api.setLabel("bbb", "main");
    expect(api.listAccounts().find((a) => a.key === "bbb")?.label).toBe("main");
  });

  it("default 字段缺失（老注册表）→ 回落第一个登记的账号", () => {
    const reg = JSON.parse(fs.readFileSync(path.join(home, "accounts.json"), "utf-8"));
    delete reg.default;
    fs.writeFileSync(path.join(home, "accounts.json"), JSON.stringify(reg), "utf-8");
    expect(api.getDefaultKey()).toBe("aaa");
  });

  it("删掉默认账号 → 自动轮到剩下的；删空 → undefined", () => {
    api.setDefaultKey("bbb"); // 上一条把 default 删掉了，这里先重新指到 bbb，才能测到「删默认 → 自动轮换」
    api.unregisterAccount("bbb");
    expect(api.getDefaultKey()).toBe("aaa");
    api.unregisterAccount("aaa");
    expect(api.getDefaultKey()).toBeUndefined();
  });
});
