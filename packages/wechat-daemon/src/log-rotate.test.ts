import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_LOG_KEEP,
  DEFAULT_LOG_MAX_BYTES,
  RotatingLog,
  logLimitsFromEnv,
  rotateLogFile,
} from "./log-rotate.js";

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-log-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("logLimitsFromEnv", () => {
  it("默认 10MB / 保留 3 份", () => {
    expect(logLimitsFromEnv({})).toEqual({
      maxBytes: DEFAULT_LOG_MAX_BYTES,
      keep: DEFAULT_LOG_KEEP,
    });
  });

  it("接受自定义值；非法值回落默认", () => {
    expect(logLimitsFromEnv({ WEMIND_LOG_MAX_MB: "2", WEMIND_LOG_KEEP: "0" })).toEqual({
      maxBytes: 2 * 1024 * 1024,
      keep: 0,
    });
    expect(logLimitsFromEnv({ WEMIND_LOG_MAX_MB: "0", WEMIND_LOG_KEEP: "-1" })).toEqual({
      maxBytes: DEFAULT_LOG_MAX_BYTES,
      keep: DEFAULT_LOG_KEEP,
    });
    expect(logLimitsFromEnv({ WEMIND_LOG_MAX_MB: "abc", WEMIND_LOG_KEEP: "1.5" })).toEqual({
      maxBytes: DEFAULT_LOG_MAX_BYTES,
      keep: DEFAULT_LOG_KEEP,
    });
  });
});

describe("rotateLogFile", () => {
  const limits = { maxBytes: 10, keep: 3 };

  it("没到上限 → 不动", () => {
    const f = path.join(tmpDir(), "daemon.log");
    fs.writeFileSync(f, "123456789");
    expect(rotateLogFile(f, limits)).toBe(false);
    expect(fs.readFileSync(f, "utf-8")).toBe("123456789");
    expect(fs.existsSync(`${f}.1`)).toBe(false);
  });

  it("文件不存在 → false", () => {
    expect(rotateLogFile(path.join(tmpDir(), "nope.log"), limits)).toBe(false);
  });

  it("到上限 → 当前文件变 .1，旧档依次后移，最旧的被删", () => {
    const f = path.join(tmpDir(), "daemon.log");
    fs.writeFileSync(`${f}.1`, "old-1");
    fs.writeFileSync(`${f}.2`, "old-2");
    fs.writeFileSync(`${f}.3`, "old-3");
    fs.writeFileSync(f, "0123456789");

    expect(rotateLogFile(f, limits)).toBe(true);

    expect(fs.existsSync(f)).toBe(false); // 等新一轮日志重新创建
    expect(fs.readFileSync(`${f}.1`, "utf-8")).toBe("0123456789");
    expect(fs.readFileSync(`${f}.2`, "utf-8")).toBe("old-1");
    expect(fs.readFileSync(`${f}.3`, "utf-8")).toBe("old-2");
  });

  it("keep=0 → 直接删掉当前文件（不留历史）", () => {
    const f = path.join(tmpDir(), "daemon.log");
    fs.writeFileSync(f, "0123456789");
    expect(rotateLogFile(f, { maxBytes: 10, keep: 0 })).toBe(true);
    expect(fs.existsSync(f)).toBe(false);
  });
});

describe("RotatingLog", () => {
  it("逐块追加；写满自动轮转，并在新文件里留一条说明", () => {
    const f = path.join(tmpDir(), "daemon.log");
    const log = new RotatingLog(f, { maxBytes: 200, keep: 2 });
    log.write("1".repeat(100));
    expect(fs.existsSync(`${f}.1`)).toBe(false);
    log.write("a".repeat(100)); // 跨过 200 字节 → 轮转
    expect(fs.readFileSync(`${f}.1`, "utf-8")).toBe("1".repeat(100) + "a".repeat(100));
    expect(fs.readFileSync(f, "utf-8")).toMatch(/已轮转/);

    log.writeLine("next");
    expect(fs.readFileSync(f, "utf-8")).toContain("next");
  });

  it("启动时发现旧日志已超限 → 先轮转再写", () => {
    const f = path.join(tmpDir(), "daemon.log");
    fs.writeFileSync(f, "x".repeat(300));
    const log = new RotatingLog(f, { maxBytes: 200, keep: 1 });
    expect(fs.readFileSync(`${f}.1`, "utf-8")).toBe("x".repeat(300));
    log.writeLine("fresh");
    expect(fs.readFileSync(f, "utf-8")).toContain("fresh");
  });
});
