import { describe, it, expect } from "vitest";

import { readMcpServers, withMcpServers, parseJsonc, toAcpMcpServers, isConvertibleToAcp } from "./agent-mcp.js";

describe("readMcpServers", () => {
  it("kiro：读 mcpServers", () => {
    const obj = { mcpServers: { foo: { command: "x" } } };
    expect(readMcpServers(obj, "kiro")).toEqual({ foo: { command: "x" } });
  });

  it("opencode：读 mcp.servers", () => {
    const obj = { model: "a/b", mcp: { servers: { bar: { type: "local" } } } };
    expect(readMcpServers(obj, "opencode")).toEqual({ bar: { type: "local" } });
  });

  it("缺失/格式不符 → 空表", () => {
    expect(readMcpServers(null, "kiro")).toEqual({});
    expect(readMcpServers({}, "opencode")).toEqual({});
    expect(readMcpServers({ mcpServers: {} }, "opencode")).toEqual({}); // 用错格式
    expect(readMcpServers({ mcp: {} }, "opencode")).toEqual({});
  });
});

describe("withMcpServers", () => {
  it("kiro：写 mcpServers，返回新对象", () => {
    const input = { other: 1 };
    const out = withMcpServers(input, { a: {} }, "kiro");
    expect(out).toEqual({ other: 1, mcpServers: { a: {} } });
    expect(input).toEqual({ other: 1 }); // 不改原对象
  });

  it("opencode：写 mcp.servers，保留 model 与 mcp 其它键", () => {
    const input = { model: "a/b", mcp: { timeout: 1000, servers: { old: {} } } };
    const out = withMcpServers(input, { new: { type: "local" } }, "opencode");
    expect(out).toEqual({
      model: "a/b",
      mcp: { timeout: 1000, servers: { new: { type: "local" } } },
    });
    expect((input.mcp as any).servers).toEqual({ old: {} }); // 不改原对象
  });

  it("opencode：无 mcp 键也能建出", () => {
    expect(withMcpServers({}, { a: {} }, "opencode")).toEqual({ mcp: { servers: { a: {} } } });
  });
});

describe("parseJsonc", () => {
  it("解析普通 JSON", () => {
    expect(parseJsonc('{"a":1}')).toEqual({ a: 1 });
  });

  it("去掉行注释/块注释/尾随逗号", () => {
    const text = `{
      // 这是注释
      "model": "opencode/foo", /* 块注释 */
      "mcp": { "servers": {} },
    }`;
    expect(parseJsonc(text)).toEqual({ model: "opencode/foo", mcp: { servers: {} } });
  });

  it("保留 URL 中的 //", () => {
    expect(parseJsonc('{"url":"https://a.b/c"}')).toEqual({ url: "https://a.b/c" });
  });

  it("非法内容 → null", () => {
    expect(parseJsonc("not json")).toBeNull();
  });
});

describe("toAcpMcpServers（mcpViaAcp 传输转换）", () => {
  it("kiro local：command/args/env(map) → stdio 声明（env 转 {name,value}[]）", () => {
    const { servers, skipped } = toAcpMcpServers({
      a: { command: "node", args: ["s.js"], env: { T: "1", U: 2 } },
    });
    expect(skipped).toEqual([]);
    expect(servers).toEqual([
      { name: "a", command: "node", args: ["s.js"], env: [{ name: "T", value: "1" }, { name: "U", value: "2" }] },
    ]);
  });

  it("opencode local：command 数组拆 command[0]/args，environment → env", () => {
    const { servers } = toAcpMcpServers({
      b: { type: "local", command: ["node", "x.js", "--flag"], environment: { K: "v" } },
    });
    expect(servers).toEqual([
      { name: "b", command: "node", args: ["x.js", "--flag"], env: [{ name: "K", value: "v" }] },
    ]);
  });

  it("remote url → http 声明；headers 兼容 map 与 {name,value}[]", () => {
    const { servers } = toAcpMcpServers({
      h1: { url: "https://x/y" },
      h2: { url: "https://z", headers: { A: "1" } },
      h3: { url: "https://w", headers: [{ name: "B", value: "2" }] },
    });
    expect(servers).toContainEqual({ name: "h1", type: "http", url: "https://x/y", headers: [] });
    expect(servers).toContainEqual({ name: "h2", type: "http", url: "https://z", headers: [{ name: "A", value: "1" }] });
    expect(servers).toContainEqual({ name: "h3", type: "http", url: "https://w", headers: [{ name: "B", value: "2" }] });
  });

  it("坏条目进 skipped（不抛），exclude 名单跳过", () => {
    const { servers, skipped } = toAcpMcpServers(
      {
        good: { command: "x" },
        empty: {},
        broken: { command: "" },
        arr: ["not", "an", "object"],
        wechat: { command: "w" },
      },
      { exclude: ["wechat"] },
    );
    expect(servers.map((s: any) => s.name)).toEqual(["good"]);
    expect(skipped).toEqual(["empty", "broken", "arr"]);
  });

  it("opencode local 的 command 数组首项为空 → skipped", () => {
    const { servers, skipped } = toAcpMcpServers({ c: { type: "local", command: [] } });
    expect(servers).toEqual([]);
    expect(skipped).toEqual(["c"]);
  });
});

describe("isConvertibleToAcp（addMcp 预校验）", () => {
  it("有 command（字符串/数组首项）或 url → 可转换", () => {
    expect(isConvertibleToAcp({ command: "x" })).toBe(true);
    expect(isConvertibleToAcp({ command: ["node", "a.js"] })).toBe(true);
    expect(isConvertibleToAcp({ url: "https://a" })).toBe(true);
  });

  it("缺 command/url、非对象、空 command → 不可转换", () => {
    expect(isConvertibleToAcp({})).toBe(false);
    expect(isConvertibleToAcp(null)).toBe(false);
    expect(isConvertibleToAcp("x")).toBe(false);
    expect(isConvertibleToAcp({ command: "" })).toBe(false);
    expect(isConvertibleToAcp({ command: [] })).toBe(false);
  });
});
