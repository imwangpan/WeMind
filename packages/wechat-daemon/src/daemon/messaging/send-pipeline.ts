import { MessageState, type MessageItem, type MediaKind } from "@wemind/wechat-ilink-core";

import type { LeveledLog } from "../../shared/io/leveled-log.js";
import { PENDING_PUSH_MAX_TRIES, PendingPushes } from "./pending-push.js";

/** 按收件人维护的连续发送预算（service 端按「距用户上一条消息」计）。 */
export type SendBudget = { count: number; awaiting: boolean };

export type SendPipelineDeps = {
  /** 发一条文本；实现方负责 ret=-2/传输错误的重试，本类只管排队、节流与失败后的挂起。 */
  sendText: (
    to: string,
    ctx: string | undefined,
    text: string,
    state: number,
    fallbackToken?: string,
  ) => Promise<void>;
  /** 发一张图；失败直接抛错（图片无法挂起补发）。 */
  sendImage: (to: string, ctx: string | undefined, image: Buffer) => Promise<void>;
  /** 发一个文件/视频；失败直接抛错（媒体无法挂起补发）。 */
  sendFile: (
    to: string,
    ctx: string | undefined,
    data: Buffer,
    fileName: string,
    kind: MediaKind,
  ) => Promise<void>;
  /** 发一个结构化 item（工具进度 11/12 等）；失败时调用方可用文本回退。 */
  sendItem: (
    to: string,
    ctx: string | undefined,
    item: MessageItem,
    state?: number,
  ) => Promise<void>;
  /** 把长回复作为 .md 文件发出；失败直接抛错（本类会回退为文本）。 */
  sendFileMd: (to: string, ctx: string | undefined, text: string) => Promise<void>;
  /** 分类记录发送错误（会话过期要暂停账号等）。 */
  onSendError: (e: unknown) => void;
  /** 是否为 ret=-2 参数错误（限流或旧 token）。 */
  isParamError: (e: unknown) => boolean;
  log: LeveledLog;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minGapMs?: number;
  consecLimit?: number;
  pendingBatch?: number;
  pending?: PendingPushes;
};

/**
 * 外发管线：串行链 + 最小间隔 + 连发预算 + 旧 token 挂起/补发 + 回合末尾的让位队列。
 *
 * 抽成类是为了让这些编排可以脱离真实微信网络做单测：测试只注入假的 sendText/sendImage/sendFileMd 与可控时钟。
 */
export class SendPipeline {
  private readonly deps: Required<Omit<SendPipelineDeps, "pending">> & {
    pending: PendingPushes;
  };
  private readonly budgets = new Map<string, SendBudget>();
  private readonly freshTokenUsers = new Set<string>();
  private readonly inflightSends = new Map<string, number>();
  private readonly deferredTaskPushes = new Map<string, string[]>();
  private replyChain: Promise<void> = Promise.resolve();
  private lastSendAt = 0;

  constructor(deps: SendPipelineDeps) {
    this.deps = {
      ...deps,
      now: deps.now ?? Date.now,
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      minGapMs: deps.minGapMs ?? 1500,
      consecLimit: deps.consecLimit ?? 10,
      pendingBatch: deps.pendingBatch ?? 5,
      pending: deps.pending ?? new PendingPushes(),
    };
  }

  get consecLimit(): number {
    return this.deps.consecLimit;
  }

  /** 该收件人的连发预算；调用方可直接读写 `count`/`awaiting`（与拆分前的模块级对象语义一致）。 */
  budgetOf(to: string): SendBudget {
    let b = this.budgets.get(to);
    if (!b) {
      b = { count: 0, awaiting: false };
      this.budgets.set(to, b);
    }
    return b;
  }

  /** 本进程已收到过该用户的消息 = 手里是这一进程拿到的 token，此后它的 -2 属于限流、不再挂起。 */
  markFresh(to: string): void {
    this.freshTokenUsers.add(to);
  }

  isFresh(to: string): boolean {
    return this.freshTokenUsers.has(to);
  }

  inflightCount(to: string): number {
    return this.inflightSends.get(to) ?? 0;
  }

  pendingCount(to: string): number {
    return this.deps.pending.size(to);
  }

  private trackInflight(to: string, delta: number): void {
    const n = this.inflightCount(to) + delta;
    if (n > 0) this.inflightSends.set(to, n);
    else this.inflightSends.delete(to);
  }

  private async waitGap(): Promise<void> {
    const wait = this.deps.minGapMs - (this.deps.now() - this.lastSendAt);
    if (wait > 0) await this.deps.sleep(wait);
  }

