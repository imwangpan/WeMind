import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

/**
 * brainstorm/worker 共用的 session 映射键规则：`<agent>:<key>`。
 * 换大脑后各 agent 的会话互不覆盖，切回原大脑仍能 session/load 回原上下文。
 */
export function sessionKey(agent: string, key: string): string {
  return `${agent}:${key}`;
}

/** 对话大脑的会话指针表路径（`<agent>:<userId>` → sessionId）。 */
export function brainSessionMapPath(dir: string = DATA_DIR): string {
  return path.join(dir, "brain-sessions.json");
}

/** 任务 worker 的会话指针表路径（`<agent>:<taskKey>` → sessionId）。 */
export function workerSessionMapPath(dir: string = DATA_DIR): string {
  return path.join(dir, "worker-sessions.json");
}

/** 读会话指针表；缺失/损坏/非对象 → 空表（幂等、不抛）。只保留字符串值，**不做格式迁移**（迁移归 normalizeSessionMap）。 */
export function readSessionMap(file: string): Record<string, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v) map[k] = v;
  }
  return map;
}

/** 原子写会话指针表（tmp + rename）：这个文件在关键路径上（ensureSession → session/load），半截 JSON 等于「所有会话丢失」。 */
export function writeSessionMap(file: string, map: Record<string, string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

/** 清掉某个键的会话指针（如「删除会话」删的正是当前那条）；返回是否确有改动。 */
export function clearSessionPointer(file: string, key: string): boolean {
  const map = readSessionMap(file);
  if (!(key in map)) return false;
  delete map[key];
  writeSessionMap(file, map);
  return true;
}

/**
 * 把磁盘上的映射归一成 `<agent>:<key>` 形式。
 * - 已带前缀的条目原样保留（其它 agent 的会话不动）；
 * - 旧格式（裸 key）由「当时那个 agent」写入、已无从得知是哪个 → 归给当前 agent；若同名的新格式条目已存在，则保留新格式（它的归属确定），只丢掉裸条目。
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
