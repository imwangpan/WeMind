import type { InboundAttachment } from "./daemon-routing.js";

/**
 * 「收件人」+「待投递队列」：让 worker 也能收到图片/文件这类**没有文字可寻址**的消息。
 *
 * 微信侧一条消息塞不下「文字 + 图片」，所以图片/文件总是单独到达、正文为空，路由只能靠上文状态。
 * 这里维护一个**按发送者**的内存指针（收件人）：
 *  - 收件人指向某条任务；在它到期前，非文本消息进「待投递队列」，纯文本（非命令）标记为一起提交；
 *  - 提交点（文本到达 / `好了` / 空闲到期）把队列里的附件与文字**合成一个多模态回合**交给任务；
 *  - 到期（滑动空闲 TTL）自动取消并回执，绝不静默切换归属。
 *
 * 内存态、不落盘：daemon 重启后指针消失（安全默认——之后的非文本消息回到大脑），pending 也一并丢弃。
 */

export interface Recipient {
  taskId: number;
  /** `task-<编号>@<userId>`，与任务的会话键一致。 */
  taskKey: string;
  armedAt: number;
  expiresAt: number;
}

export interface PendingBatch {
  items: InboundAttachment[];
  messageIds: string[];
  /** 这批附件当初是给哪条任务攒的（收件人可能已过期被清，队列仍要知道归属）。 */
  taskId?: number;
}

export class MediaRoute {
  private readonly recipients = new Map<string, Recipient>();
  private readonly pending = new Map<string, PendingBatch>();
  /** 上次往队列里放附件的时间：用于「等后到的图并批」的静默窗口。 */
  private readonly lastBuffered = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 把某条任务设为收件人（重复设置即重置计时）。 */
  arm(userId: string, taskId: number, taskKey: string): void {
    const at = this.now();
    this.recipients.set(userId, { taskId, taskKey, armedAt: at, expiresAt: at + this.ttlMs });
  }

  /**
   * 切换收件人：若指针要指向另一条任务且还有待投递附件，先把旧批次交出来（由调用方投递给**原任务**），再改指针。
   * 返回被换下来的批次；没有换人 / 没有积压时返回 null。
   */
  swapRecipient(
    userId: string,
    taskId: number,
    taskKey: string,
  ): { oldTaskId: number; batch: PendingBatch } | null {
    // 指针可能已过期（15s 清扫还没轮到），但队列里的附件归属仍是旧任务：按批次自己的 taskId 认账，
    // 不能因为 `recipient()` 返回 null 就把旧附件留给下一条任务（那会错投）。
    const cur = this.recipients.get(userId);
    const batch = this.takePending(userId);
    let displaced: { oldTaskId: number; batch: PendingBatch } | null = null;
    if (batch.items.length) {
      const owner = batch.taskId ?? cur?.taskId;
      if (owner !== undefined && owner !== taskId) displaced = { oldTaskId: owner, batch };
      else this.pending.set(userId, batch); // 同一任务 / 归属不明：原样留着继续攒
    }
    this.arm(userId, taskId, taskKey);
    return displaced;
  }

  /** 收件人模式内的一次「活动」：滑动续期。未设收件人、或已过期（等待清扫）时都不动指针。 */
  touch(userId: string): void {
    const r = this.recipients.get(userId);
    if (r && r.expiresAt > this.now()) r.expiresAt = this.now() + this.ttlMs;
  }

  /** 当前收件人（已过期视为没有）。 */
  recipient(userId: string): Recipient | null {
    const r = this.recipients.get(userId);
    return r && r.expiresAt > this.now() ? r : null;
  }

  isArmed(userId: string): boolean {
    return this.recipient(userId) !== null;
  }

  /** 取消收件人（不动待投递队列）。 */
  clear(userId: string): void {
    this.recipients.delete(userId);
  }

  /** 附件入队；返回是否本批第一条（用于只回一次「已收到附件」）与当前累计条数。 */
  buffer(
    userId: string,
    items: InboundAttachment[],
    messageId: string,
    taskId?: number,
  ): {
    first: boolean;
    count: number;
    /** 队列里原来攒的是**另一条任务**的附件：整批交还给调用方先投递，绝不静默改归属。 */
    displaced?: { taskId: number; batch: PendingBatch };
  } {
    const prev = this.pending.get(userId);
    let displaced: { taskId: number; batch: PendingBatch } | undefined;
    if (
      prev &&
      prev.items.length &&
      prev.taskId !== undefined &&
      taskId !== undefined &&
      prev.taskId !== taskId
    ) {
      this.pending.delete(userId);
      displaced = { taskId: prev.taskId, batch: prev };
    }
    const batch = this.pending.get(userId) ?? { items: [], messageIds: [] };
    const first = batch.items.length === 0;
    batch.items.push(...items);
    if (messageId) batch.messageIds.push(messageId);
    if (taskId !== undefined) batch.taskId = taskId;
    this.pending.set(userId, batch);
    this.lastBuffered.set(userId, this.now());
    this.touch(userId);
    return { first, count: batch.items.length, displaced };
  }

  /** 上次入队附件的时刻（没有则 undefined）。防抖窗口按它算「安静了多久」。 */
  lastBufferedAt(userId: string): number | undefined {
    return this.lastBuffered.get(userId);
  }

