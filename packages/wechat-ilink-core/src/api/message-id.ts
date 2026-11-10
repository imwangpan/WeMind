/**
 * uint64 消息 ID 的无损处理。
 *
 * iLink 的 message_id/msg_id/svr_id 是 uint64，wire 上是 JSON 数字。JS 的 number 只有
 * 53 位精度，直接 JSON.parse 会把相邻 ID 折叠成同一个值，导致游标比较漏消息。
 * 官方 openclaw-weixin 2.4.10 的做法是在 JSON.parse 之前给这些字段的数字加引号；
 * 这里复刻同一思路，并统一用 BigInt 做比较。
 */

const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);

/**
 * 解析 JSON，并把 message_id/msg_id/svr_id 的数字值无损转成字符串。
 * 只改写对象属性，不会误伤字符串内容。
 */
export function parseJsonWithLosslessIds<T>(rawText: string, label: string): T {
  let output = "";
  let index = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output += rawText[index++];
      continue;
    }

    const stringStart = index;
    index++;
    let escaped = false;
    while (index < rawText.length) {
      const char = rawText[index++];
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        break;
      }
    }
    const stringToken = rawText.slice(stringStart, index);
    output += stringToken;

    let cursor = index;
    while (/\s/.test(rawText[cursor] ?? "")) cursor++;
    if (rawText[cursor] !== ":") continue;

    let key: unknown;
    try {
      key = JSON.parse(stringToken);
    } catch {
      continue;
    }
    if (typeof key !== "string" || !LOSSLESS_ID_FIELDS.has(key)) continue;

    output += rawText.slice(index, cursor + 1);
    cursor++;
    while (/\s/.test(rawText[cursor] ?? "")) {
      output += rawText[cursor++];
    }
    const numberStart = cursor;
    // 吃掉完整的 JSON number token（含小数/指数），否则 `1.5` 会被截成 `1` 再拼上 `.5`，
    // 把整段 JSON 改坏、让每次长轮询都解析失败。ID 按协议是整数：只给整数加引号。
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      rawText.slice(numberStart),
    )?.[0];
    if (token) {
      output += /^-?\d+$/.test(token) ? `"${token}"` : token;
      index = numberStart + token.length;
    } else {
      index = numberStart;
    }
  }

  try {
    return JSON.parse(output) as T;
  } catch {
    try {
      const parsed = JSON.parse(rawText) as T;
      // 只有「原文合法、改写后反而非法」才可能是改写逻辑坏了：留一条告警，别静默把 bug 藏起来；非 JSON 响应（如 sendMessage 的 OK、代理 HTML）是上游问题，不打这条。
      console.warn(
        `[wemind/wechat-ilink-core] ${label}：ID 无损改写后的 JSON 解析失败，但原始文本合法，已退回原文（请检查改写逻辑）`,
      );
      return parsed;
    } catch {
      throw new Error(`${label}：响应不是合法 JSON（${rawText.slice(0, 120)}）`);
    }
  }
}

/** 把历史 number 状态/任意值规范成 uint64 字符串；非法值回退 "0"。 */
export function normalizeMessageId(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || "0";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // 历史 state.json 里是 number。不要用 BigInt(number)：那会暴露 double 的精确二进制值
    // （如 ...55000 实际是 ...55136），反而可能把游标推高、跳过消息。String(number) 给的是
    // 最短十进制表示，更接近文件里当初写下的值；超出 1e21 的指数形式再退回 BigInt。
    const s = String(Math.trunc(value));
    if (/^\d+$/.test(s)) return s;
    try {
      return BigInt(Math.trunc(value)).toString();
    } catch {
      return "0";
    }
  }
  return "0";
}

function toBigInt(id: string): bigint | null {
  try {
    return BigInt(id);
  } catch {
    return null;
  }
}

/** 比较两个消息 ID（按 uint64 数值）。非数字字符串按字典序兜底。 */
export function compareMessageIds(a: string, b: string): number {
  const na = toBigInt(a);
  const nb = toBigInt(b);
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  if (na !== null) return 1;
  if (nb !== null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 取较大的消息 ID；用于推进游标。 */
export function maxMessageId(a: string, b: string): string {
  return compareMessageIds(a, b) >= 0 ? a : b;
}

/** 把 ID 记入最近处理环形表（去重 + 限长）。 */
export function rememberMessageId(seen: string[], id: string, max = 200): string[] {
  if (!id || seen.includes(id)) return seen;
  const next = [...seen, id];
  return next.length > max ? next.slice(next.length - max) : next;
}
