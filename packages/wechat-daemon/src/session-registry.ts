import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";
import {
  brainSessionMapPath,
  clearSessionPointer,
  readSessionMap,
  sessionKey,
} from "./session-map.js";

/**
 * 会话登记表（`<数据目录>/session-registry.json`）：跨大脑记住「这个人有哪些会话」，
 * 让「会话列表 / 恢复会话 / 重命名 / 删除」有东西可列——`brain-sessions.json` 只存**当前那一个**会话的 id，
 * 一开新会话，旧的就失去引用、无处可恢复。
 *
 * 为什么与 `brain-sessions.json` 分开：
 *  - 当前会话表在关键路径上（ensureSession → session/load）且已背了一层旧格式迁移（见 session-map.ts）；
 *    把它的值从 string 改成 object 要再迁一次，还会波及 worker 的孪生代码。
 *  - 登记表是**派生元数据**：损坏/丢失只应导致「列表空」，绝不能影响恢复。
 * 因此一致性的规则是：**当前会话表唯一权威地表示「当前是哪个」**；登记表只供列表，且自己**不存 current**
 * （渲染时才与当前会话记录比对）；`删除会话` 若是当前那条，则同时清当前会话记录（下一次消息自然开新的）。
 *
 * 写入方只有 daemon（或 CLI 经控制桥，见 control-bridge.ts），避免多写者互相覆盖。
 * 所有写入走 tmp + rename；所有读取失败都降级为空表，只记日志、不抛——它不该有能力拖垮 daemon。
 */

export type SessionEntry = {
  /** 所属大脑（agent 名，小写）。 */
  agent: string;
  /** 会话属于谁（微信 userId）；登记表按人隔离，别人的会话列不出来。 */
  userId: string;
  /** ACP sessionId。 */
  sessionId: string;
  /** 用户起的名字（可寻址：`恢复会话 项目A`）；命名后不会被淘汰。 */
  name?: string;
  /** 首条用户消息的前若干字，作列表里的摘要。 */
  title?: string;
  /** 成功回合数（列表里的「轮次」）。 */
  turns: number;
  createdAt: number;
  lastUsedAt: number;
  /** 来自当前会话表回填（功能上线前就存在的会话，没有真实时间/轮次）。 */
  backfilled?: boolean;
};

export type SessionRegistry = { version: number; entries: SessionEntry[] };

export const REGISTRY_VERSION = 1;

/** 每个 (agent, userId) 的条数上限；超出先淘汰「未命名且最旧」的。 */
export const MAX_ENTRIES_PER_KEY = Number(process.env.WEMIND_SESSION_LOG_MAX) || 50;

/** 列表分页大小。 */
export const PAGE_SIZE = Number(process.env.WEMIND_SESSION_PAGE_SIZE) || 10;

export function registryPath(dir: string = DATA_DIR): string {
  return path.join(dir, "session-registry.json");
}

/** 归一化一条记录；缺 agent/userId/sessionId 视为无效（丢弃）。 */
function normEntry(e: any, now: number): SessionEntry | null {
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  const agent = typeof e.agent === "string" ? e.agent.trim().toLowerCase() : "";
  const userId = typeof e.userId === "string" ? e.userId.trim() : "";
  const sessionId = typeof e.sessionId === "string" ? e.sessionId.trim() : "";
  if (!agent || !userId || !sessionId) return null;
  const num = (v: unknown, d: number): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d;
  const out: SessionEntry = {
    agent,
    userId,
    sessionId,
    turns: Math.trunc(num(e.turns, 0)),
    createdAt: num(e.createdAt, now),
    lastUsedAt: num(e.lastUsedAt, now),
  };
  if (typeof e.name === "string" && e.name.trim()) out.name = e.name.trim();
  if (typeof e.title === "string" && e.title.trim()) out.title = e.title.trim();
  if (e.backfilled === true) out.backfilled = true;
  return out;
}

/** 读登记表；缺失/损坏 → 空表（幂等、不抛）。 */
export function loadRegistry(dir: string = DATA_DIR, now: number = Date.now()): SessionRegistry {
  let j: any;
  try {
    j = JSON.parse(fs.readFileSync(registryPath(dir), "utf-8"));
  } catch {
    return { version: REGISTRY_VERSION, entries: [] };
  }
  const entries: SessionEntry[] = [];
  if (j && typeof j === "object" && Array.isArray(j.entries)) {
    for (const e of j.entries) {
      const n = normEntry(e, now);
      if (n) entries.push(n);
    }
  }
  return { version: REGISTRY_VERSION, entries };
}

