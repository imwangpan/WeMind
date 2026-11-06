import { describe, it, expect } from "vitest";

import { finishPollBatch } from "./poller-batch.js";

describe("poller 批次收尾", () => {
  it("先唤醒 worker 再持久化：保存失败不影响已入队的消息", () => {
    const calls: string[] = [];
    const err = finishPollBatch(
      true,
      () => {
        calls.push("save");
        throw new Error("disk full");
      },
      () => calls.push("wake"),
    );
    expect(calls).toEqual(["wake", "save"]);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("disk full");
  });

  it("没有新消息就不唤醒；保存成功返回 undefined", () => {
    const calls: string[] = [];
    const err = finishPollBatch(
      false,
      () => calls.push("save"),
      () => calls.push("wake"),
    );
    expect(calls).toEqual(["save"]);
    expect(err).toBeUndefined();
  });
});
