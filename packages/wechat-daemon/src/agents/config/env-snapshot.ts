import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

import { writeJsonAtomic } from "../../shared/io/atomic-json.js";

/**
 * 非敏感环境快照。
 *
 * 后台/自启动 daemon 不保证拿到登录 shell 的 PATH；但 PATH 可能来自 fnm、nvm、Volta、asdf、mise、corepack、
 * conda、包管理器 shim 或用户手工配置。这里只捕获“当前进程最终的环境形状”，不解析任何版本管理器配置。
 */
export type EnvSnapshot = {
  version: 1;
  capturedAt: number;
  keys: Record<string, string>;
};

export function envSnapshotPath(dir: string = DATA_DIR): string {
  return path.join(dir, "env.json");
}

const BASE_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "LANG",
  "TZ",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
]);

function isAllowedKey(key: string): boolean {
  const k = key.toUpperCase();
  if (k.startsWith("LC_")) return true;
  return BASE_KEYS.has(k);
}

const SECRET_KEY = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)(?:_|$)/i;

export function looksSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** 从当前进程捕获；只保留白名单键，密钥类键名直接丢弃。 */
export function captureEnvSnapshot(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): EnvSnapshot {
  const keys: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (!isAllowedKey(k) || looksSecretKey(k)) continue;
    keys[k] = v;
  }
  return { version: 1, capturedAt: now, keys };
}

/** 读快照；损坏/未知键/密钥键一律丢弃，不抛。 */
export function readEnvSnapshot(dir: string = DATA_DIR): Record<string, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(envSnapshotPath(dir), "utf-8"));
  } catch {
    return {};
  }
  const j = raw as Partial<EnvSnapshot> | null;
  if (!j || typeof j !== "object" || !j.keys || typeof j.keys !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(j.keys)) {
    if (typeof v !== "string") continue;
    if (!isAllowedKey(k) || looksSecretKey(k)) continue;
    out[k] = v;
  }
  return out;
}

export function writeEnvSnapshot(snapshot: EnvSnapshot, dir: string = DATA_DIR): void {
  writeJsonAtomic(envSnapshotPath(dir), snapshot);
  try {
    fs.chmodSync(envSnapshotPath(dir), 0o600);
  } catch {
    /* Windows 上 chmod 是 no-op；目录 ACL 才是边界 */
  }
}

export function clearEnvSnapshot(dir: string = DATA_DIR): boolean {
  try {
    fs.rmSync(envSnapshotPath(dir), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 合并顺序：快照（上次 daemon 的环境）作为兜底，**当前进程环境优先**。
 *  快照只是「daemon 由 autostart 拉起、PATH/代理不完整」时的补丁，不能反过来覆盖用户此刻导出的 PATH/COMSPEC/SYSTEMROOT。
 *  预设 env/envDefaults 在 brain-agents.agentEnv 里继续叠加。 */
export function mergeEnvSnapshot(
  parent: NodeJS.ProcessEnv,
  snapshot: Record<string, string>,
): NodeJS.ProcessEnv {
  return { ...snapshot, ...parent };
}
