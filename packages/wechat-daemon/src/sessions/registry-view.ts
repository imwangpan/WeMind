import { DATA_DIR } from "@wemind/wechat-ilink-core";

import {
  currentSessionIdOf,
  loadRegistry,
  sortEntries,
  type SessionEntry,
} from "./registry-store.js";

/**
 * 会话登记表的**视图层**：引用解析、名字校验、列表渲染与 listSessions（只读）。
 * 依赖 registry-store，不反向。
 */

/** 列表分页大小。 */
export const PAGE_SIZE = Number(process.env.WEMIND_SESSION_PAGE_SIZE) || 10;

export type RefHit =
  | { ok: true; entry: SessionEntry; index: number }
  | { ok: false; error: string };

/**
 * 解析「会话引用」：序号（1 起）> 名字（先精确后忽略大小写）> id 精确 > id 前缀。
 * 歧义不猜——给出前 5 个候选让用户挑。
 */
export function resolveRef(ref: string, list: SessionEntry[]): RefHit {
  const r = (ref ?? "").trim();
  if (!r) return { ok: false, error: "需要指定会话（序号 / 名字 / id 前缀）。" };
  if (!list.length) return { ok: false, error: "还没有历史会话。" };
  if (/^\d+$/.test(r)) {
    const n = Number(r);
    if (n >= 1 && n <= list.length) return { ok: true, entry: list[n - 1], index: n };
    return { ok: false, error: `序号超范围：共 ${list.length} 条。` };
  }
  const brief = (e: SessionEntry): string => e.name ?? e.title ?? e.sessionId.slice(0, 8);
  const byName = list.filter((e) => e.name === r);
  if (byName.length === 1)
    return { ok: true, entry: byName[0], index: list.indexOf(byName[0]) + 1 };
  if (byName.length > 1)
    return {
      ok: false,
      error: `有 ${byName.length} 条会话都叫「${r}」，请用序号：${byName
        .slice(0, 5)
        .map((e) => list.indexOf(e) + 1)
        .join("、")}。`,
    };
  const lower = r.toLowerCase();
  const byNameI = list.filter((e) => e.name?.toLowerCase() === lower);
  if (byNameI.length === 1)
    return { ok: true, entry: byNameI[0], index: list.indexOf(byNameI[0]) + 1 };
  if (byNameI.length > 1)
    return {
      ok: false,
      error: `有 ${byNameI.length} 条会话都叫「${r}」，请用序号：${byNameI
        .slice(0, 5)
        .map((e) => list.indexOf(e) + 1)
        .join("、")}。`,
    };
  const exact = list.find((e) => e.sessionId === r);
  if (exact) return { ok: true, entry: exact, index: list.indexOf(exact) + 1 };
  if (r.length >= 2) {
    const hits = list.filter((e) => e.sessionId.startsWith(r));
    if (hits.length === 1) return { ok: true, entry: hits[0], index: list.indexOf(hits[0]) + 1 };
    if (hits.length > 1)
      return {
        ok: false,
        error: `id 前缀「${r}」匹配到 ${hits.length} 条：${hits.slice(0, 5).map(brief).join("、")}。`,
      };
  }
  return { ok: false, error: `没有找到会话「${r}」（序号 / 名字 / id 前缀）。` };
}

/** 会话名校验：合法返回 null，否则返回一句面向用户的原因。 */
export function validateSessionName(name: string): string | null {
  const n = (name ?? "").trim();
  if (!n) return "名字不能为空。";
  if (n.length > 20) return "名字最多 20 个字。";
  if (/^\d+$/.test(n)) return "名字不能是纯数字（会和列表序号混淆）。";
  if (/[\r\n\t]/.test(n)) return "名字不能包含换行/制表符。";
  return null;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 列表里的时间：同年只给月日时分，跨年补年份；没有真实时间（回填）的给「时间未知」。 */
export function formatWhen(ts: number, now: number = Date.now()): string {
  if (!ts) return "时间未知";
  const d = new Date(ts);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getFullYear() === new Date(now).getFullYear()
    ? `${md} ${hm}`
    : `${d.getFullYear()}-${md}`;
}

/** 列表里的标签：命名 > 首条消息摘要 > 短 id。 */
export function labelOf(e: SessionEntry, max = 24): string {
  const raw = e.name ? `「${e.name}」` : e.title ? e.title : `(未命名 ${e.sessionId.slice(0, 8)})`;
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

/**
 * 列表里的标题来源：用户消息的头 30 字（换行/多空格折叠成一个空格）。
 * 空文本返回 undefined（纯图片消息没有可当标题的文字）——留给下一次有文字的回合再写。
 */
export function titleOf(text: string, max = 30): string | undefined {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 渲染会话列表（微信侧）。`verbose` 追加完整 sessionId——CLI 侧有地方，微信侧靠序号/名字即可。
 */
export function renderSessionList(
  entries: SessionEntry[],
  opts: {
    agent: string;
    page?: number;
    pageSize?: number;
    currentSessionId?: string;
    others?: number;
    now?: number;
    verbose?: boolean;
  },
): string {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const total = entries.length;
  if (!total) {
    return `📋 当前大脑（${opts.agent}）还没有历史会话。\n发一条消息就会建第一条；「新会话 名字」可新建并命名。`;
  }
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(opts.page ?? 1)), pages);
  const slice = entries.slice((page - 1) * pageSize, page * pageSize);
  const lines = [`📋 会话列表（${opts.agent}，共 ${total} 条，第 ${page}/${pages} 页）`];
  slice.forEach((e, i) => {
    const idx = (page - 1) * pageSize + i + 1;
    const cur = e.sessionId === opts.currentSessionId ? " ← 当前" : "";
    const id = opts.verbose ? ` · id=${e.sessionId}` : "";
    lines.push(
      ` ${idx}. ${labelOf(e)} · ${formatWhen(e.lastUsedAt, opts.now)} · ${e.turns} 轮${cur}${id}`,
    );
  });
  if (pages > 1) lines.push(`（下一页：「会话列表 ${page + 1}」）`);
  lines.push(`回复「恢复会话 <序号|名字>」切过去；「重命名会话 3 新名字」「删除会话 3」亦可。`);
  if (opts.others) lines.push(`另有 ${opts.others} 条属于其它大脑的会话（切回该大脑后可恢复）。`);
  return lines.join("\n");
}

/** 当前大脑下、本人的会话 + 其它大脑的条数 + 当前会话记录。 */
export function listSessions(
  agent: string,
  userId: string,
  dir: string = DATA_DIR,
): { entries: SessionEntry[]; others: number; currentSessionId?: string } {
  const a = agent.trim().toLowerCase();
  const all = loadRegistry(dir).entries;
  const entries = sortEntries(all.filter((e) => e.agent === a && e.userId === userId));
  const others = all.filter((e) => e.agent !== a && e.userId === userId).length;
  return { entries, others, currentSessionId: currentSessionIdOf(a, userId, dir) };
}
