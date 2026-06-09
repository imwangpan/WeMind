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
  try {
    const j = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8")) as AccountsRegistry;
    if (j && typeof j === "object" && j.accounts) return j;
  } catch {
    /* 不存在或损坏 → 空注册表 */
  }
  return { accounts: {} };
}

export function saveRegistry(reg: AccountsRegistry): void {
  fs.mkdirSync(WEMIND_ROOT, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2), "utf-8");
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
  const reg = loadRegistry();
  if (!reg.accounts[key]) throw new Error(`account not found: ${key}`);
  reg.default = key;
  saveRegistry(reg);
}

/** 登记/更新一个账号；首个账号自动设为默认。 */
export function registerAccount(meta: Omit<AccountMeta, "addedAt"> & { addedAt?: number }): AccountMeta {
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
}

/** 移除注册表中的账号条目（不删除磁盘目录，由调用方决定）。 */
export function unregisterAccount(key: string): void {
  const reg = loadRegistry();
  delete reg.accounts[key];
  if (reg.default === key) {
    const rest = Object.keys(reg.accounts);
    reg.default = rest.length ? rest[0] : undefined;
  }
  saveRegistry(reg);
}

/** 设置/修改某账号的人类可读别名。 */
export function setLabel(key: string, label: string): void {
  const reg = loadRegistry();
  if (!reg.accounts[key]) throw new Error(`account not found: ${key}`);
  reg.accounts[key].label = label;
  saveRegistry(reg);
}
