import { describe, it, expect } from "vitest";

import { waitForFrameQuiet } from "./acp-quiet.js";

/** 可控时钟：sleep 推进时间，seq 按时间给帧计数（避免真实定时器带来的抖动）。 */
function clock(seqAt: (t: number) => number) {
  let t = 0;
  return {
    sleep: async (ms: number) => {
      t += ms;
    },
    now: () => t,
    seq: () => seqAt(t),
    get time() {
      return t;
    },
  };
}

describe("waitForFrameQuiet", () => {
  it("没有新帧：一个 quiet 窗口后就返回（不为普通 agent 付额外等待）", async () => {
    const c = clock(() => 0);
    const r = await waitForFrameQuiet({
      seq: c.seq,
      sleep: c.sleep,
      now: c.now,
      quietMs: 200,
      maxMs: 3000,
    });
    expect(r).toEqual({ frames: 0, timedOut: false });
    expect(c.time).toBe(200);
  });

  it("回放帧持续到达时延长等待，安静后返回并给出帧数", async () => {
    const c = clock((t) => (t >= 400 ? 4 : t));
    const r = await waitForFrameQuiet({
      seq: c.seq,
      sleep: c.sleep,
      now: c.now,
      quietMs: 200,
      maxMs: 3000,
    });
    expect(r).toEqual({ frames: 4, timedOut: false });
    expect(c.time).toBe(600);
  });

  it("帧一直不停：到 maxMs 上限返回 timedOut（不把回合卡死）", async () => {
    const c = clock((t) => t);
    const r = await waitForFrameQuiet({
      seq: c.seq,
      sleep: c.sleep,
      now: c.now,
      quietMs: 200,
      maxMs: 1000,
    });
    expect(r.timedOut).toBe(true);
    expect(c.time).toBe(1000);
  });
});
