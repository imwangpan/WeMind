import { describe, it, expect } from "vitest";

import { extractImages } from "./image-reply.js";

describe("extractImages", () => {
  it("提取 Markdown 图片并从正文移除", () => {
    const { images, text } = extractImages("看这张 ![cat](https://x.com/a.png) 图");
    expect(images.map((i) => i.src)).toEqual(["https://x.com/a.png"]);
    expect(text).not.toContain("a.png");
    expect(text).toContain("看这张");
  });

  it("提取本地路径的 Markdown 图片", () => {
    const { images } = extractImages("![](C:/tmp/x.png)");
    expect(images.map((i) => i.src)).toEqual(["C:/tmp/x.png"]);
  });

  it("提取裸图片 URL", () => {
    const { images } = extractImages("见 https://x.com/pic.jpg 末尾");
    expect(images.map((i) => i.src)).toEqual(["https://x.com/pic.jpg"]);
  });

  it("带 title 的 Markdown 图片只取 src", () => {
    const { images } = extractImages('![a](https://x.com/a.png "标题")');
    expect(images.map((i) => i.src)).toEqual(["https://x.com/a.png"]);
  });

  it("尖括号包裹的 src", () => {
    const { images } = extractImages("![a](<https://x.com/a.png>)");
    expect(images.map((i) => i.src)).toEqual(["https://x.com/a.png"]);
  });

  it("重复图片去重", () => {
    const { images } = extractImages("![a](https://x.com/a.png) 又 ![b](https://x.com/a.png)");
    expect(images.length).toBe(1);
  });

  it("markdown 图片里的 URL 不会被裸 URL 规则重复提取", () => {
    const { images } = extractImages("![x](https://x.com/a.png)");
    expect(images.length).toBe(1);
  });

  it("非图片扩展名的裸 URL 不提取", () => {
    const { images, text } = extractImages("见 https://x.com/page.html");
    expect(images).toEqual([]);
    expect(text).toContain("page.html");
  });

  it("无图片时返回原文（仅压缩多余空行）", () => {
    const { images, text } = extractImages("纯文本回复");
    expect(images).toEqual([]);
    expect(text).toBe("纯文本回复");
  });
});
