import { describe, it, expect } from "vitest";

import { buildClientVersion, generateId } from "./client.js";

describe("buildClientVersion (uint32 0xMMNNPP 编码)", () => {
  it("正常三段版本", () => {
    expect(buildClientVersion("2.4.3")).toBe((2 << 16) | (4 << 8) | 3);
  });

  it("缺省分量补 0", () => {
    expect(buildClientVersion("1")).toBe(1 << 16);
    expect(buildClientVersion("1.2")).toBe((1 << 16) | (2 << 8));
  });

  it("非数字分量回落 0", () => {
    expect(buildClientVersion("abc")).toBe(0);
    expect(buildClientVersion("x.y.z")).toBe(0);
  });

  it("分量 > 255 被 &0xff 截断", () => {
    expect(buildClientVersion("256.0.0")).toBe(0); // 256 & 0xff === 0
    expect(buildClientVersion("257.1.0")).toBe((1 << 16) | (1 << 8)); // 257 & 0xff === 1
  });
});

describe("generateId", () => {
  it("格式为 prefix:timestamp-hex8", () => {
    expect(generateId("img")).toMatch(/^img:\d+-[0-9a-f]{8}$/);
  });

  it("连续两次不重复", () => {
    expect(generateId("x")).not.toBe(generateId("x"));
  });
});