/** 原子写登记表。写失败只记日志、**不抛**：登记表是派生元数据，绝不能因为一次磁盘问题拖垮一个回合或一次启动。 */
export function saveRegistry(reg: SessionRegistry, dir: string = DATA_DIR): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const fp = registryPath(dir);
    const tmp = `${fp}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, fp);
  } catch (e) {
    console.error("[wemind/wechat-daemon] session-registry save failed:", String(e));
  }
}

// ---- 纯函数（可直接单测） ----

/** 最近使用在前；同刻按创建时间。 */
export function sortEntries(list: SessionEntry[]): SessionEntry[] {
  return [...list].sort(
    (a, b) =>
      b.lastUsedAt - a.lastUsedAt ||
      b.createdAt - a.createdAt ||
      a.sessionId.localeCompare(b.sessionId),
  );
}

/**
 * 按 (agent, userId) 分组做条数裁剪：超出上限时先淘汰「未命名且最旧」的；
 * 仍然超出才动有名字的。`keep`（当前会话）永不淘汰。
 * 非本组的条目原样保留。
 */
export function capEntries(
  list: SessionEntry[],
  agent: string,
  userId: string,
  max: number,
  keep: string[] = [],
): SessionEntry[] {
  const a = agent.trim().toLowerCase();
  const group = list.filter((e) => e.agent === a && e.userId === userId);
  if (group.length <= max) return list;
  const keepSet = new Set(keep);
  const oldestFirst = [...group].sort(
    (x, y) => x.lastUsedAt - y.lastUsedAt || x.createdAt - y.createdAt,
  );
  const dropped = new Set<string>();
  for (const pass of [true, false]) {
    for (const e of oldestFirst) {
      if (group.length - dropped.size <= max) break;
      if (keepSet.has(e.sessionId) || dropped.has(e.sessionId)) continue;
      if (pass && e.name) continue; // 第一轮只淘汰未命名的
      dropped.add(e.sessionId);
    }
  }
  return list.filter((e) => !(e.agent === a && e.userId === userId && dropped.has(e.sessionId)));
}

/** 插入/更新一条记录（同 agent+userId+sessionId 视为同一条），并做裁剪。 */
export function upsertEntry(
  list: SessionEntry[],
  entry: SessionEntry,
  opts: { max?: number; keep?: string[] } = {},
): SessionEntry[] {
  const next = list.filter(
    (e) =>
      !(e.agent === entry.agent && e.userId === entry.userId && e.sessionId === entry.sessionId),
  );
  next.push(entry);
  return capEntries(next, entry.agent, entry.userId, opts.max ?? MAX_ENTRIES_PER_KEY, [
    entry.sessionId,
    ...(opts.keep ?? []),
  ]);
}

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

// ---- 读写入口（daemon / CLI 经桥调用） ----

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

/** 当前会话表里该人当前的会话 id（登记表不存 current，渲染时才比对）。 */
export function currentSessionIdOf(
  agent: string,
  userId: string,
  dir: string = DATA_DIR,
): string | undefined {
  return readSessionMap(brainSessionMapPath(dir))[sessionKey(agent.trim().toLowerCase(), userId)];
}

/** 新建会话时登记（`turns` 从 0 起）；已存在则只补 name/keep，不动时间与轮次。 */
export function ensureEntry(
  agent: string,
  userId: string,
  sessionId: string,
  opts: { name?: string; keep?: string[]; dir?: string; now?: number } = {},
): void {
  const a = agent.trim().toLowerCase();
  const now = opts.now ?? Date.now();
  const reg = loadRegistry(opts.dir, now);
  const hit = reg.entries.find(
    (e) => e.agent === a && e.userId === userId && e.sessionId === sessionId,
  );
  if (hit) {
    let changed = false;
    if (opts.name && hit.name !== opts.name) {
      hit.name = opts.name;
      changed = true;
    }
    if (changed) saveRegistry(reg, opts.dir);
    return;
  }
  const entry: SessionEntry = {
    agent: a,
    userId,
    sessionId,
    turns: 0,
    createdAt: now,
    lastUsedAt: now,
  };
  if (opts.name) entry.name = opts.name;
  const next: SessionRegistry = {
    version: REGISTRY_VERSION,
    entries: upsertEntry(reg.entries, entry, { keep: opts.keep }),
  };
  saveRegistry(next, opts.dir);
}

/**
 * 每完成一个成功回合调用：`lastUsedAt` 刷新、轮次 +1、标题（首条消息摘要）仅首次写入。
 * `turns` 传绝对值时直接覆盖（恢复旧会话后的首次校准用）。
 */
export function touchEntry(
  agent: string,
  userId: string,
  sessionId: string,
  opts: { title?: string; turns?: number; keep?: string[]; dir?: string; now?: number } = {},
): void {
  const a = agent.trim().toLowerCase();
  const now = opts.now ?? Date.now();
  const reg = loadRegistry(opts.dir, now);
  const hit = reg.entries.find(
    (e) => e.agent === a && e.userId === userId && e.sessionId === sessionId,
  );
  if (!hit) {
    const entry: SessionEntry = {
      agent: a,
      userId,
      sessionId,
      turns: opts.turns ?? 1,
      createdAt: now,
      lastUsedAt: now,
    };
    if (opts.title) entry.title = opts.title;
    const next: SessionRegistry = {
      version: REGISTRY_VERSION,
      entries: upsertEntry(reg.entries, entry, { keep: opts.keep }),
    };
    saveRegistry(next, opts.dir);
    return;
  }
  hit.lastUsedAt = now;
  hit.turns = opts.turns ?? hit.turns + 1;
  if (opts.title && !hit.title) hit.title = opts.title;
  hit.backfilled = undefined;
  const next: SessionRegistry = {
    version: REGISTRY_VERSION,
    entries: upsertEntry(reg.entries, hit, { keep: opts.keep }),
  };
  saveRegistry(next, opts.dir);
}

export type SessionOpResult =
  | { ok: true; entry: SessionEntry; clearedPointer: boolean }
  | { ok: false; error: string };

/**
 * 只刷新「最近使用」：把一条旧会话切回当前（`恢复会话`、切大脑后 load 回来的那条）时用。
 * 不动轮次、不写标题——它不是「又聊了一轮」。未登记时补一条（turns 0），
 * 否则「直接 load 一个登记表里没有的 id」会变成列表里看不见的会话。
 */
export function markUsed(
  agent: string,
  userId: string,
  sessionId: string,
  opts: { dir?: string; now?: number } = {},
): void {
  const a = agent.trim().toLowerCase();
  const now = opts.now ?? Date.now();
  const reg = loadRegistry(opts.dir, now);
  const hit = reg.entries.find(
    (e) => e.agent === a && e.userId === userId && e.sessionId === sessionId,
  );
  const entry: SessionEntry = hit ?? {
    agent: a,
    userId,
    sessionId,
    turns: 0,
    createdAt: now,
    lastUsedAt: now,
  };
  entry.lastUsedAt = now;
  entry.backfilled = undefined; // 现在有真实的使用时间了
  saveRegistry({ version: REGISTRY_VERSION, entries: upsertEntry(reg.entries, entry) }, opts.dir);
}

/** 改名（按引用解析）；命名后不会被条数裁剪淘汰。 */
export function renameSession(
  agent: string,
  userId: string,
  ref: string,
  name: string,
  dir: string = DATA_DIR,
): SessionOpResult {
  const bad = validateSessionName(name);
  if (bad) return { ok: false, error: bad };
  const a = agent.trim().toLowerCase();
  const { entries } = listSessions(a, userId, dir);
  const hit = resolveRef(ref, entries);
  if (!hit.ok) return { ok: false, error: hit.error };
  const reg = loadRegistry(dir);
  const target = reg.entries.find(
    (e) => e.agent === a && e.userId === userId && e.sessionId === hit.entry.sessionId,
  );
  const entry = target ?? hit.entry;
  entry.name = name.trim();
  saveRegistry({ version: REGISTRY_VERSION, entries: upsertEntry(reg.entries, entry) }, dir);
  return { ok: true, entry, clearedPointer: false };
}

/**
 * 删除登记项。删的若是当前会话，**同时清当前会话记录**（下一条消息自然开新的）——当前会话记录不清会让「删掉的会话」继续被使用。
 * agent 侧的历史归档不动（ACP 无可验证的 session/delete，如实告知用户）。
 */
export function deleteSession(
  agent: string,
  userId: string,
  ref: string,
  opts: { dir?: string } = {},
): SessionOpResult {
  const a = agent.trim().toLowerCase();
  const dir = opts.dir;
  const { entries, currentSessionId } = listSessions(a, userId, dir);
  const hit = resolveRef(ref, entries);
  if (!hit.ok) return { ok: false, error: hit.error };
  const reg = loadRegistry(dir);
  const next: SessionRegistry = {
    version: REGISTRY_VERSION,
    entries: reg.entries.filter(
      (e) => !(e.agent === a && e.userId === userId && e.sessionId === hit.entry.sessionId),
    ),
  };
  saveRegistry(next, dir);
  const clearedPointer =
    currentSessionId === hit.entry.sessionId
      ? clearSessionPointer(brainSessionMapPath(dir ?? DATA_DIR), sessionKey(a, userId))
      : false;
  return { ok: true, entry: hit.entry, clearedPointer };
}

/**
 * 一次性回填：把当前会话表里存在、登记表里还没有的会话补进去（功能上线前的老会话）。
 * 只由 daemon 启动时调用（幂等）；之后会话的登记走 ensureEntry/touchEntry。
 */
export function syncFromPointerMap(dir: string = DATA_DIR, now: number = Date.now()): number {
  const map = readSessionMap(brainSessionMapPath(dir));
  const reg = loadRegistry(dir, now);
  let added = 0;
  for (const [k, sid] of Object.entries(map)) {
    const i = k.indexOf(":");
    if (i <= 0 || !sid) continue;
    const agent = k.slice(0, i).trim().toLowerCase();
    const userId = k.slice(i + 1).trim();
    if (!agent || !userId) continue;
    if (reg.entries.some((e) => e.agent === agent && e.userId === userId && e.sessionId === sid))
      continue;
    reg.entries.push({
      agent,
      userId,
      sessionId: sid,
      turns: 0,
      createdAt: now,
      lastUsedAt: now,
      backfilled: true,
    });
    added++;
  }
  if (added) saveRegistry(reg, dir);
  return added;
}
