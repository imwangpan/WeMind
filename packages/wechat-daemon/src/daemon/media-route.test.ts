import { describe, expect, it } from "vitest";

import type { InboundAttachment } from "./daemon-routing.js";
import { decideInboundRoute, MediaRoute } from "./media-route.js";

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

  it("swapRecipient：指针已过期时不返回批次（队列的归属交给调用方兜底）", () => {
    let now = 0;
    const route = new MediaRoute(60_000, () => now);
    route.arm("u", 1, "k");
    route.buffer("u", [att("a")], "m", 1);
    now = 60_001;
    expect(route.swapRecipient("u", 2, "k2")).toBeNull();
    expect(route.recipient("u")!.taskId).toBe(2);
    // 旧队列没被悄悄清掉，调用方还能用 batch.taskId 找到归属
    expect(route.takePending("u").taskId).toBe(1);
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
