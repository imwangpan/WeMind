import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * 账号注册表：管理 ~/.wemind 下的多账号清单。
 * - 每个账号一个独立子目录（key = 由 botId 派生的唯一标识，见 deriveAccountKey）。
 * - accounts.json 记录 key → 元数据（botId/userId/baseUrl/label/addedAt）与默认账号。
 * label 为人类可读别名（默认等于 key，可改），folder/key 始终唯一且由微信 botId 派生。
 */

/** WeMind 根目录（所有账号子目录与注册表的父目录）。可用 WEMIND_HOME 覆盖。 */
export const WEMIND_ROOT = process.env.WEMIND_HOME?.trim() || path.join(os.homedir(), ".wemind");

const REGISTRY_FILE = path.join(WEMIND_ROOT, "accounts.json");
const REGISTRY_LOCK = `${REGISTRY_FILE}.lock`;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

export interface AccountMeta {
  key: string;
  botId: string;
  userId: string;
  baseUrl: string;
  label: string;
  addedAt: number;
}

export interface AccountsRegistry {
  default?: string;
  accounts: Record<string, AccountMeta>;
}

/** 把 botId（如 feead781eb44@im.bot）净化成可作目录名的唯一 key（feead781eb44）。 */
export function deriveAccountKey(botId: string): string {
  const head = (botId || "").split("@")[0] || botId || "";
  const cleaned = head.replace(/[^a-zA-Z0-9_-]/g, "").trim();
  return cleaned || "account";
}

/** 某账号的状态目录：~/.wemind/<key>。 */
export function accountDir(key: string): string {
  return path.join(WEMIND_ROOT, key);
}

export function loadRegistry(): AccountsRegistry {
  let raw: string;
  try {
    raw = fs.readFileSync(REGISTRY_FILE, "utf-8");
  } catch (e) {
    // 只有「不存在」才算首次运行。权限/磁盘/路径错误必须冒出去：把它当空表的话，下一次写会把所有已登记账号抹掉。
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { accounts: {} };
    throw new Error(
      `无法读取账号注册表 ${REGISTRY_FILE}（${(e as NodeJS.ErrnoException)?.code ?? "未知错误"}）：${e instanceof Error ? e.message : String(e)}。为避免覆盖，本次不按空表处理。`,
    );
  }
  try {
    const j = JSON.parse(raw) as AccountsRegistry;
    if (j && typeof j === "object" && j.accounts) return j;
    throw new Error("registry shape invalid");
  } catch (e) {
    // 存在但损坏：不要当空注册表直接覆盖（紧接的 save 会抹掉所有已登记账号）；备份坏文件 + 记日志
    console.error(
      `[wemind/wechat-ilink-core/accounts] ${REGISTRY_FILE} parse failed, backing up: ${String(e)}`,
    );
    try {
      fs.renameSync(REGISTRY_FILE, `${REGISTRY_FILE}.corrupt-${Date.now()}`);
    } catch {
      /* best-effort */
    }
    return { accounts: {} };
  }
}

/** 原子写注册表：临时文件 + rename，避免写途崩溃/并发损坏。 */
export function saveRegistry(reg: AccountsRegistry): void {
  fs.mkdirSync(WEMIND_ROOT, { recursive: true });
  const tmp = `${REGISTRY_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), "utf-8");
  fs.renameSync(tmp, REGISTRY_FILE);
}

/** 同步等待（CLI 是同步流程；Atomics.wait 不占 CPU）。 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* ignore */
  }
}

/**
 * 注册表的跨进程写锁：`accounts.json` 的「读-改-写」必须串行，否则两个 `wimind login` 并发时后写的那个会用旧快照覆盖前一个账号。
 * 锁文件用 `wx` 原子创建；持有者崩溃留下的陈旧锁（>10s）自动清理。等不到就报错让用户重试，**不**退化成无锁写。
 */
function withRegistryLock<T>(fn: () => T): T {
  fs.mkdirSync(WEMIND_ROOT, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(REGISTRY_LOCK, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
        try {
          fs.unlinkSync(REGISTRY_LOCK);
        } catch {
          /* ignore */
        }
      }
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST")
        throw e instanceof Error ? e : new Error(String(e));
      try {
        const st = fs.statSync(REGISTRY_LOCK);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(REGISTRY_LOCK);
          continue;
        }
      } catch {
        continue; // 锁刚被释放：立即重试
      }
      if (Date.now() >= deadline)
        throw new Error(
          `账号注册表正被另一个 wimind 进程修改（锁文件 ${REGISTRY_LOCK}）；请稍后重试。若确认没有其它 wimind 在跑，可删除该锁文件。`,
        );
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(REGISTRY_LOCK);
    } catch {
      /* 已被清理：忽略 */
    }
  }
}

export function listAccounts(): AccountMeta[] {
  const reg = loadRegistry();
  return Object.values(reg.accounts).sort((a, b) => a.addedAt - b.addedAt);
}

export function getDefaultKey(): string | undefined {
  const reg = loadRegistry();
  if (reg.default && reg.accounts[reg.default]) return reg.default;
  const keys = Object.keys(reg.accounts);
  return keys.length ? keys[0] : undefined;
}

export function setDefaultKey(key: string): void {
  withRegistryLock(() => {
    const reg = loadRegistry();
    if (!reg.accounts[key]) throw new Error(`account not found: ${key}`);
    reg.default = key;
    saveRegistry(reg);
  });
}

/** 登记/更新一个账号；首个账号自动设为默认。 */
export function registerAccount(
  meta: Omit<AccountMeta, "addedAt"> & { addedAt?: number },
): AccountMeta {
  return withRegistryLock(() => {
    const reg = loadRegistry();
    const existing = reg.accounts[meta.key];
    const full: AccountMeta = {
      key: meta.key,
      botId: meta.botId,
      userId: meta.userId,
      baseUrl: meta.baseUrl,
      label: meta.label || existing?.label || meta.key,
      addedAt: existing?.addedAt ?? meta.addedAt ?? Date.now(),
    };
    reg.accounts[meta.key] = full;
    if (!reg.default) reg.default = meta.key;
    saveRegistry(reg);
    return full;
  });
}

/** 移除注册表中的账号条目（不删除磁盘目录，由调用方决定）。 */
export function unregisterAccount(key: string): void {
  withRegistryLock(() => {
    const reg = loadRegistry();
    delete reg.accounts[key];
    if (reg.default === key) {
      const rest = Object.keys(reg.accounts);
      reg.default = rest.length ? rest[0] : undefined;
    }
    saveRegistry(reg);
  });
}

/** 设置/修改某账号的人类可读别名。 */
export function setLabel(key: string, label: string): void {
  withRegistryLock(() => {
    const reg = loadRegistry();
    if (!reg.accounts[key]) throw new Error(`account not found: ${key}`);
    reg.accounts[key].label = label;
    saveRegistry(reg);
  });
}
