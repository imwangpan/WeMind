/** 微信语音为 SILK；微信没有转写时，尽量转成 WAV 交给大脑的文件工具处理。 */

/** 微信语音常见采样率；silk-wasm 解码固定用它。 */
export const VOICE_SAMPLE_RATE = 24_000;

/** 把 mono s16le PCM 包成 WAV（44 字节头）。 */
export function pcmToWav(pcm: Uint8Array, sampleRate: number = VOICE_SAMPLE_RATE): Buffer {
  const pcmBytes = pcm.byteLength;
  const totalSize = 44 + pcmBytes;
  const buf = Buffer.allocUnsafe(totalSize);
  let offset = 0;

  buf.write("RIFF", offset);
  offset += 4;
  buf.writeUInt32LE(totalSize - 8, offset);
  offset += 4;
  buf.write("WAVE", offset);
  offset += 4;

  buf.write("fmt ", offset);
  offset += 4;
  buf.writeUInt32LE(16, offset);
  offset += 4;
  buf.writeUInt16LE(1, offset); // PCM
  offset += 2;
  buf.writeUInt16LE(1, offset); // mono
  offset += 2;
  buf.writeUInt32LE(sampleRate, offset);
  offset += 4;
  buf.writeUInt32LE(sampleRate * 2, offset); // byte rate（mono 16-bit）
  offset += 4;
  buf.writeUInt16LE(2, offset); // block align
  offset += 2;
  buf.writeUInt16LE(16, offset); // bits per sample
  offset += 2;

  buf.write("data", offset);
  offset += 4;
  buf.writeUInt32LE(pcmBytes, offset);
  offset += 4;
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, offset);

  return buf;
}

/**
 * SILK → WAV。silk-wasm 未安装/解码失败时返回 null（调用方保存原始 SILK 并如实告知）。
 * 动态 import：只在真的收到无转写语音时才加载 WASM。
 */
export async function silkToWav(silk: Buffer): Promise<Buffer | null> {
  try {
    const { decode } = await import("silk-wasm");
    const result = await decode(silk, VOICE_SAMPLE_RATE);
    return pcmToWav(result.data, VOICE_SAMPLE_RATE);
  } catch (e) {
    console.error("[wemind/wechat-daemon] silkToWav failed:", String(e));
    return null;
  }
}
