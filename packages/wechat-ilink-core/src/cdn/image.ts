import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { getUploadUrl, sendMessage, generateId } from "../api/client.js";
import { MessageType, MessageState, MessageItemType, UploadMediaType, type ImageItem, type SendMessageReq } from "../api/types.js";

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

// ===== 发图：AES-128-ECB 加密 + CDN 上传 + 拼 image_item 发送 =====
// 机制借鉴官方 Tencent/openclaw-weixin（MIT）的 cdn/aes-ecb + cdn/upload + cdn/cdn-upload + messaging/send。

/** AES-128-ECB 加密（PKCS7 默认）。 */
function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const c = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([c.update(plaintext), c.final()]);
}

/** AES-128-ECB 密文大小（PKCS7 补齐到 16 字节边界）。 */
function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/** 加密并上传一段 buffer 到 CDN，返回下载用的 encrypt_query_param（响应头 x-encrypted-param）。 */
async function uploadBufferToCdn(params: {
  buf: Buffer;
  aeskey: Buffer;
  filekey: string;
  uploadFullUrl?: string;
  uploadParam?: string;
}): Promise<string> {
  const { buf, aeskey, filekey, uploadFullUrl, uploadParam } = params;
  const ciphertext = encryptAesEcb(buf, aeskey);
  const url = uploadFullUrl?.trim()
    || (uploadParam
      ? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
      : "");
  if (!url) throw new Error("upload: 无 upload_full_url/upload_param");
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (res.status >= 400 && res.status < 500) throw new Error(`CDN 上传客户端错误 ${res.status}`); // 不重试
      if (res.status !== 200) throw new Error(`CDN 上传服务端错误 ${res.status}`);
      const dp = res.headers.get("x-encrypted-param");
      if (!dp) throw new Error("CDN 上传响应缺 x-encrypted-param");
      return dp;
    } catch (e) {
      lastErr = e;
      if (e instanceof Error && e.message.includes("客户端错误")) throw e;
      if (attempt < 3) continue;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("CDN 上传失败");
}

/** 主动发一张图片给用户（需 context_token，与发文本相同）。image 为图片明文 buffer。 */
export async function sendImage(params: {
  baseUrl: string;
  token?: string;
  to: string;
  image: Buffer;
  contextToken?: string;
}): Promise<void> {
  const { baseUrl, token, to, image, contextToken } = params;
  const rawsize = image.length;
  const rawfilemd5 = createHash("md5").update(image).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = randomBytes(16).toString("hex");
  const aeskey = randomBytes(16);

  const up = await getUploadUrl({
    baseUrl, token, filekey, media_type: UploadMediaType.IMAGE, to_user_id: to,
    rawsize, rawfilemd5, filesize, no_need_thumb: true, aeskey: aeskey.toString("hex"),
  });
  const code = up.ret ?? up.errcode;
  if (code !== undefined && code !== 0) throw new Error(`getUploadUrl rejected: ret=${code}${up.errmsg ? ` (${up.errmsg})` : ""}`);

  const downloadParam = await uploadBufferToCdn({
    buf: image, aeskey, filekey,
    uploadFullUrl: up.upload_full_url, uploadParam: up.upload_param,
  });

  const req: SendMessageReq = {
    msg: {
      from_user_id: "", to_user_id: to, client_id: generateId("img"),
      message_type: MessageType.BOT, message_state: MessageState.FINISH,
      item_list: [{
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: downloadParam,
            aes_key: Buffer.from(aeskey.toString("hex")).toString("base64"),
            encrypt_type: 1,
          },
          mid_size: filesize,
        },
      }],
      context_token: contextToken,
    },
  };
  await sendMessage({ baseUrl, token, body: req });
}
