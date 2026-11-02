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

export interface ExtractedImage {
  src: string;
}

export type ImageFailureReason = "download" | "send" | "budget";

export interface ImageFailure {
  src: string;
  reason: ImageFailureReason;
}

/** 图片也占一条连发额度；始终给最终文字留最后一条。 */
export function canSendImage(sentCount: number, limit: number): boolean {
  return sentCount < limit - 1;
}

/** 把发图失败按原因归类成给用户的附注（下载失败、发送失败、额度不足各说各的）；没有失败返回空串。 */
export function imageFailureNote(failures: ImageFailure[]): string {
  if (failures.length === 0) return "";
  const labels: Record<ImageFailureReason, string> = {
    download: "没能下载下来",
    send: "没能发出去",
    budget: "因接近微信连续发送上限没发",
  };
  const order: ImageFailureReason[] = ["download", "send", "budget"];
  return order
    .map((reason) => {
      const items = failures.filter((f) => f.reason === reason).map((f) => f.src);
      return items.length
        ? `（有 ${items.length} 张图片${labels[reason]}，附原链接：\n${items.join("\n")}）`
        : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export function extractImages(text: string): { images: ExtractedImage[]; text: string } {
  const images: ExtractedImage[] = [];
  const seen = new Set<string>();
  const push = (src: string) => {
    const s = src.trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      images.push({ src: s });
    }
  };

  let out = text ?? "";
  // A/B：Markdown 图片 ![alt](src "title"?)
  out = out.replace(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, src: string) => {
    push(src);
    return "";
  });
  // C：裸图片 URL（排除 markdown 链接/图片里的，即前面不是 `(`）
  out = out.replace(
    /(?<!\()(https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp|bmp)(?:\?[^\s)]*)?)/gi,
    (m: string) => {
      push(m);
      return "";
    },
  );

  out = out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { images, text: out };
}

/** 把图片引用解析成字节：http(s) 下载，或本地文件读取。带大小/类型校验。 */
export async function resolveImageBytes(src: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src, {
      signal: AbortSignal.timeout(15000),
      // 不少图床（pixabay 等）对无 UA 的直链返回 403，带上浏览器 UA 规避热链拦截
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) throw new Error(`下载图片失败 ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error(`图片过大 ${buf.length}`);
    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/") && !IMG_EXT.test(src)) throw new Error(`非图片内容(${ct})`);
    return buf;
  }
  const p = src.startsWith("file://") ? fileURLToPath(src) : src;
  if (!IMG_EXT.test(p)) throw new Error(`非图片文件（仅按图片扩展名发送）: ${p}`);
  const stat = fs.statSync(p);
  if (!stat.isFile()) throw new Error("不是文件");
  if (stat.size > MAX_BYTES) throw new Error(`图片过大 ${stat.size}`);
  return fs.readFileSync(p);
}
