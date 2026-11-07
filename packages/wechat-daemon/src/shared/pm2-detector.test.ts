import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  parsePM2Version,
  getPM2InstanceName,
  isPersistenceConfigured,
  markPersistenceConfigured,
  persistenceMarkerPath,
} from "./pm2-detector.js";

describe("parsePM2Version", () => {
  it("正常版本号", () => {
    expect(parsePM2Version(0, "8.1.0\n")).toEqual({ available: true, version: "8.1.0" });
    expect(parsePM2Version(0, "  12.0.3  ")).toEqual({ available: true, version: "12.0.3" });
  });

  it("非零退出码视为不可用", () => {
    expect(parsePM2Version(1, "8.1.0")).toEqual({ available: false });
    expect(parsePM2Version(null, "8.1.0")).toEqual({ available: false });
  });

  it("空输出或非版本内容视为不可用", () => {
    expect(parsePM2Version(0, "")).toEqual({ available: false });
    expect(parsePM2Version(0, "command not found")).toEqual({ available: false });
  });
});

describe("getPM2InstanceName", () => {
  it("按 key 生成，带 wemind- 前缀", () => {
    expect(getPM2InstanceName("default")).toBe("wemind-default");
    expect(getPM2InstanceName("feead781eb44")).toBe("wemind-feead781eb44");
  });
});

describe("持久化提示标记", () => {
  let root: string;
  let marker: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-pm2-"));
    marker = path.join(root, ".pm2-persistence-configured");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("标记路径在根目录下", () => {
    expect(persistenceMarkerPath(root)).toBe(marker);
  });

  it("标记不存在时返回 false", () => {
    expect(isPersistenceConfigured(root)).toBe(false);
  });

  it("写入后可读回 true", () => {
    markPersistenceConfigured(root);
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(marker, "utf-8")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(isPersistenceConfigured(root)).toBe(true);
  });

  it("重复写入不抛错且保持为 true", () => {
    markPersistenceConfigured(root);
    expect(() => markPersistenceConfigured(root)).not.toThrow();
    expect(isPersistenceConfigured(root)).toBe(true);
  });

  it("写入失败不抛错（best-effort）", () => {
    // 用一个「文件」当根目录：mkdirSync 会 ENOTDIR，触发 catch 分支
    const bogusRoot = path.join(root, "not-a-dir");
    fs.writeFileSync(bogusRoot, "x");
    expect(() => markPersistenceConfigured(bogusRoot)).not.toThrow();
    expect(isPersistenceConfigured(bogusRoot)).toBe(false);
  });
});
