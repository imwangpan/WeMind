import { deflateSync } from "node:zlib";
import { encode as encodeQr, renderUnicodeCompact } from "uqr";

/**
 * 扫码登录用的二维码渲染：文本 → 二维码矩阵 → PNG 图片 / 终端半块字符。
 *
 * ## 为什么自己编码 PNG
 * 只需要「8 位灰度、无透明、deflate 压缩」这一种最简形态，`node:zlib` 就够用；为了这点需求引入带 PNG 编码器的依赖不划算——qrcode 1.5.4 为它自己的 CLI 拖进 yargs@15，整棵子树 29 个包、约 1.66MB，而本项目只用到 `toFile` + `toString` 两种渲染。
 * 这里只写 IHDR / IDAT / IEND 三个块；单测会把产物解码回原文（`qr.test.ts`），编码器写坏了不会等到用户扫不出来才发现。
 *
 * ## 为什么终端码要包 ANSI 白底
 * 二维码是「深色模块 + 浅色静区」，而终端主题（深色 / 浅色背景）决定同一份字符看起来是正色还是反色。原来的 qrcode `type: "terminal"` 内部强制白底黑字（`\x1b[47m\x1b[30m`），这里保持同样的外观：uqr 默认按深色终端渲染（把**白**模块填成 `█`），配 `invert: true` 才是「深模块填块」。
 *
 * ## 纠错级别固定 M
 * 与原 qrcode 的默认值一致（手机近距离扫屏幕足够）。注意 uqr 的默认纠错级别是 L，不能省略。
 */

/** 静区模块数默认值：与原 qrcode 调用的 `margin: 2` 一致。 */
const DEFAULT_MARGIN = 2;

/** 纠错级别：与原 qrcode 默认值一致（uqr 默认是 L）。 */
const ECC = "M" as const;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG 用的 CRC32 查表（多项式 0xedb88320），模块加载时建一次。 */
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32(buf: Buffer): number {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 一个 PNG 块：长度（4 字节）+ 类型（4 字节）+ 数据 + 前两者的 CRC32。 */
function pngChunk(type: "IHDR" | "IDAT" | "IEND", data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

export interface QrImageOptions {
  /** 输出边长（像素），默认 480。 */
  size?: number;
  /** 静区模块数，默认 2。 */
  margin?: number;
}

/**
 * 渲染二维码 PNG（8 位灰度）：`size × size` 像素，四周留 `margin` 个模块的白色静区。
 * 模块按小数比例铺满整张图（与原 qrcode 的 `width` 行为一致），所以任何 `size` 都能得到正方形图片。
 */
export function qrPng(text: string, opts: QrImageOptions = {}): Buffer {
  const size = Math.max(1, Math.floor(opts.size ?? 480));
  const margin = Math.max(0, Math.floor(opts.margin ?? DEFAULT_MARGIN));
  const qr = encodeQr(text, { ecc: ECC, border: 0 });
  const scale = size / (qr.size + margin * 2); // 每个模块占多少像素（可为小数）
  const rowBytes = size + 1; // 每行 = 1 字节 filter（0 = 不滤波）+ size 字节灰度
  const raw = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    const my = Math.floor(y / scale) - margin;
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - margin;
      const dark = mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.data[my][mx];
      raw[y * rowBytes + 1 + x] = dark ? 0x00 : 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // 宽
  ihdr.writeUInt32BE(size, 4); // 高
  ihdr[8] = 8; // 位深
  ihdr[9] = 0; // 颜色类型 0 = 灰度
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * 渲染终端二维码：半块字符（`▀`/`▄`/`█`/空格）一行两行模块，外面包白底黑字的 ANSI 序列。
 * 返回值不带结尾换行，与 qrcode 的 `toString({ type: "terminal", small: true })` 一致。
 */
export function qrTerminal(text: string, opts: { margin?: number } = {}): string {
  const margin = Math.max(0, Math.floor(opts.margin ?? DEFAULT_MARGIN));
  const body = renderUnicodeCompact(text, { ecc: ECC, border: margin, invert: true });
  return `\u001b[47m\u001b[30m${body}\u001b[0m`;
}
