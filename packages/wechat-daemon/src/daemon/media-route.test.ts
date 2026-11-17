import { describe, expect, it } from "vitest";

import type { InboundAttachment } from "./daemon-routing.js";
import {
  decideInboundRoute,
  deliveryTarget,
  MediaRoute,
  waitForSettledAttachments,
} from "./media-route.js";

/** 队列只存引用，不读内容；用最小占位对象即可。 */
const att = (id: string) =>
  ({ kind: "image", item: { media: { id } } }) as unknown as InboundAttachment;

describe("MediaRoute（收件人 + 待投递队列）", () => {
  it("arm → recipient 生效；clear 后没有", () => {
    let now = 1_000;
    const route = new MediaRoute(60_000, () => now);
    expect(route.recipient("u")).toBeNull();
    route.arm("u", 5, "task-5@u");
    const rec = route.recipient("u")!;
    expect(rec.taskId).toBe(5);
    expect(rec.taskKey).toBe("task-5@u");
    expect(rec.expiresAt).toBe(61_000);
    expect(route.isArmed("u")).toBe(true);
    route.clear("u");
    expect(route.recipient("u")).toBeNull();
    expect(route.isArmed("u")).toBe(false);
  });

  it("滑动续期：touch 重置到期时间，到期即返回 null", () => {
    let now = 0;
    const route = new MediaRoute(60_000, () => now);
    route.arm("u", 1, "k");
    now = 50_000;
    route.touch("u");
    expect(route.recipient("u")!.expiresAt).toBe(110_000);
    now = 100_000;
    expect(route.recipient("u")).not.toBeNull();
    now = 110_000;
    expect(route.recipient("u")).toBeNull();
    // 续期一个没设收件人的用户不会凭空创建状态
    route.touch("nobody");
    expect(route.recipient("nobody")).toBeNull();
  });

  it("buffer：first 只对第一批为 true；takePending 取走并清空", () => {
    const route = new MediaRoute(60_000, () => 0);
    route.arm("u", 3, "k");
    expect(route.buffer("u", [att("a")], "m1")).toEqual({ first: true, count: 1 });
    expect(route.buffer("u", [att("b"), att("c")], "m2")).toEqual({ first: false, count: 3 });
    expect(route.pendingCount("u")).toBe(3);
    const batch = route.takePending("u");
    expect(batch.items.length).toBe(3);
    expect(batch.messageIds).toEqual(["m1", "m2"]);
    expect(route.pendingCount("u")).toBe(0);
    // 取第二次是空的（不重复提交）
    expect(route.takePending("u")).toEqual({ items: [], messageIds: [] });
  });

  it("buffer 也会续期（发附件算活动）", () => {
    let now = 0;
    const route = new MediaRoute(60_000, () => now);
    route.arm("u", 1, "k");
    now = 50_000;
    route.buffer("u", [att("a")], "m");
    expect(route.recipient("u")!.expiresAt).toBe(110_000);
  });

  it("dueExpired：只返回到期的，并顺带清掉（待投递队列留给调用方）", () => {
    let now = 0;
    const route = new MediaRoute(60_000, () => now);
    route.arm("a", 1, "k1");
    route.arm("b", 2, "k2");
    now = 50_000;
    route.touch("b"); // b 续期，不到期
    now = 61_000;
    const due = route.dueExpired();
    expect(due.map((d) => d.userId)).toEqual(["a"]);
    expect(due[0].recipient.taskId).toBe(1);
    expect(route.recipient("b")).not.toBeNull();
    expect(route.pendingCount("a")).toBe(0);
  });

  it("按发送者隔离", () => {
    const route = new MediaRoute(60_000, () => 0);
    route.arm("a", 1, "k");
    route.buffer("a", [att("x")], "m");
    expect(route.recipient("b")).toBeNull();
    expect(route.pendingCount("b")).toBe(0);
    expect(route.pendingCount("a")).toBe(1);
  });

  it("reset 清空全部状态", () => {
    const route = new MediaRoute(60_000, () => 0);
    route.arm("a", 1, "k");
    route.buffer("a", [att("x")], "m");
    route.reset();
    expect(route.recipient("a")).toBeNull();
    expect(route.pendingCount("a")).toBe(0);
  });

  it("touch 不能复活已过期（但还没被清扫）的指针", () => {
    let now = 0;
    const route = new MediaRoute(60_000, () => now);
    route.arm("u", 1, "k");
    now = 60_001;
    expect(route.recipient("u")).toBeNull();
    route.touch("u"); // 迟到的提交回调不应该把用户重新拉回收件人模式
    expect(route.recipient("u")).toBeNull();
    now = 120_000;
    expect(route.recipient("u")).toBeNull();
  });

  it("buffer 记住这批附件属于哪条任务（收件人过期后队列仍知道归属）", () => {
    const route = new MediaRoute(60_000, () => 0);
    route.arm("u", 7, "k");
    route.buffer("u", [att("a")], "m1", 7);
    const batch = route.takePending("u");
    expect(batch.taskId).toBe(7);
  });

  it("swapRecipient：只在换人且有待投递附件时把旧批次交出来", () => {
    let now = 0;
    const route = new MediaRoute(60_000, () => now);
    route.arm("u", 1, "k1");
    // 没有积压：直接换，不返回批次
    expect(route.swapRecipient("u", 2, "k2")).toBeNull();
    expect(route.recipient("u")!.taskId).toBe(2);

    route.buffer("u", [att("a"), att("b")], "m", 2);
    // 同一个任务再 arm：不算换人，队列原样留着
    expect(route.swapRecipient("u", 2, "k2")).toBeNull();
    expect(route.pendingCount("u")).toBe(2);

    const displaced = route.swapRecipient("u", 3, "k3");
    expect(displaced?.oldTaskId).toBe(2);
    expect(displaced?.batch.items.length).toBe(2);
    // 指针已切到新任务，旧批次被取走（由调用方负责交给旧任务）
    expect(route.recipient("u")!.taskId).toBe(3);
    expect(route.pendingCount("u")).toBe(0);
  });

  it("swapRecipient：指针已过期也要把旧批次交回（否则会错投给下一条任务）", () => {
    let now = 0;
    const route = new MediaRoute(60_000, () => now);
    route.arm("u", 1, "k");
    route.buffer("u", [att("a")], "m", 1);
    now = 60_001; // 15s 清扫还没轮到，指针只是「过期」
    // #1 的附件必须交回给 #1，不能留在队列里等 #2 来认领
    const displaced = route.swapRecipient("u", 2, "k2");
    expect(displaced?.oldTaskId).toBe(1);
    expect(displaced?.batch.items.length).toBe(1);
    expect(route.recipient("u")!.taskId).toBe(2);
    expect(route.pendingCount("u")).toBe(0);
  });

  it("buffer：队列里是另一条任务的附件时不改归属，整批交还给调用方", () => {
    const route = new MediaRoute(60_000, () => 0);
    route.arm("u", 1, "k1");
    route.buffer("u", [att("a")], "m1", 1);
    // 指针已换到 #2（模拟换人时旧批次没被取走的极端情况）
    route.arm("u", 2, "k2");
    const r = route.buffer("u", [att("b")], "m2", 2);
    expect(r.displaced?.taskId).toBe(1);
    expect(r.displaced?.batch.items.length).toBe(1);
    // 新批次只含新附件，不会被旧附件污染
    expect(r.first).toBe(true);
    expect(r.count).toBe(1);
    expect(route.pendingOwner("u")).toBe(2);
  });

  it("pendingOwner：指针过期后仍能认账", () => {
    let now = 0;
    const route = new MediaRoute(60_000, () => now);
    route.arm("u", 1, "k");
    route.buffer("u", [att("a")], "m", 1);
    now = 60_001;
    expect(route.recipient("u")).toBeNull();
    expect(route.pendingOwner("u")).toBe(1);
  });

  it("purgeForStopped：指针已过期也能清掉属于该任务的暂存附件", () => {
    let now = 0;
    const route = new MediaRoute(60_000, () => now);
    route.arm("u", 1, "k");
    route.buffer("u", [att("a"), att("b")], "m", 1);
    now = 60_001; // 指针过期，清扫还没跑
    expect(route.purgeForStopped("u", 1, () => false)).toBe(2);
    expect(route.pendingCount("u")).toBe(0);
  });

  it("purgeForStopped：只清被结束的那条任务，不误伤后来设置的收件人", () => {
    const route = new MediaRoute(60_000, () => 0);
    route.arm("u", 2, "k2");
    route.buffer("u", [att("a")], "m", 2);
    expect(route.purgeForStopped("u", 1, (id) => id === 2)).toBe(0);
    expect(route.recipient("u")!.taskId).toBe(2);
    expect(route.pendingCount("u")).toBe(1);
    // 「全部」才一起清
    expect(route.purgeForStopped("u", "all", () => true)).toBe(1);
    expect(route.recipient("u")).toBeNull();
    expect(route.pendingCount("u")).toBe(0);
  });
});

