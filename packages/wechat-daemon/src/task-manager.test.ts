import { describe, it, expect, vi, afterEach } from "vitest";

// mock worker-acp（用 vi.hoisted 让 mock 工厂可引用）
const { askWorker, stopWorker } = vi.hoisted(() => ({ askWorker: vi.fn(), stopWorker: vi.fn() }));
vi.mock("./worker-acp.js", () => ({
  askWorker: (...a: unknown[]) => askWorker(...a),
  stopWorker: () => stopWorker(),
  newWorkerSession: vi.fn(),
  isWorkerAlive: vi.fn(() => false),
}));

import { dispatchTask, injectTask, stopTask, hasActiveTask, isAwaiting, setTaskPush } from "./task-manager.js";

function deferred<T = string>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const has = (arr: string[], sub: string) => arr.some((p) => p.includes(sub));

afterEach(() => {
  stopTask("u1"); stopTask("u2"); // 清理可能残留的任务
  askWorker.mockReset();
  stopWorker.mockReset();
});

describe("task-manager 状态机", () => {
  it("派发 → 一轮结束推送(带【任务】) → waiting → 注入续跑 → stop", async () => {
    const r1 = deferred();
    const r2 = deferred();
    askWorker.mockReturnValueOnce(r1.promise).mockReturnValueOnce(r2.promise);
    const pushed: string[] = [];
    setTaskPush((_to, t) => pushed.push(t));

    const ack = dispatchTask("u1", "做X");
    expect(ack).toContain("已派");
    expect(hasActiveTask("u1")).toBe(true);
    expect(askWorker).toHaveBeenCalledTimes(1);
    expect(askWorker.mock.calls[0][0]).toBe("做X");

    r1.resolve("方案 A 还是 B？");
    await vi.waitFor(() => expect(has(pushed, "方案 A 还是 B？")).toBe(true));
    expect(has(pushed, "🤖【任务】")).toBe(true);     // 来源标记
    expect(isAwaiting("u1")).toBe(true);              // 推送后进入 waiting（等你回）

    injectTask("u1", "选 A"); // waiting 态注入 → 第二轮
    await vi.waitFor(() => expect(askWorker).toHaveBeenCalledTimes(2));
    expect(askWorker.mock.calls[1][0]).toBe("选 A");

    r2.resolve("已完成");
    await vi.waitFor(() => expect(has(pushed, "已完成")).toBe(true));

    expect(stopTask("u1")).toContain("已结束");
    expect(hasActiveTask("u1")).toBe(false);
    expect(isAwaiting("u1")).toBe(false);
  });

  it("二次派发被拒（已有任务）", async () => {
    const d = deferred();
    askWorker.mockReturnValueOnce(d.promise);
    setTaskPush(() => {});
    expect(dispatchTask("u1", "X")).toContain("已派");
    expect(dispatchTask("u1", "Y")).toContain("已有任务");
    d.reject(new Error("cleanup"));
    await Promise.resolve();
  });

  it("中断 → 推送中断提示（含「继续」字样），非 waiting 误判", async () => {
    const r1 = deferred();
    askWorker.mockReturnValueOnce(r1.promise);
    const pushed: string[] = [];
    setTaskPush((_to, t) => pushed.push(t));

    dispatchTask("u1", "重任务");
    r1.reject(new Error("session/prompt idle timeout (idle=999ms total=999ms)"));
    await vi.waitFor(() => expect(has(pushed, "继续")).toBe(true));
    expect(has(pushed, "中断")).toBe(true);
  });

  it("running 期间消息暂存为 pendingInject，下一轮消费", async () => {
    const r1 = deferred();
    const r2 = deferred();
    askWorker.mockReturnValueOnce(r1.promise).mockReturnValueOnce(r2.promise);
    const pushed: string[] = [];
    setTaskPush((_to, t) => pushed.push(t));

    dispatchTask("u2", "任务");
    expect(isAwaiting("u2")).toBe(false); // running 中，不是 waiting
    injectTask("u2", "顺便也做Y"); // running 中 → 暂存
    expect(has(pushed, "已记下")).toBe(true);

    r1.resolve("第一轮完成");
    await vi.waitFor(() => expect(askWorker).toHaveBeenCalledTimes(2));
    expect(askWorker.mock.calls[1][0]).toBe("顺便也做Y"); // 消费暂存
    r2.resolve("done");
    await vi.waitFor(() => expect(has(pushed, "done")).toBe(true));
  });
});
