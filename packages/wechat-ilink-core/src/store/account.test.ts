import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { saveAccountTo } from "./account.js";
import type { AccountData } from "../api/types.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-account-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

const ACCOUNT: AccountData = {
  botToken: "tok-123",
  botId: "feead781eb44@im.bot",
  userId: "u-1",
  baseUrl: "https://example.invalid",
  savedAt: 1,
};

describe("saveAccountTo（按目录写凭证）", () => {
  it("写进指定目录并能被同目录读回", () => {
    const dir = tmpDir();
    saveAccountTo(dir, ACCOUNT);
    const written = JSON.parse(
      fs.readFileSync(path.join(dir, "account.json"), "utf-8"),
    ) as AccountData;
    expect(written).toEqual(ACCOUNT);
  });

  it("目录不存在时自动创建（登录时 .staging 可能还没建好）", () => {
    const dir = path.join(tmpDir(), "nested", "deep");
    saveAccountTo(dir, ACCOUNT);
    expect(fs.existsSync(path.join(dir, "account.json"))).toBe(true);
  });

  it("POSIX 下文件权限收敛到 600（Windows 无 chmod 语义，跳过）", () => {
    if (process.platform === "win32") return;
    const dir = tmpDir();
    saveAccountTo(dir, ACCOUNT);
    const mode = fs.statSync(path.join(dir, "account.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("重复保存是覆盖而非追加（同一目录只留最新一份凭证）", () => {
    const dir = tmpDir();
    saveAccountTo(dir, ACCOUNT);
    saveAccountTo(dir, { ...ACCOUNT, botToken: "tok-456" });
    const files = fs.readdirSync(dir);
    expect(files).toEqual(["account.json"]);
    const written = JSON.parse(
      fs.readFileSync(path.join(dir, "account.json"), "utf-8"),
    ) as AccountData;
    expect(written.botToken).toBe("tok-456");
  });
});
