import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

/**
 * brain 的 MCP 沙箱：brain 跑在独立 KIRO_HOME 下，默认不加载任何 MCP。
 * 通过对话指令（加载/卸载/列出）动态调整「激活集」，从全局 mcp.json（目录）取定义写入沙箱。
 * DATA_DIR 从 core 导入（支持 WECHAT_DATA_DIR 覆盖，便于多账号隔离）。
 */

/** brain 专用 KIRO_HOME（auth 在平台数据目录、不随 KIRO_HOME 移动，故 brain 仍登录态）。 */
export const BRAIN_HOME = process.env.WECHAT_BRAIN_HOME?.trim() || path.join(DATA_DIR, "brain-home");
const BRAIN_MCP_JSON = path.join(BRAIN_HOME, "settings", "mcp.json");

/** 激活集持久化文件。 */
const ACTIVE_FILE = path.join(DATA_DIR, "brain-mcps.json");

/** 「目录」：可选 MCP 的定义来源，即真实全局 mcp.json。 */
const CATALOG = process.env.WECHAT_MCP_CATALOG?.trim() || path.join(os.homedir(), ".kiro", "settings", "mcp.json");

/** 永不允许 brain 加载（防回环）。 */
const FORBIDDEN = new Set(["wechat"]);

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function loadCatalog(): Record<string, unknown> {
  const j = readJson(CATALOG);
  const servers = j?.mcpServers;
  return servers && typeof servers === "object" ? (servers as Record<string, unknown>) : {};
}

/** 目录中可选的 server 名（排除禁用项）。 */
export function catalogNames(): string[] {
  return Object.keys(loadCatalog()).filter((n) => !FORBIDDEN.has(n));
}

export function loadActive(): string[] {
  const j = readJson(ACTIVE_FILE);
  const a = j?.active;
  return Array.isArray(a) ? (a as string[]).filter((x) => typeof x === "string") : [];
}

function saveActive(list: string[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACTIVE_FILE, JSON.stringify({ active: list }, null, 2), "utf-8");
}

/** 按激活集从目录取定义，写入沙箱 mcp.json（默认空）。 */
export function applySandbox(): void {
  const cat = loadCatalog();
  const active = loadActive().filter((n) => cat[n] && !FORBIDDEN.has(n));
  const servers: Record<string, unknown> = {};
  for (const n of active) servers[n] = cat[n];
  fs.mkdirSync(path.dirname(BRAIN_MCP_JSON), { recursive: true });
  fs.writeFileSync(BRAIN_MCP_JSON, JSON.stringify({ mcpServers: servers }, null, 2), "utf-8");
}

/** 启动时确保沙箱存在并与激活集一致。 */
export function ensureBrainHome(): void {
  applySandbox();
}

export function addMcp(name: string): string {
  if (FORBIDDEN.has(name)) return `不允许加载「${name}」（防回环）。`;
  const cat = loadCatalog();
  if (!cat[name]) return `未找到 MCP「${name}」。可选：${catalogNames().join(", ") || "（无）"}`;
  const a = loadActive();
  if (!a.includes(name)) {
    a.push(name);
    saveActive(a);
  }
  applySandbox();
  return `已加载 MCP「${name}」。当前激活：${a.join(", ")}（下一条消息生效）`;
}

export function removeMcp(name: string): string {
  const a = loadActive();
  if (!a.includes(name)) return `「${name}」当前未激活。`;
  const next = a.filter((x) => x !== name);
  saveActive(next);
  applySandbox();
  return `已卸载 MCP「${name}」。当前激活：${next.join(", ") || "（空）"}`;
}

export function listMcp(): string {
  const avail = catalogNames();
  const active = loadActive();
  return `可选 MCP：${avail.join(", ") || "（无）"}\n已激活：${active.join(", ") || "（空，默认不加载）"}`;
}
