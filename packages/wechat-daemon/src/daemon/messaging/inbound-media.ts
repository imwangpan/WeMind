import {
  createLogger,
  downloadImage,
  downloadMediaBuffer,
  MAX_INCOMING_MEDIA_BYTES,
} from "@wemind/wechat-ilink-core";

import type { InboundAttachment } from "../daemon-routing.js";
import { safeMediaFileName, saveInboundMedia } from "./media-store.js";
import { silkToWav } from "./voice.js";

/**
 * 入站附件下载与落盘（brain 与 worker 共用）。
 *
 * 图片解密后转成 `{data,mimeType}`（base64）交给 ACP 的 image block；文件/视频/无转写语音落盘，
 * 生成一段「本地路径」说明拼进 prompt。**每条消息的附件都能独立处理，失败只记账不抛**——
 * 一张图下载失败不该拖垮整条消息。
 */

const log = createLogger("wechat-daemon/inbound-media");

export interface PreparedMediaImage {
  data: string;
  mimeType: string;
}

export interface PreparedMedia {
  /** 可用的图片（base64）。 */
  images: PreparedMediaImage[];
  /** 文件/视频/语音的「本地路径」说明，拼进 prompt。 */
  notes: string[];
  /** 下载失败的附件标签（图片/文件名/视频/语音）。 */
  failures: string[];
  /** 本条消息带来的图片总数（含下载失败），用于 `planImageTurn`。 */
  imageCount: number;
  /** 本条消息带来的非图片附件数。 */
  otherCount: number;
}

/** 从解密后的字节嗅探图片 MIME。 */
export function sniffMime(b: Buffer): string {
  const h = b.subarray(0, 4).toString("hex");
  if (h.startsWith("89504e47")) return "image/png";
  if (h.startsWith("47494638")) return "image/gif";
  if (h.startsWith("52494646")) return "image/webp";
  return "image/jpeg";
}

function fmtBytes(n: number): string {
  return n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(n / 1024))}KB`;
}

/**
 * 下载并整理一条消息里的全部附件。
 * `onHint` 可选：收到附件时给用户的进度提示（如「📎 收到 N 个附件，下载中…」），由调用方决定怎么发。
 */
export async function prepareInboundMedia(
  attachments: InboundAttachment[],
  opts: { messageId: string; onHint?: (text: string) => void },
): Promise<PreparedMedia> {
  const messageId = opts.messageId;
  const imageItems = attachments
    .filter((a): a is Extract<InboundAttachment, { kind: "image" }> => a.kind === "image")
    .map((a) => a.item);
  const otherAttachments = attachments.filter((a) => a.kind !== "image");

  const images: PreparedMediaImage[] = [];
  const notes: string[] = [];
  const failures: string[] = [];

  if (attachments.length > 0 && opts.onHint) {
    if (imageItems.length && otherAttachments.length)
      opts.onHint(`📎 收到 ${attachments.length} 个附件，下载中…`);
    else if (imageItems.length) opts.onHint(`🖼️ 收到 ${imageItems.length} 张图片，下载识别中…`);
    else opts.onHint(`📎 收到 ${otherAttachments.length} 个附件，下载中…`);
  }

  for (const im of imageItems) {
    try {
      const buf = await downloadImage(im);
      images.push({ data: buf.toString("base64"), mimeType: sniffMime(buf) });
    } catch (e) {
      log.warn("image download failed:", String(e));
      failures.push("图片");
    }
  }

  for (const a of otherAttachments) {
    try {
      if (a.kind === "file") {
        const buf = await downloadMediaBuffer({
          media: a.item.media,
          maxBytes: MAX_INCOMING_MEDIA_BYTES,
          label: "file",
        });
        const name = safeMediaFileName(a.item.file_name, "file.bin");
        const saved = saveInboundMedia(buf, { messageId, fileName: name, kind: "file" });
        notes.push(
          `[用户发来文件] 名称: ${name}；大小: ${fmtBytes(buf.length)}；本地路径: ${saved}`,
        );
        log.info(`inbound file saved: ${saved} (${buf.length}B)`);
      } else if (a.kind === "video") {
        const buf = await downloadMediaBuffer({
          media: a.item.media,
          maxBytes: MAX_INCOMING_MEDIA_BYTES,
          label: "video",
        });
        const saved = saveInboundMedia(buf, { messageId, fileName: "video.mp4", kind: "video" });
        const dur = a.item.play_length ? `；时长: ${a.item.play_length}s` : "";
        notes.push(`[用户发来视频] 大小: ${fmtBytes(buf.length)}${dur}；本地路径: ${saved}`);
        log.info(`inbound video saved: ${saved} (${buf.length}B)`);
      } else {
        // 无微信转写的语音：下载后 SILK→WAV（有转写的语音在 extractInbound 里已作为文本，不会进附件）。
        const buf = await downloadMediaBuffer({
          media: a.item.media,
          maxBytes: MAX_INCOMING_MEDIA_BYTES,
          label: "voice",
        });
        const wav = await silkToWav(buf);
        const saved = saveInboundMedia(wav ?? buf, {
          messageId,
          fileName: wav ? "voice.wav" : "voice.silk",
          kind: "voice",
        });
        const dur = a.item.playtime ? `；时长: ${(a.item.playtime / 1000).toFixed(1)}s` : "";
        notes.push(
          `[用户发来语音] 格式: ${wav ? "audio/wav" : "audio/silk"}${dur}；本地路径: ${saved}；` +
            "微信没有提供转写，请用可用工具尽力理解；若无法读取音频，请如实告诉用户。",
        );
        log.info(`inbound voice saved: ${saved} (${buf.length}B${wav ? ", wav" : ", raw silk"})`);
      }
    } catch (e) {
      const label =
        a.kind === "file" ? a.item.file_name || "文件" : a.kind === "video" ? "视频" : "语音";
      log.warn(`inbound ${a.kind} download failed:`, label, String(e));
      failures.push(label);
    }
  }

  return {
    images,
    notes,
    failures,
    imageCount: imageItems.length,
    otherCount: otherAttachments.length,
  };
}

/**
 * 把正文与附件说明拼成给 agent 的指令文本（附件说明在正文之后）。
 * 正文为空时只留附件说明；两者都空返回空串（调用方用 `mediaInstructionFallback` 兜底）。
 */
export function composeAgentText(text: string, notes: string[]): string {
  return [text.trim(), notes.join("\n")].filter(Boolean).join("\n\n");
}

/** 正文为空时给 agent 的兜底指令：说清楚收到的是什么，让 agent 有据可依，而不是收到空 prompt。 */
export function mediaInstructionFallback(
  media: Pick<PreparedMedia, "imageCount" | "otherCount">,
): string {
  if (media.imageCount > 0 && media.otherCount === 0) return "（用户发来图片，请查看并回应）";
  if (media.imageCount === 0 && media.otherCount > 0) return "（用户发来附件，请查看并回应）";
  return "（用户发来图片和附件，请查看并回应）";
}

/** 结束待投递、要求立刻提交的关键词：只提交附件，不把这些字面话发给 worker。 */
export function isFlushWord(text: string): boolean {
  return /^(?:好了|就这样)$/.test((text ?? "").trim());
}
