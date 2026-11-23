import { stripVTControlCharacters } from "node:util";
import { crc32, inflateSync } from "node:zlib";
import jsQR from "jsqr";
import { describe, expect, it } from "vitest";

import { qrPng, qrTerminal } from "./qr.js";

/**
 * 登录二维码的自测：**必须能解回原文**。
 * 只断言「文件非空」没有意义——编码器写错位深/静区/颜色时，图片照样有内容，但用户扫不出来；这里用 jsqr（仅 devDependency）真扫一遍。
 */

/** 验签 PNG 结构并取出各块：CRC 用 `node:zlib` 的 crc32 独立校验（与被测的手写查表实现互为对照）。 */
function readChunks(png: Buffer): Map<string, Buffer> {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = new Map<string, Buffer>();
  let off = 8;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("latin1", off + 4, off + 8);
    const body = png.subarray(off + 8, off + 8 + len);
    expect(png.readUInt32BE(off + 8 + len)).toBe(crc32(png.subarray(off + 4, off + 8 + len)));
    chunks.set(type, body);
    off += 12 + len;
  }
  return chunks;
}

/** 把灰度 PNG 还原成 RGBA，交给 jsqr（jsqr 只认 RGBA 像素，不解析 PNG）。 */
function pngToRgba(png: Buffer): { data: Uint8ClampedArray; width: number; height: number } {
  const chunks = readChunks(png);
  expect([...chunks.keys()]).toEqual(["IHDR", "IDAT", "IEND"]);
  const ihdr = chunks.get("IHDR")!;
  expect(ihdr.length).toBe(13);
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  expect(height).toBe(width);
  expect(ihdr[8]).toBe(8); // 位深 8
  expect(ihdr[9]).toBe(0); // 颜色类型 0 = 灰度
  const raw = inflateSync(chunks.get("IDAT")!);
  expect(raw.length).toBe((width + 1) * height); // 每行一个 filter 字节 + width 个灰度字节
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width + 1)]).toBe(0); // filter 恒为 0（不做行滤波）
    for (let x = 0; x < width; x++) {
      const v = raw[y * (width + 1) + 1 + x];
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

/** 把半块字符还原成模块矩阵：`█` 上下都浅、`▀` 上浅下深、`▄` 上深下浅、空格都深（qrTerminal 传的是 invert）。 */
function terminalModules(term: string): boolean[][] {
  const rows: boolean[][] = [];
  for (const line of stripVTControlCharacters(term).split("\n")) {
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const ch of line) {
      if (ch === "█") {
        top.push(false);
        bottom.push(false);
      } else if (ch === "▀") {
        top.push(false);
        bottom.push(true);
      } else if (ch === "▄") {
        top.push(true);
        bottom.push(false);
      } else if (ch === " ") {
        top.push(true);
        bottom.push(true);
      } else {
        throw new Error(`意外的终端二维码字符：${JSON.stringify(ch)}`);
      }
    }
    rows.push(top, bottom);
  }
  return rows;
}

/** 模块矩阵 → RGBA（scale 放大、四周补 4 模块静区）。 */
function toRgba(
  modules: boolean[][],
  scale = 6,
  quiet = 4,
): { data: Uint8ClampedArray; width: number; height: number } {
  const n = modules.length;
  const width = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + quiet) * scale + dy) * width + (x + quiet) * scale + dx) * 4;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
          data[i + 3] = 255;
        }
      }
    }
  }
  return { data, width, height: width };
}

const URLS = {
  短链接: "https://liteapp.weixin.qq.com/q/7-GXWb1UY7kQ",
  长链接: `https://liteapp.weixin.qq.com/q/${"a1b2c3d4e5".repeat(12)}`,
  中文: `https://example.com/登录?token=${"扫我".repeat(20)}`,
};

describe("qrPng", () => {
  it.each(Object.entries(URLS))("%s：PNG 结构合法，且能解回原文", (_label, url) => {
    const png = qrPng(url, { size: 480 });
    const img = pngToRgba(png);
    expect(img.width).toBe(480);
    expect(jsQR(img.data, img.width, img.height)?.data).toBe(url);
  });

  it("尺寸按参数走（MCP 登录用 400，CLI 用 480）", () => {
    expect(pngToRgba(qrPng(URLS.短链接, { size: 400 })).width).toBe(400);
    expect(pngToRgba(qrPng(URLS.短链接)).width).toBe(480); // 默认值
  });

  it("留白：静区是白色，且不吞掉二维码本身", () => {
    const size = 240;
    const img = pngToRgba(qrPng(URLS.短链接, { size, margin: 2 }));
    const at = (x: number, y: number) => img.data[(y * size + x) * 4];
    expect(at(0, 0)).toBe(255); // 左上角在静区里
    expect(at(size - 1, size - 1)).toBe(255);
    let dark = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 0) dark++;
    expect(dark).toBeGreaterThan(0);
  });
});

describe("qrTerminal", () => {
  it("白底黑字的 ANSI 包裹，半块字符能解回原文", () => {
    const url = URLS.短链接;
    const term = qrTerminal(url);
    expect(term.startsWith("\u001b[47m\u001b[30m")).toBe(true);
    expect(term.endsWith("\u001b[0m")).toBe(true);
    const img = toRgba(terminalModules(term));
    expect(jsQR(img.data, img.width, img.height)?.data).toBe(url);
  });

  it("一行两行模块：每行等宽，总高度与宽度只差半行（奇数版本的末行是白色）", () => {
    const lines = stripVTControlCharacters(qrTerminal(URLS.长链接)).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => l.length === lines[0].length)).toBe(true);
    const extra = lines.length * 2 - lines[0].length;
    expect(extra === 0 || extra === 1).toBe(true);
  });
});