  /** 队列里攒的附件属于哪条任务（指针过期后仍能认账）。 */
  pendingOwner(userId: string): number | undefined {
    return this.pending.get(userId)?.taskId;
  }

  /**
   * 任务结束时清掉与它相关的状态（微信「结束任务」与本地 `wemind task-stop` 共用）。
   * 指针可能已过期（15s 清扫还没轮到），所以「是不是它」同时看指针与批次归属：
   * `isAlive` 用于兜住「任务已被别处停掉、指针还指着它」的情形。
   * 返回被丢弃的暂存附件数（调用方据此在回执里交代，绝不静默丢文件）。
   */
  purgeForStopped(
    userId: string,
    id: number | "all" | undefined,
    isAlive: (taskId: number) => boolean,
  ): number {
    const hit = (taskId: number | undefined): boolean =>
      taskId !== undefined && (id === "all" || id === taskId || !isAlive(taskId));
    if (hit(this.recipients.get(userId)?.taskId)) this.clear(userId);
    if (!hit(this.pending.get(userId)?.taskId)) return 0;
    const dropped = this.pendingCount(userId);
    this.clearPending(userId);
    return dropped;
  }

  pendingCount(userId: string): number {
    return this.pending.get(userId)?.items.length ?? 0;
  }

  /** 取走待投递队列并清空。 */
  takePending(userId: string): PendingBatch {
    const batch = this.pending.get(userId) ?? { items: [], messageIds: [] };
    this.pending.delete(userId);
    this.lastBuffered.delete(userId);
    return batch;
  }

  clearPending(userId: string): void {
    this.pending.delete(userId);
    this.lastBuffered.delete(userId);
  }

  /**
   * 到期应处理的收件人（顺带从表里清掉）。
   * 返回列表供调用方发「已超时取消」回执，并把队列里已攒的附件尽力补交一次。
   */
  dueExpired(): Array<{ userId: string; recipient: Recipient }> {
    const out: Array<{ userId: string; recipient: Recipient }> = [];
    const now = this.now();
    for (const [userId, r] of this.recipients) {
      if (r.expiresAt <= now) {
        this.recipients.delete(userId);
        out.push({ userId, recipient: r });
      }
    }
    return out;
  }

  /** 测试用：清空全部状态。 */
  reset(): void {
    this.recipients.clear();
    this.pending.clear();
    this.lastBuffered.clear();
  }
}

/**
 * 投递目标：队列里有附件时以**批次归属**为准（收件人指针可能已经换人/过期）。
 * 这是「过期收件人的旧附件不错投给新任务」的最后一环。
 */
export function deliveryTarget(
  batch: Pick<PendingBatch, "items" | "taskId">,
  fallbackTaskId: number,
): number {
  return batch.items.length ? (batch.taskId ?? fallbackTaskId) : fallbackTaskId;
}

/** poller 对一条入站消息的分拣结果。 */ export type InboundRoute =
  | { kind: "buffer"; recipientTaskId: number }
  | { kind: "recipient"; recipientTaskId: number }
  | { kind: "fast" }
  | { kind: "brain" };

/**
 * 入站消息该走哪条路（纯函数，便于表驱动测试）。
 *
 * 顺序即优先级：命令与逃逸前缀永远优先——带附件的命令也走原路径（附件消息本就不进快车道，会交给大脑），
 * 避免「收件人期间发 `结束任务` + 附件」被整条吞成待投递附件。
 */
export function decideInboundRoute(input: {
  recipientTaskId: number | null;
  attachmentCount: number;
  hasText: boolean;
  hasCommand: boolean;
  fastLane: boolean;
  mcpToBrain: boolean;
}): InboundRoute {
  const { recipientTaskId, attachmentCount, hasText, hasCommand, fastLane, mcpToBrain } = input;
  if (recipientTaskId !== null && !hasCommand) {
    if (attachmentCount > 0) return { kind: "buffer", recipientTaskId };
    if (hasText) return { kind: "recipient", recipientTaskId };
  }
  if (!mcpToBrain && fastLane) return { kind: "fast" };
  return { kind: "brain" };
}

/**
 * 「等后到的图」：微信里一张图就是一条消息，用户连发几张再立刻发文字时，最后几张可能还在路上。
 * 触发提交前先等到队列**安静** `quietMs`，让晚到的附件并入同一批；总等待不超过 `maxMs`，
 * 避免用户一直发图时文字永远等下去。
 *
 * 依赖注入式实现（`now`/`sleep`），便于单测不碰真实计时器。返回实际等待的毫秒数。
 */
export async function waitForSettledAttachments(params: {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  lastBufferedAt: () => number | undefined;
  quietMs: number;
  maxMs: number;
}): Promise<number> {
  const { now, sleep, lastBufferedAt, quietMs, maxMs } = params;
  const start = now();
  for (;;) {
    const last = lastBufferedAt();
    if (last === undefined) return now() - start;
    const at = now();
    const idle = at - last;
    if (idle >= quietMs) return at - start;
    const remaining = maxMs - (at - start);
    if (remaining <= 0) return at - start;
    await sleep(Math.min(quietMs - idle, remaining));
  }
}
