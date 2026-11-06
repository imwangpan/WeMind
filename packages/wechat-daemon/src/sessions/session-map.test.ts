import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, it, expect } from "vitest";

import {
  backupCorruptSessionMap,
  normalizeSessionMap,
  readSessionMap,
  readSessionMapStrict,
  sessionKey,
} from "./session-map.js";

const tmpDirs: string[] = [];
function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-session-map-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("sessionKey", () => {
  it("按 agent 前缀分开存", () => {
    expect(sessionKey("qoder", "o9cq@im.wechat")).toBe("qoder:o9cq@im.wechat");
    expect(sessionKey("deepseek", "task")).toBe("deepseek:task");
  });
});

describe("normalizeSessionMap", () => {
  it("旧格式（裸 key）归给当前 agent 并标记 migrated", () => {
    const { map, migrated } = normalizeSessionMap({ "o9cq@im.wechat": "sid-1" }, "qoder");
    expect(map).toEqual({ "qoder:o9cq@im.wechat": "sid-1" });
    expect(migrated).toBe(true);
  });

  it("已带前缀的条目（含其它 agent）原样保留，不触发迁移", () => {
    const raw = {
      "qoder:o9cq@im.wechat": "sid-q",
      "deepseek:o9cq@im.wechat": "sid-d",
    };
    const { map, migrated } = normalizeSessionMap(raw, "qoder");
    expect(map).toEqual(raw);
    expect(migrated).toBe(false);
  });

  it("裸 key 与同名新格式共存时，保留新格式并丢掉裸条目", () => {
    const raw = {
      "qoder:o9cq@im.wechat": "sid-new",
      "o9cq@im.wechat": "sid-legacy",
    };
    const { map, migrated } = normalizeSessionMap(raw, "qoder");
    expect(map).toEqual({ "qoder:o9cq@im.wechat": "sid-new" });
    expect(migrated).toBe(true);
  });

  it("丢弃非字符串值", () => {
    const { map } = normalizeSessionMap({ "qoder:a": 1, "qoder:b": "sid-b", c: null }, "qoder");
    expect(map).toEqual({ "qoder:b": "sid-b" });
  });

  it("非法输入返回空映射", () => {
    for (const raw of [null, undefined, 42, "x", ["sid"]]) {
      expect(normalizeSessionMap(raw, "qoder")).toEqual({ map: {}, migrated: false });
    }
  });
});

describe("readSessionMapStrict / backupCorruptSessionMap（损坏文件不静默覆盖）", () => {
  it("文件缺失 → 空表", () => {
    expect(readSessionMapStrict(tmpFile("none.json"))).toEqual({});
  });

  it("损坏的 JSON 抛错；只读版本仍返回空表；备份后原路径视为缺失", () => {
    const file = tmpFile("brain-sessions.json");
    fs.writeFileSync(file, "{ not json", "utf-8");
    expect(() => readSessionMapStrict(file)).toThrow();
    expect(readSessionMap(file)).toEqual({});
    const backup = backupCorruptSessionMap(file);
    expect(backup).toMatch(/\.corrupt-\d+$/);
    expect(fs.existsSync(file)).toBe(false);
    expect(readSessionMapStrict(file)).toEqual({});
  });

  it("非对象（数组）也抛错", () => {
    const file = tmpFile("m.json");
    fs.writeFileSync(file, "[]", "utf-8");
    expect(() => readSessionMapStrict(file)).toThrow(/不是 JSON 对象/);
  });

  it("只保留字符串值", () => {
    const file = tmpFile("m.json");
    fs.writeFileSync(file, JSON.stringify({ a: "s", b: 1, c: "" }), "utf-8");
    expect(readSessionMapStrict(file)).toEqual({ a: "s" });
  });

  it("文件不存在时备份返回 undefined（不误报成功）", () => {
    expect(backupCorruptSessionMap(tmpFile("none.json"))).toBeUndefined();
  });
});
