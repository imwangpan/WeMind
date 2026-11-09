import { afterEach, describe, expect, it, vi } from "vitest";

import { pcmToWav, silkToWav, VOICE_SAMPLE_RATE } from "./voice.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pcmToWav", () => {
  it("生成合法 WAV 头（RIFF/WAVE/fmt/data、单声道 16-bit）", () => {
    const pcm = Buffer.from([0x01, 0x00, 0x02, 0x00]);
    const wav = pcmToWav(pcm, 16_000);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.subarray(12, 16).toString()).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(28)).toBe(32_000); // byte rate
    expect(wav.readUInt16LE(32)).toBe(2); // block align
    expect(wav.readUInt16LE(34)).toBe(16); // bits
    expect(wav.subarray(36, 40).toString()).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44)).toEqual(pcm);
  });

  it("默认采样率 24kHz；空 PCM 也生成 44 字节头", () => {
    const wav = pcmToWav(new Uint8Array(0));
    expect(wav).toHaveLength(44);
    expect(wav.readUInt32LE(24)).toBe(VOICE_SAMPLE_RATE);
  });
});

describe("silkToWav", () => {
  it("非法 SILK 返回 null（调用方保存原始文件），不抛出", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(silkToWav(Buffer.from("not silk"))).resolves.toBeNull();
  });
});
