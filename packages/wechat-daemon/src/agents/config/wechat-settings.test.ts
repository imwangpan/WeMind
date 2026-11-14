import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ensureParityAccountDirs } from "./account-bootstrap.js";
import {
  defaultWechatSettings,
  ensureWechatSettings,
  normalizeReplyStyle,
  readWechatSettings,
  replyStyleHint,
  saveWechatSettings,
  wechatSettingsPath,
} from "./wechat-settings.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wemind-wxsettings-"));
}

describe("normalizeReplyStyle", () => {
  it("认 concise（大小写与空白不敏感）", () => {
    expect(normalizeReplyStyle("concise")).toBe("concise");
    expect(normalizeReplyStyle("  CONCISE ")).toBe("concise");
  });

  it("null / 空串 / off / none / default 都表示关闭", () => {
    for (const v of [null, undefined, "", "off", "OFF", "none", "default"])
      expect(normalizeReplyStyle(v)).toBeNull();
  });

  it("无法识别的值返回 undefined（不静默归到某一档）", () => {
    expect(normalizeReplyStyle("tldr")).toBeUndefined();
    expect(normalizeReplyStyle(1)).toBeUndefined();
    expect(normalizeReplyStyle({ preset: "concise" })).toBeUndefined();
  });
});

describe("readWechatSettings", () => {
  it("缺文件回落默认（不注入），不报错", () => {
    const dir = tmp();
    expect(readWechatSettings(dir)).toEqual({ settings: defaultWechatSettings() });
  });

  it("坏 JSON / 非对象：回落到默认并带 problem", () => {
    const dir = tmp();
    fs.writeFileSync(wechatSettingsPath(dir), "{ not json");
    expect(readWechatSettings(dir).settings).toEqual(defaultWechatSettings());
    expect(readWechatSettings(dir).problem).toContain("JSON");

    fs.writeFileSync(wechatSettingsPath(dir), "[1,2,3]");
    expect(readWechatSettings(dir).settings).toEqual(defaultWechatSettings());
    expect(readWechatSettings(dir).problem).toContain("不是对象");
  });

  it("replyStyle 取值无效：回落默认并给出可读告警", () => {
    const dir = tmp();
    fs.writeFileSync(wechatSettingsPath(dir), JSON.stringify({ version: 1, replyStyle: "tldr" }));
    const r = readWechatSettings(dir);
    expect(r.settings.replyStyle).toBeNull();
    expect(r.problem).toContain("replyStyle");
  });

  it("读到 concise 时原样返回，不因缺 version 字段失败", () => {
    const dir = tmp();
    fs.writeFileSync(wechatSettingsPath(dir), JSON.stringify({ replyStyle: "concise" }));
    expect(readWechatSettings(dir).settings).toEqual({ version: 1, replyStyle: "concise" });
  });
});

describe("账户骨架与写入", () => {
  it("新账号骨架创建空设置文件，且不覆盖已存在的用户选择", () => {
    const dir = tmp();
    ensureParityAccountDirs(dir);
    expect(JSON.parse(fs.readFileSync(wechatSettingsPath(dir), "utf-8"))).toEqual({
      version: 1,
      replyStyle: null,
    });

    saveWechatSettings({ version: 1, replyStyle: "concise" }, dir);
    ensureWechatSettings(dir);
    ensureParityAccountDirs(dir);
    expect(readWechatSettings(dir).settings.replyStyle).toBe("concise");
  });

  it("save 后可原样读回 off", () => {
    const dir = tmp();
    saveWechatSettings({ version: 1, replyStyle: "concise" }, dir);
    saveWechatSettings({ version: 1, replyStyle: null }, dir);
    expect(readWechatSettings(dir).settings.replyStyle).toBeNull();
  });
});

describe("replyStyleHint", () => {
  it("关闭时返回空串（拼 prompt 时不产生多余段落）", () => {
    expect(replyStyleHint(null)).toBe("");
  });

  it("concise 时返回非空提示，且提到精简", () => {
    const hint = replyStyleHint("concise");
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).toContain("精简");
  });
});
