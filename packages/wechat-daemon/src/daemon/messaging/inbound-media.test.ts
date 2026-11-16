import { beforeEach, describe, expect, it, vi } from "vitest";

const { downloadImage, downloadMediaBuffer, saveInboundMedia, silkToWav } = vi.hoisted(() => ({
  downloadImage: vi.fn(),
  downloadMediaBuffer: vi.fn(),
  saveInboundMedia: vi.fn(),
  silkToWav: vi.fn(),
}));

vi.mock("@wemind/wechat-ilink-core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  downloadImage,
  downloadMediaBuffer,
  MAX_INCOMING_MEDIA_BYTES: 1024,
}));
vi.mock("./media-store.js", () => ({
  mediaInboxDir: (role?: string) => `/inbox/${role ?? "brain"}`,
  safeMediaFileName: (name: string | undefined, fallback: string) => name || fallback,
  saveInboundMedia,
}));
vi.mock("./voice.js", () => ({ silkToWav }));

import type { InboundAttachment } from "../daemon-routing.js";

const { composeAgentText, isFlushWord, mediaInstructionFallback, prepareInboundMedia, sniffMime } =
  await import("./inbound-media.js");

const img = (id = "i1") =>
  ({ kind: "image", item: { media: { id } } }) as unknown as InboundAttachment;
const file = (name?: string) =>
  ({ kind: "file", item: { media: { id: "f" }, file_name: name } }) as unknown as InboundAttachment;
const video = (len?: number) =>
  ({
    kind: "video",
    item: { media: { id: "v" }, play_length: len },
  }) as unknown as InboundAttachment;
const voice = (playtime?: number) =>
  ({ kind: "voice", item: { media: { id: "a" }, playtime } }) as unknown as InboundAttachment;

beforeEach(() => {
  vi.clearAllMocks();
  saveInboundMedia.mockReturnValue("/media/saved.bin");
  silkToWav.mockResolvedValue(Buffer.from("wav"));
});

describe("sniffMime", () => {
  it("按魔数识别常见图片，其余按 jpeg", () => {
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png");
    expect(sniffMime(Buffer.from("GIF8"))).toBe("image/gif");
    expect(sniffMime(Buffer.from("RIFF"))).toBe("image/webp");
    expect(sniffMime(Buffer.from("...."))).toBe("image/jpeg");
  });
});

describe("composeAgentText", () => {
  it("正文在前、附件说明在后；空正文只留说明", () => {
    expect(composeAgentText("看这个", ["[文件] /a"])).toBe("看这个\n\n[文件] /a");
    expect(composeAgentText("", ["[文件] /a"])).toBe("[文件] /a");
    expect(composeAgentText("  hi  ", [])).toBe("hi");
    expect(composeAgentText("", [])).toBe("");
  });
});

describe("mediaInstructionFallback", () => {
  it("按图片/附件组合给不同兜底", () => {
    expect(mediaInstructionFallback({ imageCount: 2, otherCount: 0 })).toContain("图片");
    expect(mediaInstructionFallback({ imageCount: 0, otherCount: 1 })).toContain("附件");
    expect(mediaInstructionFallback({ imageCount: 1, otherCount: 1 })).toContain("图片和附件");
  });
});

describe("isFlushWord", () => {
  it("只认「好了」「就这样」（忽略首尾空白）", () => {
    expect(isFlushWord("好了")).toBe(true);
    expect(isFlushWord(" 就这样 ")).toBe(true);
    expect(isFlushWord("好")).toBe(false);
    expect(isFlushWord("这样")).toBe(false);
    expect(isFlushWord("")).toBe(false);
  });
});

