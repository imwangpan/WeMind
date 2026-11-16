import fs from "node:fs";
import path from "node:path";

import { createLogger, DATA_DIR } from "@wemind/wechat-ilink-core";

import { writeJsonAtomic } from "../../shared/io/atomic-json.js";

/** `<agent>:<sessionId>` → cwd；恢复会话时校验，避免把旧会话搬到新工作区。 */
type SessionCwdMap = Record<string, string>;

const log = createLogger("wechat-daemon/session-cwd");

export function sessionCwdPath(dir: string = DATA_DIR): string {
  return path.join(dir, "session-cwd.json");
}

export function sessionCwdKey(agent: string, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

function readMap(dir: string = DATA_DIR): SessionCwdMap {
  try {
    const j = JSON.parse(fs.readFileSync(sessionCwdPath(dir), "utf-8")) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) return {};
    const out: SessionCwdMap = {};
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
      if (typeof v === "string" && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** 写失败只记日志：session-cwd.json 只是旧会话 cwd 的索引，磁盘满/只读不该把整轮拖垮（AGENTS.md §4.12）。 */
function writeMap(map: SessionCwdMap, dir: string): void {
  try {
    writeJsonAtomic(sessionCwdPath(dir), map);
  } catch (e) {
    log.warn(
      `session-cwd.json 写入失败（内存指针仍生效，磁盘索引可能滞后）：${String((e as Error)?.message ?? e)}`,
    );
  }
}

export function getSessionCwd(
  agent: string,
  sessionId: string,
  dir: string = DATA_DIR,
): string | undefined {
  return readMap(dir)[sessionCwdKey(agent, sessionId)];
}

export function setSessionCwd(
  agent: string,
  sessionId: string,
  cwd: string,
  dir: string = DATA_DIR,
): void {
  const map = readMap(dir);
  map[sessionCwdKey(agent, sessionId)] = cwd;
  writeMap(map, dir);
}

export function deleteSessionCwd(agent: string, sessionId: string, dir: string = DATA_DIR): void {
  const map = readMap(dir);
  delete map[sessionCwdKey(agent, sessionId)];
  writeMap(map, dir);
}

/**
 * 恢复会话时校验记下来的 cwd：目录被删/卸载/UNC 断连时明确记日志并回落当前默认工作区，
 * 不把旧会话静默挂到新建的空目录。Windows 的 UNC 路径一律拒绝（AGENTS.md §4.19）。
 */
export function usableSessionCwd(
  saved: string | undefined,
  fallback: string,
  sessionId: string,
): string {
  if (!saved) return fallback;
  if (process.platform === "win32" && (saved.startsWith("\\\\") || saved.startsWith("//"))) {
    log.warn(`会话 ${sessionId} 记录的 cwd 是 UNC 路径，已回落到默认工作区：${saved}`);
    return fallback;
  }
  try {
    if (fs.statSync(saved).isDirectory()) return saved;
    log.warn(`会话 ${sessionId} 记录的 cwd 不是目录，已回落到默认工作区：${saved}`);
  } catch {
    log.warn(`会话 ${sessionId} 记录的 cwd 不可访问，已回落到默认工作区：${saved}`);
  }
  return fallback;
}
