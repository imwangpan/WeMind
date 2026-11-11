import { describe, expect, it, vi } from "vitest";
import { createRepeatLog } from "./repeat-log.js";

describe("createRepeatLog（重复错误节流）", () => {
  it("第一次立即报，之后直到第 every 次才再报一条带计数", () => {
    const report = vi.fn();
    const log = createRepeatLog(report, 3);
    log.error("fetch failed");
    expect(report).toHaveBeenCalledTimes(1);
    log.error("fetch failed");
    log.error("fetch failed");
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith("fetch failed（连续 3 次）", "error");
    expect(log.count).toBe(3);
  });

  it("第 every+1 次重新开始静默，只有到 2*every 才再报", () => {
    const report = vi.fn();
    const log = createRepeatLog(report, 2);
    for (let i = 0; i < 4; i++) log.error("e");
    expect(report.mock.calls.map((c) => c[0])).toEqual(["e", "e（连续 2 次）", "e（连续 4 次）"]);
    expect(report.mock.calls.every((c) => c[1] === "error")).toBe(true);
  });

  it("成功时补一条恢复日志并清零，下次失败重新算第一次", () => {
    const report = vi.fn();
    const log = createRepeatLog(report, 60);
    log.error("a");
    log.error("b");
    log.success();
    expect(report).toHaveBeenLastCalledWith("recovered after 2 consecutive errors", "recovery");
    expect(log.count).toBe(0);
    log.error("c");
    expect(report).toHaveBeenLastCalledWith("c", "error");
  });

  it("没有失败过的成功不产生任何日志", () => {
    const report = vi.fn();
    createRepeatLog(report).success();
    expect(report).not.toHaveBeenCalled();
  });

  it("默认每 60 次报一条：连续 120 次失败只写 3 行", () => {
    const report = vi.fn();
    const log = createRepeatLog(report);
    for (let i = 0; i < 120; i++) log.error("fetch failed");
    expect(report).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenLastCalledWith("fetch failed（连续 120 次）", "error");
  });
});
