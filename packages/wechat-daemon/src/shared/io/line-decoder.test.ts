import { describe, it, expect } from "vitest";

import { LineDecoder } from "./line-decoder.js";

const bytes = (s: string): Buffer => Buffer.from(s, "utf8");

describe("LineDecoder", () => {
  it("UTF-8 多字节字符跨 chunk：不出现 U+FFFD，正文完整", () => {
    const d = new LineDecoder();
    const line = bytes('{"text":"中文回复"}\n');
    const cut = line.indexOf(bytes("中")) + 1; // 切在「中」的三个字节中间
    expect(d.push(line.subarray(0, cut))).toEqual([]); // 半截行先攒着
    expect(d.push(line.subarray(cut))).toEqual(['{"text":"中文回复"}']);
    expect(d.push(bytes('{"text":"中文回复"}\n'))[0]).not.toContain("�");
  });

  it("一次喂多行：只返回完整行，最后半截留到下次", () => {
    const d = new LineDecoder();
    expect(d.push(bytes("a\nb\nc"))).toEqual(["a", "b"]);
    expect(d.push(bytes("d\n"))).toEqual(["cd"]);
  });

  it("空行与纯空白行丢弃", () => {
    const d = new LineDecoder();
    expect(d.push(bytes("\n  \n\r\nx\n"))).toEqual(["x"]);
  });

  it("reset 丢弃半截行与未完成的多字节序列（进程重建不串帧）", () => {
    const d = new LineDecoder();
    const line = bytes("半截中文\n");
    d.push(line.subarray(0, line.indexOf(bytes("中")) + 1));
    d.reset();
    expect(d.push(bytes("新行\n"))).toEqual(["新行"]);
  });
});
