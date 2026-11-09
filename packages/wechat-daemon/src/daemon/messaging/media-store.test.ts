import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  mediaInboxDir,
  pruneInboundMedia,
  safeMediaFileName,
  saveInboundMedia,
} from "./media-store.js";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-media-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("safeMediaFileName", () => {
  it("去掉路径与控制字符，保留扩展名", () => {
    expect(safeMediaFileName("C:\\tmp\\..\\报告.pdf")).toBe("报告.pdf");
    expect(safeMediaFileName("a\u0000b\u001f.txt")).toBe("ab.txt");
  });

  it("替换 Windows 非法字符、去尾部点/空格", () => {
    expect(safeMediaFileName('a<b>c:d"e|f?g*.txt')).toBe("a_b_c_d_e_f_g_.txt");
    expect(safeMediaFileName("report.  ")).toBe("report");
  });

  it("Windows 保留名加后缀", () => {
    expect(safeMediaFileName("CON")).toBe("CON_");
    expect(safeMediaFileName("nul.log")).toBe("nul_.log");
    expect(safeMediaFileName("Lpt1")).toBe("Lpt1_");
  });

  it("空名/纯非法名用 fallback；超长截到 100", () => {
    expect(safeMediaFileName("", "file.bin")).toBe("file.bin");
    expect(safeMediaFileName("...", "file.bin")).toBe("file.bin");
    expect(safeMediaFileName("a".repeat(200) + ".txt")).toHaveLength(100);
  });
});

describe("saveInboundMedia", () => {
  it("按 messageId-文件名保存，同名自动加 -1/-2", () => {
    const dir = tmpDir();
    const a = saveInboundMedia(
      Buffer.from("a"),
      { messageId: "42", fileName: "x.txt", kind: "file" },
      dir,
    );
    const b = saveInboundMedia(
      Buffer.from("b"),
      { messageId: "42", fileName: "x.txt", kind: "file" },
      dir,
    );
    const c = saveInboundMedia(
      Buffer.from("c"),
      { messageId: "42", fileName: "x.txt", kind: "file" },
      dir,
    );
    expect(path.basename(a)).toBe("42-x.txt");
    expect(path.basename(b)).toBe("42-1-x.txt");
    expect(path.basename(c)).toBe("42-2-x.txt");
    expect(fs.readFileSync(b, "utf8")).toBe("b");
  });

  it("messageId 里的非法字符被替换；缺省文件名用 kind.bin", () => {
    const dir = tmpDir();
    const file = saveInboundMedia(Buffer.from("x"), { messageId: "../a/b", kind: "voice" }, dir);
    expect(path.basename(file)).toBe(".._a_b-voice.bin");
  });
});

describe("pruneInboundMedia", () => {
  it("目录不存在时安全返回", () => {
    expect(pruneInboundMedia(path.join(tmpDir(), "nope"))).toEqual({ removed: 0, bytes: 0 });
  });

  it("按 TTL 删除过期文件，保留新文件", () => {
    const dir = tmpDir();
    const old = path.join(dir, "old.bin");
    const fresh = path.join(dir, "fresh.bin");
    fs.writeFileSync(old, "12345");
    fs.writeFileSync(fresh, "1234567890");
    const now = Date.now();
    fs.utimesSync(old, new Date(now - 10 * 24 * 3600_000), new Date(now - 10 * 24 * 3600_000));
    const result = pruneInboundMedia(dir, { ttlMs: 7 * 24 * 3600_000, maxBytes: 1_000, now });
    expect(result).toEqual({ removed: 1, bytes: 10 });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("超总量时从最旧开始删，直到限额内", () => {
    const dir = tmpDir();
    const files = ["a.bin", "b.bin", "c.bin"].map((name) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, Buffer.alloc(10));
      return file;
    });
    const now = Date.now();
    fs.utimesSync(files[0], new Date(now - 3000), new Date(now - 3000));
    fs.utimesSync(files[1], new Date(now - 2000), new Date(now - 2000));
    fs.utimesSync(files[2], new Date(now - 1000), new Date(now - 1000));
    const result = pruneInboundMedia(dir, { ttlMs: 1e12, maxBytes: 15, now });
    expect(result).toEqual({ removed: 2, bytes: 10 });
    expect(fs.existsSync(files[0])).toBe(false);
    expect(fs.existsSync(files[1])).toBe(false);
    expect(fs.existsSync(files[2])).toBe(true);
  });
});

describe("mediaInboxDir", () => {
  it("位于 BRAIN_HOME/media/inbound", () => {
    expect(mediaInboxDir()).toMatch(/[\\/]media[\\/]inbound$/);
  });
});
