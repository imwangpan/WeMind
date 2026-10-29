import { describe, it, expect } from "vitest";

import { PENDING_PUSH_LIMIT, PendingPushes } from "./pending-push.js";

/** 这个队列只为一件事实服务：重启后旧 token 期间的外发挂起、新 token 到达后按序补发。钉死顺序、按人隔离、上限丢最旧、取走即清空、补发次数计数。 */
describe("PendingPushes", () => {
  it("按入队顺序整批取走，取走后清空", () => {
    const q = new PendingPushes();
    q.push("u1", "任务 7 已完成");
    q.push("u1", "任务 8 失败：no API key");
    expect(q.size("u1")).toBe(2);
    expect(q.take("u1")).toEqual([
      { text: "任务 7 已完成", tries: 0 },
      { text: "任务 8 失败：no API key", tries: 0 },
    ]);
    expect(q.size("u1")).toBe(0);
    expect(q.take("u1")).toEqual([]);
  });

  it("按收件人隔离：补发一个人的不影响另一个人", () => {
    const q = new PendingPushes();
    q.push("u1", "A");
    q.push("u2", "B");
    expect(q.take("u1")).toEqual([{ text: "A", tries: 0 }]);
    expect(q.size("u2")).toBe(1);
    expect(q.total()).toBe(1);
  });

  it("分批取走：只取前 max 条，剩下的留在队里保持顺序", () => {
    const q = new PendingPushes();
    q.push("u1", "a");
    q.push("u1", "b");
    q.push("u1", "c");
    expect(q.take("u1", 1).map((e) => e.text)).toEqual(["a"]);
    expect(q.size("u1")).toBe(2);
    expect(q.take("u1", 5).map((e) => e.text)).toEqual(["b", "c"]);
    expect(q.size("u1")).toBe(0);
    expect(q.take("u1", 0)).toEqual([]);
  });

  it("超过上限丢最旧的、保留最新的（返回值为该收件人当前条数）", () => {
    const q = new PendingPushes(3);
    expect(q.push("u1", "m1")).toBe(1);
    expect(q.push("u1", "m2")).toBe(2);
    expect(q.push("u1", "m3")).toBe(3);
    expect(q.push("u1", "m4")).toBe(3);
    expect(q.push("u1", "m5")).toBe(3);
    expect(q.take("u1").map((e) => e.text)).toEqual(["m3", "m4", "m5"]);
  });

  it("重挂时保留补发失败次数（tries 随调用方传入）", () => {
    const q = new PendingPushes();
    q.push("u1", "x", 2);
    expect(q.take("u1")).toEqual([{ text: "x", tries: 2 }]);
  });

  it("上限按收件人分别计算，不互相挤占", () => {
    const q = new PendingPushes(2);
    q.push("u1", "a");
    q.push("u1", "b");
    q.push("u2", "c");
    q.push("u2", "d");
    q.push("u2", "e");
    expect(q.take("u1").map((e) => e.text)).toEqual(["a", "b"]);
    expect(q.take("u2").map((e) => e.text)).toEqual(["d", "e"]);
  });

  it("非法上限回落到默认值", () => {
    const a = new PendingPushes(Number.NaN);
    for (let i = 0; i < PENDING_PUSH_LIMIT + 5; i++) a.push("u1", String(i));
    expect(a.size("u1")).toBe(PENDING_PUSH_LIMIT);

    const b = new PendingPushes(0);
    b.push("u1", "x");
    b.push("u1", "y");
    expect(b.take("u1").map((e) => e.text)).toEqual(["y"]);
  });

  it("没有挂起时 take 返回空数组、total 为 0", () => {
    const q = new PendingPushes();
    expect(q.take("nobody")).toEqual([]);
    expect(q.total()).toBe(0);
  });
});
