import { describe, it, expect } from "vitest";

import { readMcpServers, withMcpServers, parseJsonc } from "./agent-mcp.js";

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