describe("prepareInboundMedia", () => {
  it("没有附件：全空且不发提示", async () => {
    const hints: string[] = [];
    const r = await prepareInboundMedia([], { messageId: "m", onHint: (t) => hints.push(t) });
    expect(r).toEqual({ images: [], notes: [], failures: [], imageCount: 0, otherCount: 0 });
    expect(hints).toEqual([]);
  });

  it("图片：base64 + mimeType，提示只发一次", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
    downloadImage.mockResolvedValue(bytes);
    const hints: string[] = [];
    const r = await prepareInboundMedia([img()], { messageId: "m", onHint: (t) => hints.push(t) });
    expect(r.images).toEqual([{ data: bytes.toString("base64"), mimeType: "image/png" }]);
    expect(r.imageCount).toBe(1);
    expect(r.otherCount).toBe(0);
    expect(hints).toEqual(["🖼️ 收到 1 张图片，下载识别中…"]);
  });

  it("图片下载失败：只记 failures，不抛", async () => {
    downloadImage.mockRejectedValue(new Error("boom"));
    const r = await prepareInboundMedia([img(), img("i2")], { messageId: "m" });
    expect(r.images).toEqual([]);
    expect(r.failures).toEqual(["图片", "图片"]);
    expect(r.imageCount).toBe(2);
  });

  it("文件：落盘 + 说明里带路径和大小", async () => {
    downloadMediaBuffer.mockResolvedValue(Buffer.alloc(2048));
    const r = await prepareInboundMedia([file("a.txt")], { messageId: "m" });
    expect(saveInboundMedia).toHaveBeenCalledWith(
      Buffer.alloc(2048),
      { messageId: "m", fileName: "a.txt", kind: "file" },
      "/inbox/brain",
    );
    expect(r.notes).toEqual(["[用户发来文件] 名称: a.txt；大小: 2KB；本地路径: /media/saved.bin"]);
    expect(r.otherCount).toBe(1);
  });

  it("managed 下按角色落到各自的 media/inbound（worker 不写 brain-home）", async () => {
    downloadMediaBuffer.mockResolvedValue(Buffer.alloc(16));
    await prepareInboundMedia([file("a.txt")], { messageId: "m", role: "worker" });
    expect(saveInboundMedia).toHaveBeenCalledWith(
      Buffer.alloc(16),
      { messageId: "m", fileName: "a.txt", kind: "file" },
      "/inbox/worker",
    );
  });

  it("文件下载失败：failures 用文件名", async () => {
    downloadMediaBuffer.mockRejectedValue(new Error("404"));
    const r = await prepareInboundMedia([file("b.pdf")], { messageId: "m" });
    expect(r.failures).toEqual(["b.pdf"]);
    expect(r.notes).toEqual([]);
  });

  it("视频：说明带时长", async () => {
    downloadMediaBuffer.mockResolvedValue(Buffer.alloc(1024 * 1024));
    const r = await prepareInboundMedia([video(12)], { messageId: "m" });
    expect(r.notes[0]).toBe("[用户发来视频] 大小: 1.0MB；时长: 12s；本地路径: /media/saved.bin");
  });

  it("语音：silkToWav 成功用 wav；失败退回 silk", async () => {
    downloadMediaBuffer.mockResolvedValue(Buffer.alloc(100));
    const r = await prepareInboundMedia([voice(3000)], { messageId: "m" });
    expect(saveInboundMedia).toHaveBeenCalledWith(
      Buffer.from("wav"),
      { messageId: "m", fileName: "voice.wav", kind: "voice" },
      "/inbox/brain",
    );
    expect(r.notes[0]).toContain("格式: audio/wav；时长: 3.0s");
    expect(r.notes[0]).toContain("微信没有提供转写");

    silkToWav.mockResolvedValue(null);
    const r2 = await prepareInboundMedia([voice()], { messageId: "m" });
    expect(saveInboundMedia).toHaveBeenLastCalledWith(
      Buffer.alloc(100),
      { messageId: "m", fileName: "voice.silk", kind: "voice" },
      "/inbox/brain",
    );
    expect(r2.notes[0]).toContain("格式: audio/silk");
  });

  it("图片 + 文件混发：提示合并成「N 个附件」", async () => {
    downloadImage.mockResolvedValue(Buffer.from("GIF8"));
    downloadMediaBuffer.mockResolvedValue(Buffer.alloc(10));
    const hints: string[] = [];
    const r = await prepareInboundMedia([img(), file()], {
      messageId: "m",
      onHint: (t) => hints.push(t),
    });
    expect(hints).toEqual(["📎 收到 2 个附件，下载中…"]);
    expect(r.images[0].mimeType).toBe("image/gif");
    expect(r.imageCount).toBe(1);
    expect(r.otherCount).toBe(1);
  });
});
