import { createDecipheriv } from "node:crypto";

import type { ImageItem } from "../api/types.js";

/**
 * 收图：从 iLink CDN 下载并 AES-128-ECB 解密图片。
 * 机制借鉴官方 Tencent/openclaw-weixin（MIT）的 cdn/pic-decrypt + cdn-url。
 */

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const d = createDecipheriv("aes-128-ecb", key, null); // PKCS7 默认
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

/** 解析图片 AES key → 16 字节。aeskey 为 hex；media.aes_key 为 base64（可能是 base64(hex 字符串)）。 */
function resolveKey(img: ImageItem): Buffer | null {
  if (img.aeskey && /^[0-9a-fA-F]{32}$/.test(img.aeskey)) return Buffer.from(img.aeskey, "hex");
  const b64 = img.media?.aes_key;
  if (b64) {
    const decoded = Buffer.from(b64, "base64");
    if (decoded.length === 16) return decoded;
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
      return Buffer.from(decoded.toString("ascii"), "hex");
    }
  }
  return null;
}

/** 下载并解密一张图片，返回明文 Buffer（失败抛错）。 */
export async function downloadImage(img: ImageItem): Promise<Buffer> {
  const url =
    img.media?.full_url ||
    (img.media?.encrypt_query_param
      ? `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(img.media.encrypt_query_param)}`
      : "");
  if (!url) throw new Error("image: 无 full_url/encrypt_query_param");
  const key = resolveKey(img);
  if (!key) throw new Error("image: 无法解析 aes key");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image: CDN 下载失败 ${res.status}`);
  const ciphertext = Buffer.from(await res.arrayBuffer());
  return decryptAesEcb(ciphertext, key);
}