describe("decideInboundRoute（poller 分拣）", () => {
  const base: Parameters<typeof decideInboundRoute>[0] = {
    recipientTaskId: null,
    attachmentCount: 0,
    hasText: true,
    hasCommand: false,
    fastLane: false,
    mcpToBrain: false,
  };
  const decide = (over: Partial<typeof base>) => decideInboundRoute({ ...base, ...over });

  it("没有收件人：保持原行为（命令/续跑走快车道，其余给大脑）", () => {
    expect(decide({ fastLane: true })).toEqual({ kind: "fast" });
    expect(decide({ fastLane: false })).toEqual({ kind: "brain" });
    expect(decide({ attachmentCount: 2 })).toEqual({ kind: "brain" });
  });

  it("有收件人：非文本入待投递队列（队列回执交给 poller）", () => {
    expect(decide({ recipientTaskId: 5, attachmentCount: 2, hasText: false })).toEqual({
      kind: "buffer",
      recipientTaskId: 5,
    });
    // 同一条消息既有附件又有文字：也入队，文字由 poller 另外推进快车道
    expect(decide({ recipientTaskId: 5, attachmentCount: 1 })).toEqual({
      kind: "buffer",
      recipientTaskId: 5,
    });
  });

  it("有收件人：无前缀文字交给它", () => {
    expect(decide({ recipientTaskId: 5 })).toEqual({ kind: "recipient", recipientTaskId: 5 });
  });

  it("命令/逃逸优先：带附件的命令不会被吞成待投递附件", () => {
    // `结束任务` + 附件：仍走原路径（附件不进快车道 → 大脑），命令不丢
    expect(decide({ recipientTaskId: 5, attachmentCount: 1, hasCommand: true })).toEqual({
      kind: "brain",
    });
    // 纯命令（无附件）照旧走快车道
    expect(decide({ recipientTaskId: 5, hasCommand: true, fastLane: true })).toEqual({
      kind: "fast",
    });
    // `问大脑：…` 逃逸 + 附件：交给大脑
    expect(decide({ recipientTaskId: 5, attachmentCount: 1, hasCommand: true })).toEqual({
      kind: "brain",
    });
  });

  it("有收件人但没文字没附件：不误判成交给收件人", () => {
    expect(decide({ recipientTaskId: 5, hasText: false })).toEqual({ kind: "brain" });
  });

  it("mcpToBrain：direct 下把 MCP 切换原样交给 Agent（不进快车道）", () => {
    expect(decide({ fastLane: true, mcpToBrain: true })).toEqual({ kind: "brain" });
  });
});

