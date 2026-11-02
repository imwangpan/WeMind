import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

import { writeJsonAtomic } from "./atomic-json.js";

/**
 * brainstorm/worker 共用的 session 映射键规则：`<agent>:<key>`。
 * 换大脑后各 agent 的会话互不覆盖，切回原大脑仍能 session/load 回原上下文。
 */
export function sessionKey(agent: string, key: string): string {
  return `${agent}:${key}`;
}

/** 对话大脑的当前会话表路径（`<agent>:<userId>` → sessionId）。 */
export function brainSessionMapPath(dir: string = DATA_DIR): string {
  return path.join(dir, "brain-sessions.json");
}

/** 任务 worker 的当前会话表路径（`<agent>:<taskKey>` → sessionId）。 */
export function workerSessionMapPath(dir: string = DATA_DIR): string {
  return path.join(dir, "worker-sessions.json");
}

/**
 * 严格读当前会话表：缺失 → 空表；其它读/解析/格式错误一律抛出，由调用方决定备份或降级。
 * 只保留字符串值，**不做格式迁移**（迁移归 normalizeSessionMap）。
 */
export function readSessionMapStrict(file: string): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw e;
  }
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`会话表 ${file} 不是 JSON 对象`);
  }
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v) map[k] = v;
  }
  return map;
}

/** 读当前会话表（只读场景）；缺失/损坏/非对象 → 空表（幂等、不抛）。写入前的读取请用 readSessionMapStrict + backupCorruptSessionMap。 */
export function readSessionMap(file: string): Record<string, string> {
  try {
    return readSessionMapStrict(file);
  } catch {
    return {};
  }
}

/**
 * 会话表损坏时的兜底：把原文件改名备份为 `<file>.corrupt-<时间戳>`，返回备份路径；改名失败返回 undefined。
 * 备份保证后续写入不会把可能还能人工恢复的内容整张覆盖。
 */
export function backupCorruptSessionMap(file: string): string | undefined {
  const backup = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, backup);
    return backup;
  } catch {
    return undefined;
  }
}

/** 原子写当前会话表（唯一临时文件 + rename）：这个文件在关键路径上（ensureSession → session/load），半截 JSON 等于「所有会话丢失」。 */
export function writeSessionMap(file: string, map: Record<string, string>): void {
  writeJsonAtomic(file, map);
}

/** 清掉某个键的当前会话记录（如「删除会话」删的正是当前那条）；返回是否确有改动。 */
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