  /** 串行排队一条外发；`onError` 用于「必须送达」的调用方接管失败（挂起/重挂）。 */
  sendOrdered(
    to: string,
    ctx: string | undefined,
    text: string,
    state: number = MessageState.FINISH,
    fallbackToken?: string,
    onError?: (e: unknown) => void,
  ): Promise<void> {
    this.trackInflight(to, 1);
    this.replyChain = this.replyChain
      .then(async () => {
        await this.waitGap();
        await this.deps.sendText(to, ctx, text, state, fallbackToken).catch((e) => {
          this.deps.onSendError(e);
          onError?.(e);
        });
        this.lastSendAt = this.deps.now();
      })
      // 串行链不能因为一次意外抛错而永久卡死（后续 .then 全被跳过，所有消息静默不发）
      .catch((e) => this.deps.log("error", "send chain error:", String(e)))
      .finally(() => this.trackInflight(to, -1));
    return this.replyChain;
  }

  /** 媒体发送的公共串行编排：与文本共用串行链和最小间隔，失败返回 false。 */
  private async sendMediaOrdered(
    to: string,
    sender: () => Promise<void>,
    label: string,
  ): Promise<boolean> {
    let ok = true;
    this.trackInflight(to, 1);
    const task = this.replyChain
      .then(async () => {
        await this.waitGap();
        await sender().catch((e) => {
          ok = false;
          this.deps.onSendError(e);
        });
        this.lastSendAt = this.deps.now();
      })
      .catch((e) => {
        ok = false;
        this.deps.log("error", `${label} chain error:`, String(e));
      })
      .finally(() => this.trackInflight(to, -1));
    this.replyChain = task;
    await task;
    return ok;
  }

  /**
   * 发一张图片：与文本共用串行链和最小间隔，避免图片与进度/任务推送并发乱序。
   * 返回是否发出——图片无法像文本那样挂起补发（没有可重放的文本），失败由调用方在文字里附原链接。
   */
  sendImageOrdered(to: string, ctx: string | undefined, image: Buffer): Promise<boolean> {
    return this.sendMediaOrdered(to, () => this.deps.sendImage(to, ctx, image), "send image");
  }

  /** 发一个文件/视频；语义与 sendImageOrdered 相同。 */
  sendFileOrdered(
    to: string,
    ctx: string | undefined,
    data: Buffer,
    fileName: string,
    kind: MediaKind,
  ): Promise<boolean> {
    return this.sendMediaOrdered(
      to,
      () => this.deps.sendFile(to, ctx, data, fileName, kind),
      "send file",
    );
  }

  /**
   * 发一个结构化进度 item；失败时回退成一条文本进度（同一串行位，不额外等间隔）。
   * item 本身不占连发额度，但回退文本是用户可见消息：`onFallback` 在文本确实发出后由调用方补记账。
   * 返回是否至少有一种形式发出。
   */
  async sendItemOrdered(
    to: string,
    ctx: string | undefined,
    item: MessageItem,
    fallbackText?: string,
    onFallback?: () => void,
  ): Promise<boolean> {
    return this.sendMediaOrdered(
      to,
      async () => {
        try {
          // 真机（2026-11-09）客户端不显示用 GENERATING 发送的工具 item；官方 2.4.10 示例与实现都用 FINISH，这里对齐。
          // 文本进度仍用 GENERATING（FINISH 会结束当前发送窗口），只有结构化 item 用 FINISH。
          await this.deps.sendItem(to, ctx, item, MessageState.FINISH);
        } catch (e) {
          // 回退成功就不算投递失败；真正失败由 sendMediaOrdered 统一交给 onSendError。
          if (!fallbackText) throw e;
          this.deps.log("warn", "send item failed, fallback to text:", String(e));
          await this.deps.sendText(to, ctx, fallbackText, MessageState.GENERATING);
          // 只有文本真的发出去才记账：item 不占额度、不抑制固定提示，回退文本要按可见进度补上。
          onFallback?.();
        }
      },
      "send item",
    );
  }

  /**
   * 发一条「必须送达」的答复：先计入连发额度再排队。
   * 计数后仍走同一条串行链，保证与进度/答案不乱序、遵守最小间隔。
   */
  sendNotice(
    to: string,
    ctx: string | undefined,
    text: string,
    fallbackToken?: string,
  ): Promise<void> {
    this.budgetOf(to).count += 1;
    return this.sendOrdered(to, ctx, text, MessageState.FINISH, fallbackToken, (e) =>
      this.holdUndelivered(to, text, e),
    );
  }

