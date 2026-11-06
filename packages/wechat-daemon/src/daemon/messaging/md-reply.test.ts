import { describe, it, expect } from "vitest";

import { generateTitle, buildMdReply } from "./md-reply.js";

describe("generateTitle", () => {
  it("取首个非空行", () => {
    expect(generateTitle("\n\n  Hello World  \n more")).toBe("Hello World");
  });

  it("去掉 Markdown 标题井号", () => {
    expect(generateTitle("# 我的标题\n正文")).toBe("我的标题");
    expect(generateTitle("### 三级")).toBe("三级");
  });

  it("去掉列表符与有序号", () => {
    expect(generateTitle("- 列表项")).toBe("列表项");
    expect(generateTitle("1. 第一项")).toBe("第一项");
  });

  it("去掉强调符号", () => {
    expect(generateTitle("**粗体** 标题")).toBe("粗体 标题");
  });

  it("非法文件名字符替换为空格并合并", () => {
    expect(generateTitle("a/b:c<d>e")).toBe("a b c d e");
  });

  it("超 40 字符截断", () => {
    expect(generateTitle("x".repeat(50)).length).toBe(40);
  });

  it("空内容/全标记 → 兜底「回复」", () => {
    expect(generateTitle("")).toBe("回复");
    expect(generateTitle("\n\n  \n")).toBe("回复");
    expect(generateTitle("***")).toBe("回复");
  });
});

describe("buildMdReply", () => {
  it("正文无标题时前置 H1", () => {
    const { fileName, data } = buildMdReply("正文内容");
    expect(fileName).toBe("正文内容.md");
    expect(data.toString("utf-8")).toBe("# 正文内容\n\n正文内容");
  });

  it("正文已以标题开头时不重复前置", () => {
    const { fileName, data } = buildMdReply("# 已有标题\n正文");
    expect(fileName).toBe("已有标题.md");
    expect(data.toString("utf-8")).toBe("# 已有标题\n正文");
  });
});
