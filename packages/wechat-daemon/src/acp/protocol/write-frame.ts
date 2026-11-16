import type { Writable } from "node:stream";

/**
 * 写一帧 JSON-RPC。写入失败（EPIPE / 进程已退出）必须回给调用方，不能在 stdin 上留下未监听的
 * error 事件——否则 Node 会直接把 CLI 打崩。
 */
export function writeAcpFrame(
  stream: Pick<Writable, "writable" | "write">,
  payload: unknown,
  onError?: (error: Error) => void,
): boolean {
  if (!stream.writable) {
    onError?.(new Error("stdin 不可写"));
    return false;
  }
  try {
    stream.write(JSON.stringify(payload) + "\n", (error) => {
      if (error) onError?.(error);
    });
    return true;
  } catch (e) {
    onError?.(e instanceof Error ? e : new Error(String(e)));
    return false;
  }
}
