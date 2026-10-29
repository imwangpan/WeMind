import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  saveAccountTo,
  loadAccount,
  clearAccount,
  loadState,
  saveState,
  resetState,
  loadQrState,
  saveQrState,
  clearQrState,
} from "./account.js";
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
    expect(loadAccount(dir)).toEqual(ACCOUNT);
  });

  it("目录不存在时自动创建（登录时 .staging 可能还没建好）", () => {
    const dir = path.join(tmpDir(), "nested", "deep");
    saveAccountTo(dir, ACCOUNT);
    expect(fs.existsSync(path.join(dir, "account.json"))).toBe(true);
  });

  it("POSIX 下文件权限统一为 600（Windows 无 chmod 语义，跳过）", () => {
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
    expect(fs.readdirSync(dir)).toEqual(["account.json"]);
    expect(loadAccount(dir)?.botToken).toBe("tok-456");
  });

  it("不留临时文件（原子写的 tmp 必须被 rename 掉）", () => {
    const dir = tmpDir();
    saveAccountTo(dir, ACCOUNT);
    expect(fs.readdirSync(dir).some((f) => f.includes(".tmp-"))).toBe(false);
  });

  it("write 失败时清掉临时文件并抛错，且不破坏已有凭证", () => {
    const dir = tmpDir();
    saveAccountTo(dir, ACCOUNT);

    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EXDEV: simulated");
    });
    try {
      expect(() => saveAccountTo(dir, { ...ACCOUNT, botToken: "new" })).toThrow(/EXDEV/);
    } finally {
      spy.mockRestore();
    }

    expect(fs.readdirSync(dir)).toEqual(["account.json"]);
    expect(loadAccount(dir)?.botToken).toBe("tok-123"); // 旧凭证仍在
  });
});

describe("loadAccount（损坏/不存在）", () => {
  it("文件不存在 → null（首次运行，正常）", () => {
    expect(loadAccount(tmpDir())).toBeNull();
  });

  it("文件损坏 → 备份为 *.corrupt-*、返回 null，且不静默丢弃原文件", () => {
    const dir = tmpDir();
    const file = path.join(dir, "account.json");
    fs.writeFileSync(file, "{ not json", "utf-8");

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(loadAccount(dir)).toBeNull();
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readdirSync(dir).some((f) => f.startsWith("account.json.corrupt-"))).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  it("读文件因权限等原因失败 → 抛错，不伪装成「没有账号」", () => {
    // 若静默返回 null，调用方 next 步 save 会覆盖掉真实凭证——这是数据丢失路径，必须冒泡。
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      const e = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      e.code = "EACCES";
      throw e;
    });
    try {
      expect(() => loadAccount(tmpDir())).toThrow(/EACCES/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("clearAccount", () => {
  it("返回 true 表示确实删掉了", () => {
    const dir = tmpDir();
    saveAccountTo(dir, ACCOUNT);
    expect(clearAccount(dir)).toBe(true);
    expect(loadAccount(dir)).toBeNull();
  });

  it("本来就没有 → 返回 false，不抛错", () => {
    expect(clearAccount(tmpDir())).toBe(false);
  });
});

describe("state 读写", () => {
  it("不存在时返回空状态（游标/令牌/消息 ID 的初值）", () => {
    expect(loadState(tmpDir())).toEqual({
      updatesBuf: "",
      contextTokens: {},
      lastMessageId: 0,
    });
  });

  it("save → load 往返一致", () => {
    const dir = tmpDir();
    const state = { updatesBuf: "buf", contextTokens: { "bot:u": "ct" }, lastMessageId: 9 };
    saveState(state, dir);
    expect(loadState(dir)).toEqual(state);
  });

  it("resetState 回到空状态（保留其它文件）", () => {
    const dir = tmpDir();
    saveState({ updatesBuf: "buf", contextTokens: { a: "b" }, lastMessageId: 3 }, dir);
    saveAccountTo(dir, ACCOUNT);

    resetState(dir);

    expect(loadState(dir)).toEqual({ updatesBuf: "", contextTokens: {}, lastMessageId: 0 });
    expect(loadAccount(dir)).toEqual(ACCOUNT);
  });

  it("空状态是每次新建的：改返回值不会污染下一次 load", () => {
    const dir = tmpDir();
    const first = loadState(dir);
    first.contextTokens["leak"] = "x";
    expect(loadState(dir).contextTokens).toEqual({});
  });
});

describe("qr_login 状态", () => {
  it("不存在 → null", () => {
    expect(loadQrState(tmpDir())).toBeNull();
  });

  it("save → load 往返，clear 后为 null", () => {
    const dir = tmpDir();
    saveQrState({ qrcode: "q", qrcodeUrl: "u", createdAt: 42 }, dir);
    expect(loadQrState(dir)).toEqual({ qrcode: "q", qrcodeUrl: "u", createdAt: 42 });

    expect(clearQrState(dir)).toBe(true);
    expect(loadQrState(dir)).toBeNull();
  });

  it("账号/状态/二维码三份文件互不干扰", () => {
    const dir = tmpDir();
    saveAccountTo(dir, ACCOUNT);
    saveState({ updatesBuf: "b", contextTokens: {}, lastMessageId: 1 }, dir);
    saveQrState({ qrcode: "q", qrcodeUrl: "u", createdAt: 1 }, dir);

    expect(fs.readdirSync(dir).sort()).toEqual(["account.json", "qr_login.json", "state.json"]);

    clearQrState(dir);
    expect(loadAccount(dir)).toEqual(ACCOUNT);
    expect(loadState(dir).updatesBuf).toBe("b");
  });
});