  /** 把长回复作为 .md 文件发送（走同一串行链+节流）；发文件失败则兜底回退为文本。 */
  sendMdOrdered(
    to: string,
    ctx: string | undefined,
    finalText: string,
    fallbackToken?: string,
    onError?: (e: unknown) => void,
  ): Promise<void> {
    this.trackInflight(to, 1);
    this.replyChain = this.replyChain
      .then(async () => {
        await this.waitGap();
        try {
          await this.deps.sendFileMd(to, ctx, finalText);
        } catch (e) {
          this.deps.log("warn", "send md file failed, fallback to text:", String(e));
          await this.deps
            .sendText(to, ctx, finalText, MessageState.FINISH, fallbackToken)
            .catch((er) => {
              this.deps.onSendError(er);
              onError?.(er);
            });
        }
        this.lastSendAt = this.deps.now();
      })
      .catch((e) => this.deps.log("error", "send md chain error:", String(e)))
      .finally(() => this.trackInflight(to, -1));
    return this.replyChain;
  }

  /** -2 且该用户还没在本进程发过消息 → 旧 token，挂起等新 token 补发；限流与其它错误只记日志。 */
  holdUndelivered(to: string, text: string, e: unknown): void {
    if (!this.deps.isParamError(e) || this.freshTokenUsers.has(to)) return;
    const n = this.deps.pending.push(to, text);
    this.deps.log(
      "warn",
      `send -2（旧 token）→ 挂起，累计 ${n} 条，等该用户下一条消息补发（${to}）`,
    );
  }

  /** 补发又失败：重新挂起，试够上限就放弃——防一条永远被服务端拒绝的内容每次发消息都拖着串行链。 */
  requeueHeld(to: string, text: string, tries: number, e: unknown): void {
    const n = tries + 1;
    if (n >= PENDING_PUSH_MAX_TRIES) {
      this.deps.log(
        "error",
        `补发 ${n} 次仍失败 → 放弃这条挂起的推送（${to}）：${text.slice(0, 40)}（原因：${e instanceof Error ? e.message : String(e)}）`,
      );
      return;
    }
    const size = this.deps.pending.push(to, text, n);
    this.deps.log("warn", `补发 ${n} 次仍失败 → 重新挂起，累计 ${size} 条（${to}）`);
  }

  /** 新 token 到了：按序补发，受单轮批量与「给最终答案留两条」双重限制；剩下的留给后续消息。 */
  flushHeldPushes(to: string, token: string): void {
    const room = Math.max(0, this.deps.consecLimit - 2 - this.budgetOf(to).count);
    if (room === 0) {
      this.deps.log(
        "info",
        `挂起 ${this.deps.pending.size(to)} 条，但本回合连发额度已不够 → 留给后续消息补发（${to}）`,
      );
      return;
    }
    const held = this.deps.pending.take(to, Math.min(this.deps.pendingBatch, room));
    if (held.length === 0) return;
    const rest = this.deps.pending.size(to);
    this.deps.log(
      "info",
      `新 token 已到 → 补发挂起消息 ${held.length} 条（${to}）${rest > 0 ? `，还有 ${rest} 条排在后续消息` : ""}`,
    );
    for (const item of held) {
      this.budgetOf(to).count += 1;
      void this.sendOrdered(to, token, item.text, MessageState.FINISH, token, (e) =>
        this.requeueHeld(to, item.text, item.tries, e),
      );
    }
  }

  /** 大脑回合接近连发上限时，任务推送先让出最后一条额度给最终答案。 */
  deferTaskPush(to: string, text: string): number {
    const list = this.deferredTaskPushes.get(to) ?? [];
    list.push(text);
    this.deferredTaskPushes.set(to, list);
    return list.length;
  }

  takeDeferredTaskPushes(to: string): string[] {
    const list = this.deferredTaskPushes.get(to);
    if (!list) return [];
    this.deferredTaskPushes.delete(to);
    return list;
  }

  /** 回合结束后补发被让位的任务推送：还有额度就立刻发；没有就转挂起队列，等该用户下一条消息。 */
  flushDeferredTaskPushes(to: string, token: string | undefined, finalSendFailed: boolean): void {
    const items = this.takeDeferredTaskPushes(to);
    if (items.length === 0) return;
    const b = this.budgetOf(to);
    for (const text of items) {
      if (!finalSendFailed && b.count < this.deps.consecLimit) {
        b.count += 1;
        void this.sendOrdered(to, token, text, MessageState.FINISH, token, (e) =>
          this.holdUndelivered(to, text, e),
        );
      } else {
        const n = this.deps.pending.push(to, text);
        this.deps.log(
          "info",
          `任务推送让位后仍无额度 → 挂起，等该用户下一条消息补发（累计 ${n} 条，${to}）`,
        );
      }
    }
  }

  /** 等串行链上已排队的发送全部落定（测试用；运行代码无需调用）。 */
  async idle(): Promise<void> {
    await this.replyChain;
  }
}
