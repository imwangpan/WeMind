import { describe, expect, it } from "vitest";

import {
  applyMediaToPrompt,
  BRAIN_UNSUPPORTED_IMAGE_NOTE,
  WORKER_UNSUPPORTED_IMAGE_NOTE,
} from "./prompt-media.js";

describe("applyMediaToPrompt（brain / worker 共用的图片注入）", () => {
  it("无图：不动 prompt", () => {
    const prompt: unknown[] = [{ type: "text", text: "hi" }];
    applyMediaToPrompt(prompt, undefined, true);
    applyMediaToPrompt(prompt, [], false);
    expect(prompt).toEqual([{ type: "text", text: "hi" }]);
  });

  it("支持图片：按顺序逐张推 image block", () => {
    const prompt: unknown[] = [];
    applyMediaToPrompt(
      prompt,
      [
        { data: "A", mimeType: "image/png" },
        { data: "B", mimeType: "image/jpeg" },
      ],
      true,
    );
    expect(prompt).toEqual([
      { type: "image", mimeType: "image/png", data: "A" },
      { type: "image", mimeType: "image/jpeg", data: "B" },
    ]);
  });

  it("不支持图片：推降级提示（默认给 brain 的文案）", () => {
    const prompt: unknown[] = [];
    applyMediaToPrompt(prompt, [{ data: "A", mimeType: "image/png" }], false);
    expect(prompt).toEqual([{ type: "text", text: BRAIN_UNSUPPORTED_IMAGE_NOTE }]);
  });

  it("不支持图片：可用 opts.unsupportedNote 换成 worker 文案", () => {
    const prompt: unknown[] = [];
    applyMediaToPrompt(prompt, [{ data: "A", mimeType: "image/png" }], false, {
      unsupportedNote: WORKER_UNSUPPORTED_IMAGE_NOTE,
    });
    expect(prompt).toEqual([{ type: "text", text: WORKER_UNSUPPORTED_IMAGE_NOTE }]);
  });
});