describe("deliveryTarget（过期批次不错投给新收件人）", () => {
  it("有附件：以批次归属为准，指针已换人也不改投", () => {
    expect(deliveryTarget({ items: [att("a")], taskId: 1 }, 2)).toBe(1);
  });

  it("有附件但批次没记归属：退回当前收件人（只在旧数据/测试里出现）", () => {
    expect(deliveryTarget({ items: [att("a")] }, 2)).toBe(2);
  });

  it("没有附件：走当前收件人（纯文字提交）", () => {
    expect(deliveryTarget({ items: [], taskId: 1 }, 2)).toBe(2);
  });
});

describe("waitForSettledAttachments（等后到的图并批）", () => {
  /** 可控时钟：sleep 推进 now，顺便模拟「睡到一半又来了附件」。 */
  const harness = (plan: { atMs: number; bufferAt?: number }[] = []) => {
    let now = 0;
    const buffers: number[] = [];
    const push = (at: number) => buffers.push(at);
    for (const step of plan) if (step.bufferAt !== undefined) push(step.bufferAt);
    const last = () => (buffers.length ? buffers[buffers.length - 1] : undefined);
    const sleeps: number[] = [];
    return {
      setNow: (v: number) => (now = v),
      buffers,
      sleeps,
      deps: {
        now: () => now,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          now += ms;
        },
        lastBufferedAt: last,
      },
    };
  };

  it("队列里没有附件：不等", async () => {
    const h = harness();
    expect(await waitForSettledAttachments({ ...h.deps, quietMs: 700, maxMs: 3_000 })).toBe(0);
    expect(h.sleeps).toEqual([]);
  });

  it("已经安静够久：直接提交", async () => {
    const h = harness([{ atMs: 0, bufferAt: 0 }]);
    h.setNow(1_000);
    expect(await waitForSettledAttachments({ ...h.deps, quietMs: 700, maxMs: 3_000 })).toBe(0);
    expect(h.sleeps).toEqual([]);
  });

  it("刚入队：等到安静 quietMs 为止", async () => {
    const h = harness([{ atMs: 0, bufferAt: 800 }]);
    h.setNow(900);
    expect(await waitForSettledAttachments({ ...h.deps, quietMs: 700, maxMs: 3_000 })).toBe(600);
    // 起点是 900，安静到 1500 才提交
    expect(h.sleeps).toEqual([600]);
  });

  it("等待期间又来了附件：重新计时", async () => {
    const h = harness([{ atMs: 0, bufferAt: 900 }]);
    h.setNow(1_000);
    const wait = waitForSettledAttachments({ ...h.deps, quietMs: 700, maxMs: 3_000 });
    // 600ms 后（t=1600）新附件到了：再来一张
    h.setNow(1_600);
    h.buffers.push(1_600);
    expect(await wait).toBe(1_300); // 安静到 2300
    expect(h.sleeps).toEqual([600, 700]);
  });

  it("总等待有上限：用户一直发图也不会把已发的文字饿死", async () => {
    let now = 0;
    let lastAt = 0;
    const sleeps: number[] = [];
    const res = await waitForSettledAttachments({
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
        // 每 100ms 来一张，永远安静不下来
        lastAt = now;
      },
      lastBufferedAt: () => lastAt,
      quietMs: 700,
      maxMs: 3_000,
    });
    expect(res).toBe(3_000);
    expect(now).toBe(3_000);
  });
});

describe("MediaRoute.lastBufferedAt（防抖依据）", () => {
  it("入队时记录时间，取走/清空后不再有", () => {
    let now = 0;
    const route = new MediaRoute(60_000, () => now);
    expect(route.lastBufferedAt("u")).toBeUndefined();
    route.arm("u", 1, "k");
    now = 100;
    route.buffer("u", [att("a")], "m1", 1);
    expect(route.lastBufferedAt("u")).toBe(100);
    now = 250;
    route.buffer("u", [att("b")], "m2", 1);
    expect(route.lastBufferedAt("u")).toBe(250);
    route.takePending("u");
    expect(route.lastBufferedAt("u")).toBeUndefined();
  });
});
