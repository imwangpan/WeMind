import { describe, it, expect } from "vitest";

import { parseControl, parseTaskControl, parseBrainEscape } from "./index.js";

describe("parseControl（daemon 直接处理的控制指令）", () => {
  it("列出 mcp", () => {
    expect(parseControl("mcp")).toEqual({ kind: "list" });
    expect(parseControl("/mcp")).toEqual({ kind: "list" });
    expect(parseControl("列出 mcp")).toEqual({ kind: "list" });
    expect(parseControl("mcp list")).toEqual({ kind: "list" });
  });

  it("新会话", () => {
    expect(parseControl("新会话")).toEqual({ kind: "new" });
    expect(parseControl("重置")).toEqual({ kind: "new" });
    expect(parseControl("清空上下文")).toEqual({ kind: "new" });
    expect(parseControl("/new")).toEqual({ kind: "new" });
  });

  it("加载/卸载 mcp", () => {
    expect(parseControl("加载 foo")).toEqual({ kind: "add", name: "foo" });
    expect(parseControl("load bar")).toEqual({ kind: "add", name: "bar" });
    expect(parseControl("卸载 foo")).toEqual({ kind: "remove", name: "foo" });
    expect(parseControl("unload baz")).toEqual({ kind: "remove", name: "baz" });
  });

  it("普通对话 → null（不拦截）", () => {
    expect(parseControl("你好")).toBeNull();
    expect(parseControl("帮我写个脚本")).toBeNull();
    expect(parseControl("mcp 是什么")).toBeNull();
  });
});

describe("parseTaskControl（明确发给 worker 的指令）", () => {
  it("停止任务", () => {
    expect(parseTaskControl("结束任务")).toEqual({ kind: "stop" });
    expect(parseTaskControl("停止任务")).toEqual({ kind: "stop" });
    expect(parseTaskControl("/stop")).toEqual({ kind: "stop" });
  });

  it("任务：xxx → toWorker", () => {
    expect(parseTaskControl("任务：写个脚本")).toEqual({ kind: "toWorker", text: "写个脚本" });
    expect(parseTaskControl("task: do it")).toEqual({ kind: "toWorker", text: "do it" });
  });

  it("> 快捷别名 → toWorker", () => {
    expect(parseTaskControl("> 继续干")).toEqual({ kind: "toWorker", text: "继续干" });
  });

  it("普通对话 → null", () => {
    expect(parseTaskControl("你好")).toBeNull();
    expect(parseTaskControl("任务很重要")).toBeNull();
  });
});

describe("parseBrainEscape（强制走大脑的逃逸前缀）", () => {
  it("问大脑 前缀", () => {
    expect(parseBrainEscape("问大脑 今天天气如何")).toBe("今天天气如何");
    expect(parseBrainEscape("问大脑：你好")).toBe("你好");
  });

  it("无前缀 → null", () => {
    expect(parseBrainEscape("普通消息")).toBeNull();
    expect(parseBrainEscape("我想问大脑一个问题")).toBeNull();
  });
});
