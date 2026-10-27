import fs from "node:fs";
import path from "node:path";

import { WEMIND_ROOT } from "./accounts.js";
import type { AccountData, ServerState, QrLoginState } from "../api/types.js";

/**
 * 数据目录解析（按优先级）：
 *  1. WECHAT_DATA_DIR：显式指定完整路径（最高优先级，便于任意自定义/多账号）。
 *  2. 否则 ~/.wemind/<account>，其中 <account> 取自 WECHAT_ACCOUNT，默认 "default"。
 * account.json / state.json / brain-sessions.json / brain-mcps.json / brain-home 等都落在此目录下。
 * 多账号即「不同 WECHAT_ACCOUNT（或 WECHAT_DATA_DIR）→ 不同目录 → 互相隔离」。
 */
export const ACCOUNT_KEY = process.env.WECHAT_ACCOUNT?.trim() || "default";
export const DATA_DIR = process.env.WECHAT_DATA_DIR?.trim() || path.join(WEMIND_ROOT, ACCOUNT_KEY);

/** 持久化文件名：集中在此，避免各处拼字符串写错（load/save/clear 必须指向同一份）。 */
const FILES = {
  account: "account.json",
  state: "state.json",
  qrState: "qr_login.json",
} as const;

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(filePath: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    // 只有「不存在」才算首次运行；权限/fs 错误必须冒出去，不能静默当成空数据（否则下一步 save 会覆盖掉原文件）
    if (isNotFound(e)) return null;
    throw e;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    // 文件存在但解析失败（写途崩溃/外部破坏）：不静默清空，备份坏文件 + 记日志，便于排查与人工恢复
    console.error(
      `[wemind/wechat-ilink-core/store] ${filePath} parse failed, backing up and treating as empty: ${String(e)}`,
    );
    try {
      fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    } catch {
      /* best-effort */
    }
    return null;
  }
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** 原子写：先写临时文件再 rename 覆盖（同盘 rename 原子），避免写途崩溃/并发产生半截损坏文件。 */
function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // 写/rename 失败时清掉临时文件，避免数据目录里堆积 *.tmp-* 垃圾
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
    throw e;
  }
}

export function loadAccount(dir: string = DATA_DIR): AccountData | null {
  return readJson<AccountData>(path.join(dir, FILES.account));
}

let warnedWinPerms = false;

/**
 * 把登录凭证写进**指定**目录的 `account.json`（原子写 + POSIX 600 + Windows 一次性明文告警）。
 *
 * 为什么要有 dir 参数：`wemind login` 是先写到暂存目录 `.staging/`、扫码确认后才 rename 成账号目录。
 * 那条路径以前直接 `fs.writeFileSync`，于是「POSIX 600 / Windows 告警」这两条安全承诺在最推荐的登录入口上不成立（chmod 也漏了）。改成复用本函数，两条路径行为一致。
 * rename 同盘保留权限位，所以先写好再归档不会丢 600。
 */
export function saveAccountTo(dir: string, account: AccountData): void {
  const file = path.join(dir, FILES.account);
  writeJson(file, account);
  if (process.platform === "win32") {
    // Windows 上 fs.chmod 实际是 no-op，无法用 0o600 限制访问。
    // 不做无效操作，改为一次性提醒（详见 README 的安全说明）。
    if (!warnedWinPerms) {
      warnedWinPerms = true;
      console.error(
        `[wemind/wechat-ilink-core] warning: ${file} stores the bot token in plaintext; ` +
          `Windows cannot restrict it via chmod. Protect ${dir} with folder permissions or disk encryption.`,
      );
    }
  } else {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best-effort */
    }
  }
}

export function saveAccount(account: AccountData): void {
  saveAccountTo(DATA_DIR, account);
}

/** 删除凭证。返回是否真的删掉了（登录流程据此判断「本来就没登录」还是「删失败」）。 */
export function clearAccount(dir: string = DATA_DIR): boolean {
  return removeFile(path.join(dir, FILES.account));
}

/** 空状态：唯一来源，避免 loadState/resetState 各写一份、将来加字段时漏改。 */
function emptyState(): ServerState {
  return { updatesBuf: "", contextTokens: {}, lastMessageId: 0 };
}

export function loadState(dir: string = DATA_DIR): ServerState {
  return readJson<ServerState>(path.join(dir, FILES.state)) ?? emptyState();
}

export function saveState(state: ServerState, dir: string = DATA_DIR): void {
  writeJson(path.join(dir, FILES.state), state);
}

export function resetState(dir: string = DATA_DIR): void {
  saveState(emptyState(), dir);
}

export function loadQrState(dir: string = DATA_DIR): QrLoginState | null {
  return readJson<QrLoginState>(path.join(dir, FILES.qrState));
}

export function saveQrState(state: QrLoginState, dir: string = DATA_DIR): void {
  writeJson(path.join(dir, FILES.qrState), state);
}

export function clearQrState(dir: string = DATA_DIR): boolean {
  return removeFile(path.join(dir, FILES.qrState));
}

function removeFile(filePath: string): boolean {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (e) {
    if (isNotFound(e)) return false; // 本来就没有：正常
    console.error(`[wemind/wechat-ilink-core/store] failed to remove ${filePath}: ${String(e)}`);
    return false;
  }
}
