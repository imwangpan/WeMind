import { describe, expect, it } from "vitest";

import { maskCodeRegions } from "./markdown-code.js";

describe("maskCodeRegions（出站媒体语法只看正文）", () => {
  it("行内代码被遮成等长空白，正文不动", () => {
    const s = "图片写 `![](路径)` 就行";
    const masked = maskCodeRegions(s);
    expect(masked).toHaveLength(s.length);
    expect(masked).not.toContain("路径");
    expect(masked).toContain("图片写");
    expect(masked).toContain("就行");
  });

  it("围栏代码块整段遮掉（含收尾围栏前的内容）", () => {
    const s = ["前文", "```md", "![x](a.png)", "[视频](file:///v.mp4)", "```", "后文"].join("\n");
    const masked = maskCodeRegions(s);
    expect(masked).toHaveLength(s.length);
    expect(masked).not.toContain("a.png");
    expect(masked).not.toContain("v.mp4");
    expect(masked).toContain("前文");
    expect(masked).toContain("后文");
  });

  it("没闭合的围栏一直遮到文末", () => {
    const s = ["前文", "```", "![x](a.png)", "后面还有字"].join("\n");
    const masked = maskCodeRegions(s);
    expect(masked).not.toContain("a.png");
    expect(masked).not.toContain("后面还有字");
  });

  it("保留换行，行数不变", () => {
    const s = "a\n`x`\nb";
    expect(maskCodeRegions(s).split("\n")).toHaveLength(3);
  });

  it("散落的单个反引号不跨行吞正文", () => {
    const s = ["这里有个反引号 `", "![图](b.png)"].join("\n");
    const masked = maskCodeRegions(s);
    expect(masked).toContain("b.png");
  });

  it("双反引号行内代码也能识别", () => {
    const s = "用 ``![](路径)`` 包起来";
    expect(maskCodeRegions(s)).not.toContain("路径");
  });
});
