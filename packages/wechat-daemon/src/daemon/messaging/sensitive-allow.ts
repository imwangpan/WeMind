/**
 * 「允许敏感文件」的临时放行窗口：微信里发一次指令，窗口内大脑回复里的 [附件] 链接可以发 account.json 等
 * 凭证/状态文件；窗口外一律按 `isSensitiveFilePath` 拒绝。
 *
 * 状态只在本 daemon 进程内（一个账号一个 daemon），不写磁盘、不读环境：重启即失效，
 * 避免把「这一次」变成常驻开关。放行只跳过敏感名单，其余闸门（本地绝对路径、UNC/NTFS 数据流、
 * 大小上限）照旧生效。
 *
 * 被拦下时会把附件路径记进内存（按用户、TTL 30 分钟、最多 20 条）：用户回复「允许敏感文件」时
 * 先开窗口再补发，因此「先放行再发」和「先拦截再放行」两种顺序都成立。
 */
import type { MediaKind } from "@wemind/wechat-ilink-core";

const DEFAULT_WINDOW_MINUTES = 2;
const MAX_WINDOW_MINUTES = 30;

let allowUntil = 0;

/** 开一个放行窗口（分钟数夹到 1–30），返回实际截止时间与生效分钟数。 */
export function armSensitiveAllow(
  minutes?: number,
  now = Date.now(),
): { until: number; minutes: number } {
  const m = Math.min(
    Math.max(Math.floor(minutes ?? DEFAULT_WINDOW_MINUTES), 1),
    MAX_WINDOW_MINUTES,
  );
  allowUntil = now + m * 60_000;
  return { until: allowUntil, minutes: m };
}

/** 当前是否在放行窗口内。 */
export function sensitiveAllowActive(now = Date.now()): boolean {
  return now < allowUntil;
}

/** 距窗口结束还有多少毫秒（未开启/已过期 → 0）。 */
export function sensitiveAllowRemainingMs(now = Date.now()): number {
  return Math.max(0, allowUntil - now);
}

/** 清掉窗口（单测与 daemon 退出用）。 */
export function resetSensitiveAllow(): void {
  allowUntil = 0;
}

export const SENSITIVE_ALLOW_LIMITS = {
  defaultMinutes: DEFAULT_WINDOW_MINUTES,
  maxMinutes: MAX_WINDOW_MINUTES,
} as const;

const PENDING_TTL_MS = 30 * 60_000;
const MAX_PENDING_PER_USER = 20;

export type PendingSensitiveAttachment = {
  /** 原始链接里的路径（补发时会重新做完整校验）。 */
  src: string;
  /** `[视频]` 标签指定的类型；没写标签时按扩展名判断。 */
  kind?: MediaKind;
};

type PendingEntry = { item: PendingSensitiveAttachment; at: number };
const pendingByUser = new Map<string, Map<string, PendingEntry>>();

function prune(userId: string, now: number): Map<string, PendingEntry> | undefined {
  const m = pendingByUser.get(userId);
  if (!m) return undefined;
  for (const [src, entry] of m) if (now - entry.at > PENDING_TTL_MS) m.delete(src);
  if (m.size === 0) pendingByUser.delete(userId);
  return m.size ? m : undefined;
}

/** 记下被敏感名单拦下的附件（同一路径只留一条）；返回该用户当前待补发数量。 */
export function rememberPendingSensitive(
  userId: string,
  items: PendingSensitiveAttachment[],
  now = Date.now(),
): number {
  if (items.length === 0) return pendingByUser.get(userId)?.size ?? 0;
  const m = prune(userId, now) ?? new Map<string, PendingEntry>();
  pendingByUser.set(userId, m);
  for (const item of items) {
    // 同一路径重复出现时保留已有的显式类型（后一次没写标签不该把 [文件] 变回按扩展名猜）。
    const merged: PendingSensitiveAttachment = { src: item.src };
    const kind = item.kind ?? m.get(item.src)?.item.kind;
    if (kind) merged.kind = kind;
    m.set(item.src, { item: merged, at: now });
  }
  // 兜底：只留最近的 N 条，避免长期运行时无限累积。
  while (m.size > MAX_PENDING_PER_USER) {
    let oldestSrc: string | undefined;
    let oldestAt = Infinity;
    for (const [src, entry] of m)
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestSrc = src;
      }
    if (!oldestSrc) break;
    m.delete(oldestSrc);
  }
  return m.size;
}

/** 取走该用户全部待补发附件（含清空）；过期的直接丢弃。 */
export function takePendingSensitive(
  userId: string,
  now = Date.now(),
): PendingSensitiveAttachment[] {
  const m = prune(userId, now);
  if (!m) return [];
  const out = [...m.values()].sort((a, b) => a.at - b.at).map((entry) => entry.item);
  pendingByUser.delete(userId);
  return out;
}

/** 待补发数量（帮助文案与测试用）。 */
export function pendingSensitiveCount(userId: string, now = Date.now()): number {
  return prune(userId, now)?.size ?? 0;
}

/** 清空全部待补发记录（单测与 daemon 退出用）。 */
export function resetPendingSensitive(): void {
  pendingByUser.clear();
}
