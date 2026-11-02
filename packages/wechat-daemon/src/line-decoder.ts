import { StringDecoder } from "node:string_decoder";

/**
 * 按行切分 stdout 的增量解码器。
 * `Buffer.toString()` 逐 chunk 解码会在 UTF-8 多字节字符跨 chunk 时插入 U+FFFD——中文回复静默损坏；`StringDecoder` 会把不完整的字节序列留到下一段。
 * ACP 帧是换行分隔的 JSON，这里只负责「凑齐整行」，JSON 解析仍由调用方做（非 JSON 日志行要能跳过）。
 */
export class LineDecoder {
  private decoder = new StringDecoder("utf8");
  private buf = "";

  /** 喂一段 stdout，返回本次能完整切出的行（已 trim，空行丢弃）。 */
  push(chunk: Buffer): string[] {
    this.buf += this.decoder.write(chunk);
    const lines: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) lines.push(line);
    }
    return lines;
  }

  /** 进程重建时丢弃半截行与未完成的多字节序列。 */
  reset(): void {
    this.decoder = new StringDecoder("utf8");
    this.buf = "";
  }
}
