import { DATA_DIR } from "@wemind/wechat-ilink-core";

import { brainSessionMapPath, clearSessionPointer, sessionKey } from "./session-map.js";
import {
  REGISTRY_VERSION,
  loadRegistry,
  saveRegistry,
  upsertEntry,
  type SessionEntry,
  type SessionRegistry,
} from "./registry-store.js";
import { listSessions, resolveRef, validateSessionName } from "./registry-view.js";

export * from "./registry-store.js";
export * from "./registry-view.js";

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
 *
 * 本文件是**统一入口**：存储与视图分别在 `registry-store.ts` / `registry-view.ts`，这里只保留需要同时用到两层的
 * `renameSession` / `deleteSession`，并 re-export 两层的全部导出（外部 import 路径不变）。
 */

export type SessionOpResult =
  | { ok: true; entry: SessionEntry; clearedPointer: boolean }
  | { ok: false; error: string };

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
