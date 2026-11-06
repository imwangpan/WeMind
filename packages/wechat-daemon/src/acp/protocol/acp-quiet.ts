/**
 * 等 ACP agent 的异步帧流安静下来（`session/load` 之后的历史回放用）。
 *
 * gemini 的 `loadSession` 先返回、再异步 `streamHistory`（源码里不 await）：回放帧会在下一轮 `prompt` 前到达，
 * 混进本轮答复（实测 load 返回约 11ms 后开始回放）。恢复会话后先等「连续 quietMs 没有新帧」再提问；
 * `maxMs` 封顶，避免 agent 持续发帧（心跳/usage）时把回合卡死。
 */
export async function waitForFrameQuiet(opts: {
  seq: () => number;
  quietMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<{ frames: number; timedOut: boolean }> {
  const quietMs = opts.quietMs ?? 200;
  const maxMs = opts.maxMs ?? 3000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const start = now();
  const first = opts.seq();
  let seen = first;
  while (now() - start < maxMs) {
    await sleep(quietMs);
    const cur = opts.seq();
    if (cur === seen) return { frames: cur - first, timedOut: false };
    seen = cur;
  }
  return { frames: seen - first, timedOut: true };
}
