import { describe, it, expect } from "vitest";

import type { ImageItem } from "../api/types.js";
import {
  resolveKey,
  aesEcbPaddedSize,
  encryptAesEcb,
  decryptAesEcb,
  classifyMediaByName,
} from "./image.js";

const HEX32 = "00112233445566778899aabbccddeeff"; // 32 hex chars = 16 bytes

function img(o: { aeskey?: string; media?: { aes_key?: string } }): ImageItem {
  return o as unknown as ImageItem;
}

describe("resolveKey", () => {
  it("aeskey 为 32 位 hex → 解析成 16 字节", () => {
    const key = resolveKey(img({ aeskey: HEX32 }));
    expect(key).not.toBeNull();
    expect(key?.length).toBe(16);
    expect(key?.toString("hex")).toBe(HEX32);
  });

  it("media.aes_key 为 16 原始字节的 base64 → 直接用", () => {
    const raw = Buffer.from("0123456789abcdef", "utf-8"); // 16 bytes
    const key = resolveKey(img({ media: { aes_key: raw.toString("base64") } }));
    expect(key?.length).toBe(16);
    expect(key?.equals(raw)).toBe(true);
  });

  it("media.aes_key 为 base64(hex 字符串) → 当作 hex 再解析成 16 字节", () => {
    const b64 = Buffer.from(HEX32, "utf-8").toString("base64"); // decoded 是 32 字节的 hex ascii
    const key = resolveKey(img({ media: { aes_key: b64 } }));
    expect(key?.length).toBe(16);
    expect(key?.toString("hex")).toBe(HEX32);
  });

  it("aeskey 优先于 media.aes_key", () => {
    const allF = "ffffffffffffffffffffffffffffffff";
    const key = resolveKey(img({ aeskey: allF, media: { aes_key: "garbage" } }));
    expect(key?.toString("hex")).toBe(allF);
  });

  it("缺失或非法 → null", () => {
    expect(resolveKey(img({}))).toBeNull();
    expect(resolveKey(img({ aeskey: "tooshort" }))).toBeNull();
    // decoded 长度既非 16 也非 32
    const weird = Buffer.from("abc", "utf-8").toString("base64");
    expect(resolveKey(img({ media: { aes_key: weird } }))).toBeNull();
  });
});

describe("aesEcbPaddedSize (PKCS7 补齐到 16 边界)", () => {
  it.each([
    [0, 16],
    [1, 16],
    [15, 16],
    [16, 32],
    [17, 32],
    [31, 32],
    [32, 48],
  ])("明文 %i 字节 → 密文 %i 字节", (input, expected) => {
    expect(aesEcbPaddedSize(input)).toBe(expected);
  });
});

describe("encryptAesEcb / decryptAesEcb 往返", () => {
  it("各长度明文加密后能原样解密，且密文大小符合 PKCS7", () => {
    const key = Buffer.from("0123456789abcdef", "utf-8"); // 16 bytes
    for (const len of [0, 1, 15, 16, 17, 100, 256]) {
      const plain = Buffer.alloc(len);
      for (let i = 0; i < len; i++) plain[i] = (i * 31 + 7) & 0xff;
      const enc = encryptAesEcb(plain, key);
      expect(enc.length).toBe(aesEcbPaddedSize(len));
      const dec = decryptAesEcb(enc, key);
      expect(dec.equals(plain)).toBe(true);
    }
  });
});

describe("classifyMediaByName", () => {
  it("图片扩展名（大小写无关）", () => {
    for (const n of ["a.png", "x.JPG", "y.jpeg", "z.gif", "w.webp", "b.bmp"])
      expect(classifyMediaByName(n)).toBe("image");
  });
  it("视频扩展名", () => {
    for (const n of ["a.mp4", "b.MOV", "c.webm", "d.mkv", "e.avi"])
      expect(classifyMediaByName(n)).toBe("video");
  });
  it("其它一律按文件", () => {
    for (const n of ["a.txt", "b.pdf", "noext", "c.zip", "x."])
      expect(classifyMediaByName(n)).toBe("file");
  });
});
