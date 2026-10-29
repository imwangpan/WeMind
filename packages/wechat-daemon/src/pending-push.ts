/**
 * 「必须送达」外发的挂起队列（重启后旧 context_token 期间）。
 *
 * 背景：daemon 启动时 `state.contextTokens` 里还是上次运行留下的 context_token，服务端已经认不得；新 token 只有该用户发来下一条消息时才会到（`index.ts` 的 poller 登记处）。这段时间里任务结果、CLI 指令答复这类「不在某个回合里」的推送会 ret=-2 失败，重试一次仍是旧 token，消息直接丢失。
 *
 * 做法：失败时按收件人把文本挂起（内存队列），等新 token 到达时按原顺序补发。队列只在内存里，daemon 再重启一次就丢（任务结果仍能在 `任务列表`/`tasks.json` 里看到）。
 */
export const PENDING_PUSH_LIMIT = 20;
/** 一条推送最多补发几次（首次补发 + 失败后重挂 = 每次该用户发消息时试一次）；超过就放弃并记日志——防一条内容永远被服务端拒绝的消息每次都拖着 replyChain。 */
export const PENDING_PUSH_MAX_TRIES = 3;

export type PendingPush = { text: string; tries: number };

export class PendingPushes {
  private readonly queues = new Map<string, PendingPush[]>();
  private readonly limit: number;

  constructor(limit: number = PENDING_PUSH_LIMIT) {
    this.limit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : PENDING_PUSH_LIMIT;
  }

  /** 挂起一条（按收件人分开；`tries` 为已经补发失败的次数）；超过上限丢最旧的——保留最新的更可能还有用。返回该收件人当前挂起的条数。 */
  push(to: string, text: string, tries = 0): number {
    const q = this.queues.get(to) ?? [];
    q.push({ text, tries });
    if (q.length > this.limit) q.splice(0, q.length - this.limit);
    this.queues.set(to, q);
    return q.length;
  }

  /** 取走该收件人最前面至多 `max` 条（按入队顺序）；没取走的留在队里。没有则返回空数组。 */
  take(to: string, max: number = Number.POSITIVE_INFINITY): PendingPush[] {
    const q = this.queues.get(to);
    if (!q || q.length === 0) return [];
    const n = Math.max(0, Math.min(q.length, Math.floor(max)));
    const out = q.splice(0, n);
    if (q.length === 0) this.queues.delete(to);
    return out;
  }

  /** 该收件人当前挂起多少条。 */
  size(to: string): number {
    return this.queues.get(to)?.length ?? 0;
  }

  /** 全部收件人的挂起总条数（日志用）。 */
  total(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }
}
