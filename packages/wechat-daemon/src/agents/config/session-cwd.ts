import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

import { writeJsonAtomic } from "../../shared/io/atomic-json.js";

/** `<agent>:<sessionId>` → cwd；恢复会话时校验，避免把旧会话搬到新工作区。 */
type SessionCwdMap = Record<string, string>;

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
  writeJsonAtomic(sessionCwdPath(dir), map);
}

export function deleteSessionCwd(agent: string, sessionId: string, dir: string = DATA_DIR): void {
  const map = readMap(dir);
  delete map[sessionCwdKey(agent, sessionId)];
  writeJsonAtomic(sessionCwdPath(dir), map);
}
