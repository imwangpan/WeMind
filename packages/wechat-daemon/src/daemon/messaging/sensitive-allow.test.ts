import { afterEach, describe, expect, it } from "vitest";

import {
  armSensitiveAllow,
  pendingSensitiveCount,
  rememberPendingSensitive,
  resetPendingSensitive,
  resetSensitiveAllow,
  sensitiveAllowActive,
  sensitiveAllowRemainingMs,
  takePendingSensitive,
} from "./sensitive-allow.js";

afterEach(() => {
  resetSensitiveAllow();
  resetPendingSensitive();
});

describe("敏感文件临时放行窗口", () => {
  it("默认 2 分钟，窗口内生效、到期失效", () => {
    const t0 = 1_000_000;
    const { until, minutes } = armSensitiveAllow(undefined, t0);
    expect(minutes).toBe(2);
    expect(until).toBe(t0 + 2 * 60_000);
    expect(sensitiveAllowActive(t0)).toBe(true);
    expect(sensitiveAllowActive(until - 1)).toBe(true);
    expect(sensitiveAllowActive(until)).toBe(false);
    expect(sensitiveAllowRemainingMs(t0)).toBe(2 * 60_000);
    expect(sensitiveAllowRemainingMs(until + 5)).toBe(0);
  });

  it("分钟数夹到 1–30", () => {
    const t0 = 0;
    expect(armSensitiveAllow(0, t0).minutes).toBe(1);
    expect(armSensitiveAllow(-5, t0).minutes).toBe(1);
    expect(armSensitiveAllow(99, t0).minutes).toBe(30);
    expect(armSensitiveAllow(5, t0).minutes).toBe(5);
  });

  it("再次开启会覆盖旧窗口；reset 立即失效", () => {
    const t0 = 10_000;
    armSensitiveAllow(5, t0);
    const second = armSensitiveAllow(1, t0 + 60_000);
    expect(second.until).toBe(t0 + 60_000 + 60_000);
    resetSensitiveAllow();
    expect(sensitiveAllowActive(t0 + 60_001)).toBe(false);
  });
});

describe("待补发的敏感附件（先拦截、后放行）", () => {
  it("按用户隔离；取走后清空；同一路径去重", () => {
    const t0 = 5_000;
    rememberPendingSensitive("u1", [{ src: "file:///a/account.json", kind: "file" }], t0);
    rememberPendingSensitive("u1", [{ src: "file:///a/account.json" }], t0 + 1);
    rememberPendingSensitive("u2", [{ src: "file:///a/state.json" }], t0);

    expect(pendingSensitiveCount("u1", t0 + 2)).toBe(1);
    expect(pendingSensitiveCount("u2", t0 + 2)).toBe(1);

    const taken = takePendingSensitive("u1", t0 + 2);
    expect(taken).toEqual([{ src: "file:///a/account.json", kind: "file" }]);
    expect(pendingSensitiveCount("u1", t0 + 2)).toBe(0);
    // 另一个用户的队列不受影响
    expect(takePendingSensitive("u2", t0 + 2)).toEqual([{ src: "file:///a/state.json" }]);
  });

  it("30 分钟后过期，不再补发", () => {
    const t0 = 1_000;
    rememberPendingSensitive("u1", [{ src: "file:///a/account.json" }], t0);
    expect(pendingSensitiveCount("u1", t0 + 30 * 60_000)).toBe(1);
    expect(pendingSensitiveCount("u1", t0 + 30 * 60_000 + 1)).toBe(0);
    expect(takePendingSensitive("u1", t0 + 30 * 60_000 + 1)).toEqual([]);
  });

  it("每个用户最多留 20 条（丢最旧的）", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ src: `file:///f/${i}.txt` }));
    rememberPendingSensitive("u1", items.slice(0, 10), 1_000);
    rememberPendingSensitive("u1", items.slice(10), 2_000);
    const taken = takePendingSensitive("u1", 2_000);
    expect(taken).toHaveLength(20);
    expect(taken[0]?.src).toBe("file:///f/5.txt");
    expect(taken.at(-1)?.src).toBe("file:///f/24.txt");
  });
});
