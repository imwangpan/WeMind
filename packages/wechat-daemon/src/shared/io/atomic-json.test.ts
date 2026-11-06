import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeJsonAtomic } from "./atomic-json.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-atomic-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeJsonAtomic", () => {
  it("写入后没有残留临时文件；重复写覆盖同一目标", () => {
    const file = path.join(dir, "brain.json");
    writeJsonAtomic(file, { agent: "kiro" });
    writeJsonAtomic(file, { agent: "opencode" });
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ agent: "opencode" });
    expect(fs.readdirSync(dir)).toEqual(["brain.json"]);
  });

  it("rename 失败：删掉本次临时文件、旧内容不动、抛错给调用方", () => {
    const file = path.join(dir, "brain.json");
    fs.writeFileSync(file, '{"agent":"old"}', "utf-8");
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("EACCES: simulated");
    });
    expect(() => writeJsonAtomic(file, { agent: "new" })).toThrow(/EACCES/);
    expect(fs.readFileSync(file, "utf-8")).toBe('{"agent":"old"}');
    expect(fs.readdirSync(dir)).toEqual(["brain.json"]); // 不留 .tmp-*
  });

  it("两个写者不会共用同一个临时文件名（同一毫秒也带 pid/随机后缀）", () => {
    const file = path.join(dir, "brain.json");
    const seen: string[] = [];
    const real = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      seen.push(String(p));
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.writeFileSync);
    writeJsonAtomic(file, { agent: "a" });
    writeJsonAtomic(file, { agent: "b" });
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});
