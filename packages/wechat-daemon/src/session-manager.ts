import { DATA_DIR } from "@wemind/wechat-ilink-core";
import {
  currentSessionIdOf,
  deleteSession,
  ensureEntry,
  labelOf,
  listSessions,
  markUsed,
  renameSession,
  renderSessionList,
  resolveRef,
  validateSessionName,
} from "./session-registry.js";

/**
 * 会话管理的**操作层**：把「新会话 / 列表 / 恢复 / 重命名 / 删除」拼成一句回执。
 *
 * 为什么单独成模块（而不是写在 index.ts 的 handleControl 里）：
 *  - 恢复是**有副作用的两步**（严格恢复的 load → 成功才改当前会话记录），值得单独钉测试；
 *  - 依赖注入（`create`/`resume`）让测试不必起真 ACP 进程——ACP 侧的行为由 acp-switch.test.ts 用假 agent 覆盖，
 *    这里只验「顺序、失败不留痕、文案如实」。
 * 文案里的承诺必须与实现一致：恢复失败**不换当前会话记录**、删除**只删登记**（agent 侧归档不在我们手里）。
 */

/** 恢复会话的实现（daemon 注入 acp-brain 的严格恢复（load）；测试注入假实现）。 */
export type ResumeFn = (
  userId: string,
  sessionId: string,
) => Promise<{ ok: true } | { ok: false; problem: string }>;

/** 新建会话的实现（daemon 注入 acp-brain.newSession）。 */
export type CreateFn = (userId: string) => Promise<void>;

/** 会话操作的最小上下文：谁、哪个大脑、哪个数据目录。 */
export type SessionCtx = {
  /** 当前对话大脑的预设名（登记表按 agent 分开存）。 */
  agent: string;
  /** 会话属于谁（微信 userId / CLI 的登录者）。 */
  userId: string;
  dir?: string;
  /** 注入 `now` 只为测试可复现；不传就用真实时间。 */
  now?: number;
};

/**
 * `新会话 [名字]`：先校验名字（非法就不建——不能因为名字打错白清一次上下文），再新建、再登记命名。
 * 名字登记在**新建出来的那条**上（登记表不存 current，所以按当前会话表读刚写下的 id）。
 */
export async function newSessionCmd(
  c: SessionCtx & { name?: string; create: CreateFn },
): Promise<string> {
  const dir = c.dir ?? DATA_DIR;
  const name = c.name?.trim();
  if (name) {
    const bad = validateSessionName(name);
    if (bad) return `❌ ${bad}`;
  }
  await c.create(c.userId);
  const sid = currentSessionIdOf(c.agent, c.userId, dir);
  if (sid && name)
    ensureEntry(c.agent, c.userId, sid, { name, dir, ...(c.now ? { now: c.now } : {}) });
  return name
    ? `✅ 已开启新会话「${name}」（上下文已清空）。`
    : "✅ 已开启新会话（上下文已清空）。";
}

/** `会话列表 [页]`：本人 + 当前大脑；末尾提示其它大脑另有几条。 */
export function sessionsCmd(c: SessionCtx & { page?: number }): string {
  const dir = c.dir ?? DATA_DIR;
  const { entries, others, currentSessionId } = listSessions(c.agent, c.userId, dir);
  return renderSessionList(entries, {
    agent: c.agent,
    page: c.page,
    currentSessionId,
    others,
    now: c.now,
  });
}

/**
 * `恢复会话 <序号|名字|id前缀>`：ref 先在**当前大脑的本人会话**里解析，再走严格恢复（load）。
 * 成功才 markUsed（并已由 ACP 层改当前会话记录）；失败**明确报错、当前会话不变**（绝不静默新建一条顶替）。
 */
export async function resumeSessionCmd(
  c: SessionCtx & { resume: ResumeFn },
  ref: string,
): Promise<string> {
  const dir = c.dir ?? DATA_DIR;
  const { entries, currentSessionId } = listSessions(c.agent, c.userId, dir);
  const hit = resolveRef(ref, entries);
  if (!hit.ok) return `❌ ${hit.error}`;
  if (hit.entry.sessionId === currentSessionId) {
    return `ℹ️ 当前就在这条会话上：${labelOf(hit.entry)}（${hit.entry.turns} 轮）。直接发消息即可。`;
  }
  const r = await c.resume(c.userId, hit.entry.sessionId);
  if (!r.ok) return `❌ ${r.problem}`;
  markUsed(c.agent, c.userId, hit.entry.sessionId, { dir, ...(c.now ? { now: c.now } : {}) });
  return `✅ 已切回会话 ${labelOf(hit.entry)}（${hit.entry.turns} 轮）。接下来发的消息会接上它的上下文。`;
}

/** `重命名会话 <ref> <名字>`：改名后不会被条数上限淘汰。 */
export function renameSessionCmd(c: SessionCtx, ref: string, name: string): string {
  const dir = c.dir ?? DATA_DIR;
  const bad = validateSessionName(name);
  if (bad) return `❌ ${bad}`;
  const { entries } = listSessions(c.agent, c.userId, dir);
  const hit = resolveRef(ref, entries);
  if (!hit.ok) return `❌ ${hit.error}`;
  const before = labelOf(hit.entry);
  const r = renameSession(c.agent, c.userId, ref, name, dir);
  if (!r.ok) return `❌ ${r.error}`;
  return `✅ 已重命名：${before} → 「${name.trim()}」。`;
}

/**
 * `删除会话 <ref>`：只删登记项；删的若是当前会话则**同时清当前会话记录**（下一条消息自然开新的）。
 * agent 自己那份历史归档不在 WeMind 手里（ACP 无可验证的 session/delete），如实写在回执里。
 */
export function deleteSessionCmd(c: SessionCtx, ref: string): string {
  const dir = c.dir ?? DATA_DIR;
  const r = deleteSession(c.agent, c.userId, ref, { dir });
  if (!r.ok) return `❌ ${r.error}`;
  const tail = r.clearedPointer ? "它就是当前会话，下一条消息会开一个新的。" : "当前会话没有变。";
  return `✅ 已从列表删除：${labelOf(r.entry)}。${tail}\n（agent 自己那份历史归档不在 WeMind 手里、仍留在它的存储里；这里删掉的是 WeMind 的列表登记。）`;
}
