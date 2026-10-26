/**
 * brainstorm/worker 共用的 session 映射键规则：`<agent>:<key>`。
 * 换大脑后各 agent 的会话互不覆盖，切回原大脑仍能 session/load 回原上下文。
 */
export function sessionKey(agent: string, key: string): string {
  return `${agent}:${key}`;
}

/**
 * 把磁盘上的映射归一成 `<agent>:<key>` 形式。
 * - 已带前缀的条目原样保留（其它 agent 的会话不动）；
 * - 旧格式（裸 key）由「当时那个 agent」写入、已无从得知是哪个 → 归给当前 agent；
 *   若同名的新格式条目已存在，则保留新格式（它的归属确定），只丢掉裸条目。
 * migrated=true 时调用方应立即回写，避免下次换 agent 时旧条目再被继承一次。
 */
export function normalizeSessionMap(
  raw: unknown,
  agent: string,
): { map: Record<string, string>; migrated: boolean } {
  const map: Record<string, string> = {};
  const legacy: Array<[string, string]> = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { map, migrated: false };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    if (k.includes(":")) map[k] = v;
    else legacy.push([k, v]);
  }
  for (const [k, v] of legacy) {
    const nk = sessionKey(agent, k);
    if (!map[nk]) map[nk] = v;
  }
  return { map, migrated: legacy.length > 0 };
}
