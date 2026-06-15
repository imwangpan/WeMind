import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { DATA_DIR } from "@wemind/wechat-ilink-core";
import { resolveAgent } from "./brain-agents.js";

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

/** 「目录」：可选 MCP 的定义来源。默认取所用 agent 真实配置目录（可配置的 realHome）下的 settings/mcp.json；
 *  可用 `WEMIND_MCP_CATALOG` / `WECHAT_MCP_CATALOG` 覆盖为任意路径。 */
const CATALOG = process.env.WEMIND_MCP_CATALOG?.trim()
  || process.env.WECHAT_MCP_CATALOG?.trim()
  || path.join(resolveAgent().realHome || path.join(os.homedir(), ".kiro"), "settings", "mcp.json");

/** 永不允许 brain 加载（防回环）。 */
const FORBIDDEN = new Set(["wechat"]);

/**
 * 让 brain 继承所用 agent 真实配置目录的「知识/记忆」类目录（如 kiro 的 steering/memories/skills），
 * 使微信里的大脑和你日常使用读到同样的记忆、规则、技能。用目录 junction（Windows）/ symlink 指向真实目录；
 * **MCP（settings）与 brain 自有会话（sessions）不镜像**：MCP 必须走沙箱（排除 wechat 防回环），会话不能混。
 *
 * 通用性：来源目录（realHome）与子目录清单（inheritDirs）按 agent 而异，下沉到 `brain-agents.ts` 的预设
 * （kiro 已预置；其它 agent 记忆机制不同，需要时填预设或用 WEMIND_BRAIN_REAL_HOME/_INHERIT_DIRS 配置）。
 * 仅适用于「以配置目录承载记忆且目录式」的 agent；记忆为单文件（如 CLAUDE.md/GEMINI.md）的需另行处理。
 */
function mirrorRealKiro(): void {
  const ag = resolveAgent();
  if (!ag.inherit || !ag.realHome || ag.inheritDirs.length === 0) return;
  if (path.resolve(BRAIN_HOME) === path.resolve(ag.realHome)) return; // 安全：别把自己链给自己
  try { fs.mkdirSync(BRAIN_HOME, { recursive: true }); } catch { /* ignore */ }
  for (const d of ag.inheritDirs) {
    const target = path.join(ag.realHome, d);
    const link = path.join(BRAIN_HOME, d);
    if (!fs.existsSync(target)) continue;
    let present = false;
    try { fs.lstatSync(link); present = true; } catch { /* 不存在 */ }
    if (present) {
      // 已是链接 → 不动；是早期自建的「空」真实目录 → 删掉改建 junction；非空真实目录 → 保留不动（避免误删数据）
      try {
        const st = fs.lstatSync(link);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory() && fs.readdirSync(link).length === 0) fs.rmdirSync(link);
        else continue;
      } catch { continue; }
    }
    try {
      fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch { /* 权限不足等：best-effort 忽略 */ }
  }
}

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

/** 继承真实配置目录 settings/ 下除 mcp.json 外的文件（cli.json 含模型/免确认等），让大脑与日常使用同款配置；mcp.json 仍由沙箱 curated。 */
function syncSettings(): void {
  const ag = resolveAgent();
  if (!ag.inherit || !ag.realHome) return;
  const realSettings = path.join(ag.realHome, "settings");
  const brainSettings = path.join(BRAIN_HOME, "settings");
  if (!fs.existsSync(realSettings)) return;
  try { fs.mkdirSync(brainSettings, { recursive: true }); } catch { /* ignore */ }
  let names: string[] = [];
  try { names = fs.readdirSync(realSettings); } catch { return; }
  for (const f of names) {
    if (f === "mcp.json") continue; // MCP 必须用沙箱 curated 版本（防 wechat 回环）
    try {
      const src = path.join(realSettings, f);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(brainSettings, f));
    } catch { /* best-effort */ }
  }
}

/** 启动时确保沙箱存在并与激活集一致。 */
export function ensureBrainHome(): void {
  syncSettings();   // 先同步「非 MCP」设置(模型/免确认等)，让大脑与日常使用同款配置
  applySandbox();   // 再写 curated mcp.json（权威，保持 MCP 隔离防回环）
  mirrorRealKiro(); // 继承真实配置目录的记忆/steering/skills（sessions 仍隔离）
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
