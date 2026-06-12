import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 从 brain 的文本回复里提取「要作为图片发送」的引用，并返回去掉这些引用后的纯文本。
 * 覆盖三种来源：
 *  A. Markdown 图片 `![alt](src)`，src 可为 http(s) URL 或本地绝对路径；
 *  B. brain 按约定输出的也是上述 Markdown 语法（见 acp-brain 注入的系统提示）；
 *  C. 回复中裸露的图片 URL（http(s) 且以图片扩展名结尾）。
 */

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)(\?[^\s)]*)?$/i;
const MAX_BYTES = 10 * 1024 * 1024;

export interface ExtractedImage { src: string; }

export function extractImages(text: string): { images: ExtractedImage[]; text: string } {
  const images: ExtractedImage[] = [];
  const seen = new Set<string>();
  const push = (src: string) => { const s = src.trim(); if (s && !seen.has(s)) { seen.add(s); images.push({ src: s }); } };

  let out = text ?? "";
  // A/B：Markdown 图片 ![alt](src "title"?)
  out = out.replace(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, src: string) => { push(src); return ""; });
  // C：裸图片 URL（排除 markdown 链接/图片里的，即前面不是 `(`）
  out = out.replace(/(?<!\()(https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp|bmp)(?:\?[^\s)]*)?)/gi, (m: string) => { push(m); return ""; });

  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { images, text: out };
}

/** 把图片引用解析成字节：http(s) 下载，或本地文件读取。带大小/类型校验。 */
export async function resolveImageBytes(src: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`下载图片失败 ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error(`图片过大 ${buf.length}`);
    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/") && !IMG_EXT.test(src)) throw new Error(`非图片内容(${ct})`);
    return buf;
  }
  const p = src.startsWith("file://") ? fileURLToPath(src) : src;
  const stat = fs.statSync(p);
  if (!stat.isFile()) throw new Error("不是文件");
  if (stat.size > MAX_BYTES) throw new Error(`图片过大 ${stat.size}`);
  return fs.readFileSync(p);
}
