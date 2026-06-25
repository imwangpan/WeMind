import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { getUploadUrl, sendMessage, generateId } from "../api/client.js";
import { ILinkError } from "../api/error-codes.js";
import {
  MessageType,
  MessageState,
  MessageItemType,
  UploadMediaType,
  type ImageItem,
  type SendMessageReq,
} from "../api/types.js";

/**
 * 收图：从 iLink CDN 下载并 AES-128-ECB 解密图片。
 * 机制借鉴官方 Tencent/openclaw-weixin（MIT）的 cdn/pic-decrypt + cdn-url。
 */

const CDN_BASE_URL =
  process.env.WECHAT_CDN_BASE_URL?.trim() || "https://novac2c.cdn.weixin.qq.com/c2c";

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const d = createDecipheriv("aes-128-ecb", key, null); // PKCS7 默认
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

/** 解析图片 AES key → 16 字节。aeskey 为 hex；media.aes_key 为 base64（可能是 base64(hex 字符串)）。 */
export function resolveKey(img: ImageItem): Buffer | null {
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
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`image: CDN 下载失败 ${res.status}`);
  const ciphertext = Buffer.from(await res.arrayBuffer());
  return decryptAesEcb(ciphertext, key);
}

// ===== 发图：AES-128-ECB 加密 + CDN 上传 + 拼 image_item 发送 =====
// 机制借鉴官方 Tencent/openclaw-weixin（MIT）的 cdn/aes-ecb + cdn/upload + cdn/cdn-upload + messaging/send。

/** AES-128-ECB 加密（PKCS7 默认）。 */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const c = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([c.update(plaintext), c.final()]);
}

/** AES-128-ECB 密文大小（PKCS7 补齐到 16 字节边界）。 */
export function aesEcbPaddedSize(plaintextSize: number): number {
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
  const url =
    uploadFullUrl?.trim() ||
    (uploadParam
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
        signal: AbortSignal.timeout(30000),
      });
      if (res.status >= 400 && res.status < 500)
        throw new Error(`CDN 上传客户端错误 ${res.status}`); // 不重试
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

/** getUploadUrl + 加密上传，返回媒体引用所需信息。media_type 见 UploadMediaType。 */
async function uploadMediaBytes(params: {
  baseUrl: string;
  token?: string;
  to: string;
  data: Buffer;
  mediaType: number;
}): Promise<{ downloadParam: string; aeskeyHex: string; filesize: number; rawsize: number }> {
  const { baseUrl, token, to, data, mediaType } = params;
  const rawsize = data.length;
  const rawfilemd5 = createHash("md5").update(data).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = randomBytes(16).toString("hex");
  const aeskey = randomBytes(16);

  const up = await getUploadUrl({
    baseUrl,
    token,
    filekey,
    media_type: mediaType,
    to_user_id: to,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });
  const code = up.ret ?? up.errcode;
  if (code !== undefined && code !== 0) throw new ILinkError("getUploadUrl", code, up.errmsg);

  const downloadParam = await uploadBufferToCdn({
    buf: data,
    aeskey,
    filekey,
    uploadFullUrl: up.upload_full_url,
    uploadParam: up.upload_param,
  });
  return { downloadParam, aeskeyHex: aeskey.toString("hex"), filesize, rawsize };
}

/** 拼 CDN media 引用（消息里给接收方下载+解密用）。 */
function buildMediaRef(downloadParam: string, aeskeyHex: string) {
  return {
    encrypt_query_param: downloadParam,
    aes_key: Buffer.from(aeskeyHex).toString("base64"),
    encrypt_type: 1,
  };
}

export type MediaKind = "image" | "video" | "file";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);

/** 按文件名扩展名判定媒体类别（借鉴 wxclawbot media.ts classifyMedia）。其余一律按文件发送。 */
export function classifyMediaByName(name: string): MediaKind {
  const i = name.lastIndexOf(".");
  const ext = i >= 0 ? name.slice(i).toLowerCase() : "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return "file";
}

const UPLOAD_TYPE_BY_KIND: Record<MediaKind, number> = {
  image: UploadMediaType.IMAGE,
  video: UploadMediaType.VIDEO,
  file: UploadMediaType.FILE,
};

/** 主动发一张图片给用户（需 context_token，与发文本相同）。image 为图片明文 buffer。 */
export async function sendImage(params: {
  baseUrl: string;
  token?: string;
  to: string;
  image: Buffer;
  contextToken?: string;
}): Promise<void> {
  const { baseUrl, token, to, image, contextToken } = params;
  const { downloadParam, aeskeyHex, filesize } = await uploadMediaBytes({
    baseUrl,
    token,
    to,
    data: image,
    mediaType: UploadMediaType.IMAGE,
  });
  const req: SendMessageReq = {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: generateId("img"),
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [
        {
          type: MessageItemType.IMAGE,
          image_item: { media: buildMediaRef(downloadParam, aeskeyHex), mid_size: filesize },
        },
      ],
      context_token: contextToken,
    },
  };
  await sendMessage({ baseUrl, token, body: req });
}

/**
 * 主动发一个文件/视频/图片给用户（需 context_token）。
 * 类别按 fileName 扩展名自动判定（image/video/file），也可用 kind 显式指定。
 * 借鉴 wxclawbot media.ts 的类型识别与 item 组装；上传链路复用 WeMind 自有实现。
 */
export async function sendFile(params: {
  baseUrl: string;
  token?: string;
  to: string;
  data: Buffer;
  fileName: string;
  kind?: MediaKind;
  contextToken?: string;
}): Promise<void> {
  const { baseUrl, token, to, data, fileName, contextToken } = params;
  const kind = params.kind ?? classifyMediaByName(fileName);
  const { downloadParam, aeskeyHex, filesize, rawsize } = await uploadMediaBytes({
    baseUrl,
    token,
    to,
    data,
    mediaType: UPLOAD_TYPE_BY_KIND[kind],
  });
  const media = buildMediaRef(downloadParam, aeskeyHex);

  let item;
  if (kind === "image") {
    item = { type: MessageItemType.IMAGE, image_item: { media, mid_size: filesize } };
  } else if (kind === "video") {
    item = { type: MessageItemType.VIDEO, video_item: { media, video_size: filesize } };
  } else {
    item = {
      type: MessageItemType.FILE,
      file_item: { media, file_name: fileName, len: String(rawsize) },
    };
  }

  const req: SendMessageReq = {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: generateId("media"),
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [item],
      context_token: contextToken,
    },
  };
  await sendMessage({ baseUrl, token, body: req });
}
