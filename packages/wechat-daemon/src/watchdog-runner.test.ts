import { describe, it, expect } from "vitest";

import { nextRestartBudget } from "./watchdog-runner.js";

describe("nextRestartBudget（后台守护进程的重启上限）", () => {
  it("短暂运行就崩 → 连续计数；超过上限停止重拉", () => {
    expect(nextRestartBudget(0, 1000, 2)).toEqual({ crashes: 1, stop: false });
    expect(nextRestartBudget(1, 1000, 2)).toEqual({ crashes: 2, stop: false });
    expect(nextRestartBudget(2, 1000, 2)).toEqual({ crashes: 3, stop: true });
  });

  it("这次跑满 10 分钟视为稳定 → 计数清零后再从 1 开始", () => {
    expect(nextRestartBudget(50, 10 * 60 * 1000, 50)).toEqual({ crashes: 1, stop: false });
  });

  it("默认上限 50（与 pm2 对齐）", () => {
    expect(nextRestartBudget(49, 0).stop).toBe(false);
    expect(nextRestartBudget(50, 0).stop).toBe(true);
  });
});
