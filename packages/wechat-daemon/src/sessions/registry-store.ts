import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

import { writeJsonAtomic } from "../shared/io/atomic-json.js";
import { brainSessionMapPath, readSessionMap, sessionKey } from "./session-map.js";

/**
 * 会话登记表的**存储层**：类型、读写、条数裁剪、登记/刷新（无渲染）。
 * 读失败降级为空表，写失败只记日志——登记表是派生元数据，不能拖垮回合（见 session-registry.ts 顶部说明）。
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
    writeJsonAtomic(registryPath(dir), reg);
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
