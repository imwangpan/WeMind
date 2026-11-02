import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withFileLock } from "./file-lock.js";

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-lock-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("withFileLock（跨进程读-改-写串行）", () => {
  it("执行后释放锁文件；回调抛错也释放", () => {
    const lock = path.join(tmpDir(), "x.json.lock");
    expect(withFileLock(lock, () => "ok", { subject: "测试文件" })).toBe("ok");
    expect(fs.existsSync(lock)).toBe(false);
    expect(() =>
      withFileLock(
        lock,
        () => {
          throw new Error("boom");
        },
        { subject: "测试文件" },
      ),
    ).toThrow("boom");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("陈旧锁（超过 staleMs）自动清理，不误报占用", () => {
    const lock = path.join(tmpDir(), "x.json.lock");
    fs.writeFileSync(lock, "stale", "utf-8");
    const old = Date.now() / 1000 - 60;
    fs.utimesSync(lock, old, old);
    expect(withFileLock(lock, () => "ok", { waitMs: 100, staleMs: 1000 })).toBe("ok");
  });

  it("未过期的锁等不到 → 明确报错，不退化成无锁写", () => {
    const lock = path.join(tmpDir(), "x.json.lock");
    fs.writeFileSync(lock, "held", "utf-8");
    expect(() =>
      withFileLock(lock, () => "never", { waitMs: 120, subject: "登录者白名单" }),
    ).toThrow(/登录者白名单正被另一个 wimind 进程修改/);
    expect(fs.existsSync(lock)).toBe(true); // 不是我们持有的锁，不能替别人删
  });
});
