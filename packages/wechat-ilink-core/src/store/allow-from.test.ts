import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { addAllowFrom, isAllowed, readAllowFrom, removeAllowFrom } from "./allow-from.js";

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-allow-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("allowFrom（登录者白名单，兜底安全闸）", () => {
  it("文件不存在 → 空清单，且 isAllowed 为 false（fail-closed）", () => {
    const dir = tmpDir();
    expect(readAllowFrom(dir)).toEqual([]);
    expect(isAllowed("u1", dir)).toBe(false);
  });

  it("加入去重、移除、持久化；不残留 .tmp 文件", () => {
    const dir = tmpDir();
    addAllowFrom("u1", dir);
    addAllowFrom("u1", dir);
    addAllowFrom("u2", dir);
    expect(readAllowFrom(dir)).toEqual(["u1", "u2"]);
    expect(isAllowed("u1", dir)).toBe(true);
    expect(isAllowed("u3", dir)).toBe(false);

    removeAllowFrom("u1", dir);
    expect(readAllowFrom(dir)).toEqual(["u2"]);
    expect(fs.readdirSync(dir).some((f) => f.includes(".tmp-"))).toBe(false);
  });

  it("空 userId 不写入（避免一条空串让全员通过）", () => {
    const dir = tmpDir();
    addAllowFrom("", dir);
    expect(readAllowFrom(dir)).toEqual([]);
    expect(isAllowed("", dir)).toBe(false);
  });

  it("损坏的文件 → fail-closed 返回空，并备份坏文件", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "allowFrom.json"), "{ not json", "utf-8");
    expect(readAllowFrom(dir)).toEqual([]);
    expect(isAllowed("u1", dir)).toBe(false);
    expect(fs.readdirSync(dir).some((f) => f.startsWith("allowFrom.json.corrupt-"))).toBe(true);
  });

  it("格式合法但字段类型不对 → 只保留非空字符串", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "allowFrom.json"),
      JSON.stringify({ version: 1, allowFrom: ["u1", "", 42, null, "u2"] }),
      "utf-8",
    );
    expect(readAllowFrom(dir)).toEqual(["u1", "u2"]);
  });
});
