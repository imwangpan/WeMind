/**
 * 会话守卫：处理服务端 errcode -14（bot 会话超时）。
 * 命中后对该账号进入 1 小时冷却，期间快速返回而非反复长轮询空转。
 * 逻辑借鉴自官方 Tencent/openclaw-weixin（MIT），按 MCP 请求驱动场景精简。
 */

/** 服务端返回的会话超时错误码。 */
export const SESSION_EXPIRED_ERRCODE = -14;

const PAUSE_MS = 60 * 60 * 1000;
const pauseUntil = new Map<string, number>();

/** 命中 -14 后暂停该账号一小时。 */
export function pauseSession(accountId: string): void {
  pauseUntil.set(accountId, Date.now() + PAUSE_MS);
}

/** 距离冷却结束的剩余毫秒数（未暂停时为 0）。 */
export function getRemainingPauseMs(accountId: string): number {
  const until = pauseUntil.get(accountId);
  if (until === undefined) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    pauseUntil.delete(accountId);
    return 0;
  }
  return remaining;
}

export function isSessionPaused(accountId: string): boolean {
  return getRemainingPauseMs(accountId) > 0;
}

/** 重新登录成功后清除冷却。 */
export function clearSessionPause(accountId: string): void {
  pauseUntil.delete(accountId);
}
