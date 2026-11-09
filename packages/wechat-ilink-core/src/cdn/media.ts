import { CDN_BASE_URL, decryptAesEcb, readBodyWithLimit } from "./image.js";
import type { CDNMedia } from "../api/types.js";

/**
 * 通用入站媒体下载（图片/语音/文件/视频）。
 * 与图片同一套 CDN + AES-128-ECB 机制，区别只在 key 的来源和大小上限：
 *  - 图片：image_item.aeskey（hex）优先，其次 media.aes_key；
 *  - 语音/文件/视频：只有 media.aes_key（base64 原始 16 字节，或 base64(hex32)）。
 */
export const MAX_INCOMING_MEDIA_BYTES =
  (Number(process.env.WECHAT_INBOUND_MEDIA_MAX_MB) || 100) * 1024 * 1024;

/** 解析通用 CDN media 的 AES key；返回原始 16 字节，无法解析返回 null。 */
export function resolveMediaKey(media: CDNMedia | undefined, imageAeskey?: string): Buffer | null {
  if (imageAeskey && /^[0-9a-fA-F]{32}$/.test(imageAeskey)) return Buffer.from(imageAeskey, "hex");
  const b64 = media?.aes_key;
  if (!b64) return null;
  const decoded = Buffer.from(b64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  return null;
}

/** 拼 CDN 下载 URL（优先服务端给的 full_url）。 */
export function buildCdnDownloadUrl(media: CDNMedia | undefined): string {
  if (media?.full_url) return media.full_url;
  if (media?.encrypt_query_param)
    return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
  return "";
}

/**
 * 下载并解密一段入站媒体，返回明文 Buffer。
 * `allowPlain` 为 true 时，没有 key 就按未加密内容返回（官方图片下载的行为）。
 */
export async function downloadMediaBuffer(params: {
  media: CDNMedia | undefined;
  imageAeskey?: string;
  maxBytes?: number;
  label?: string;
  allowPlain?: boolean;
  timeoutMs?: number;
}): Promise<Buffer> {
  const label = params.label ?? "media";
  const url = buildCdnDownloadUrl(params.media);
  if (!url) throw new Error(`${label}: 无 full_url/encrypt_query_param`);
  const key = resolveMediaKey(params.media, params.imageAeskey);
  if (!key && !params.allowPlain) throw new Error(`${label}: 无法解析 aes key`);
  const maxBytes = params.maxBytes ?? MAX_INCOMING_MEDIA_BYTES;

  const res = await fetch(url, { signal: AbortSignal.timeout(params.timeoutMs ?? 30000) });
  if (!res.ok) throw new Error(`${label}: CDN 下载失败 ${res.status}`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error(`${label}: CDN 媒体过大 ${declared}`);
  const body = await readBodyWithLimit(res.body, maxBytes);
  return key ? decryptAesEcb(body, key) : body;
}
