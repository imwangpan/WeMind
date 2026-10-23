import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { DATA_DIR } from "@wemind/wechat-ilink-core";
import { resolveAgent } from "./brain-agents.js";
import { loadBrainConfig } from "./brain-config.js";
import { readMcpServers, withMcpServers, parseJsonc } from "./agent-mcp.js";

/**
 * brain 的 MCP 沙箱：brain 跑在独立配置目录下，默认不加载任何 MCP。
 * 通过对话指令（加载/卸载/列出）动态调整「激活集」，从全局 MCP 目录取定义写入沙箱。
 * DATA_DIR 从 core 导入（支持 WECHAT_DATA_DIR 覆盖，便于多账号隔离）。
 *
 * 按 agent 适配（见 brain-agents.ts 预设与 docs/接入-OpenCode.md）：
 * - 配置目录：kiro = 沙箱根（KIRO_HOME）；opencode = <沙箱>/opencode（XDG_CONFIG_HOME）。
 * - MCP 文件：kiro = settings/mcp.json（{mcpServers}）；opencode = opencode.json（mcp.servers）。
 * kiro 行为与改造前完全一致（默认值即 kiro 约定）。
 */

const AG = resolveAgent(loadBrainConfig());

/** brain 专用沙箱根目录（由 agent 的 homeEnvVar 指向它）。 */
export const BRAIN_HOME =
  process.env.WECHAT_BRAIN_HOME?.trim() || path.join(DATA_DIR, "brain-home");

/** 该 agent 在沙箱里的「配置目录」（kiro=沙箱根；opencode=<沙箱>/opencode）。 */
export const BRAIN_CONFIG_DIR = path.join(BRAIN_HOME, AG.configSubdir);

/** MCP 配置文件（相对配置目录，按 agent 的 mcpConfigFile）。 */
const BRAIN_MCP_JSON = path.join(BRAIN_CONFIG_DIR, AG.mcpConfigFile);

/** 激活集持久化文件。 */
const ACTIVE_FILE = path.join(DATA_DIR, "brain-mcps.json");

/** 「目录」：可选 MCP 的定义来源。默认取所用 agent 真实配置目录（realHome）下的
 *  catalogFile（kiro: settings/mcp.json / opencode: opencode.json）；可用
 *  `WEMIND_MCP_CATALOG` / `WECHAT_MCP_CATALOG` 覆盖为任意路径。 */
const CATALOG =
  process.env.WEMIND_MCP_CATALOG?.trim() ||
  process.env.WECHAT_MCP_CATALOG?.trim() ||
  path.join(AG.realHome || path.join(os.homedir(), ".kiro"), AG.catalogFile);

/** 永不允许 brain 加载（防回环）。 */
const FORBIDDEN = new Set(["wechat"]);

/**
 * 让 brain 继承所用 agent 真实配置目录的「知识/记忆/技能」：
 * - 目录式（inheritDirs，如 kiro 的 steering/memories/skills、opencode 的 skills/agents/commands）用
 *   目录 junction（Windows）/ symlink 指向真实目录；
 * - 单文件式（inheritFiles，如 opencode 的 AGENTS.md）直接拷入配置目录。
 * 使微信里的大脑和你日常使用读到同样的记忆、规则、技能。
 * **MCP（settings/opencode.json 的 mcp 段）与 brain 自有会话（sessions）不镜像**：MCP 必须走沙箱（排除 wechat 防回环），会话不能混。
 */
function mirrorRealKiro(): void {
  if (!AG.inherit || !AG.realHome) return;
  if (path.resolve(BRAIN_HOME) === path.resolve(AG.realHome)) return; // 安全：别把自己链给自己
  try {
    fs.mkdirSync(BRAIN_CONFIG_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  for (const d of AG.inheritDirs) {
    const target = path.join(AG.realHome, d);
    const link = path.join(BRAIN_CONFIG_DIR, d);
    if (!fs.existsSync(target)) continue;
    let present = false;
    try {
      fs.lstatSync(link);
      present = true;
    } catch {
      /* 不存在 */
    }
    if (present) {
      // 已是链接 → 不动；是早期自建的「空」真实目录 → 删掉改建 junction；非空真实目录 → 保留不动（避免误删数据）
      try {
        const st = fs.lstatSync(link);
        if (st.isSymbolicLink()) continue; // 已是链接 → 不动
        if (st.isDirectory()) {
          if (fs.readdirSync(link).length === 0) {
            fs.rmdirSync(link); // 空目录 → 删掉，下面改建 junction
          } else {
            // 非空真实目录（如 kiro 自建 agents 脚手架）：把真实目录里「缺失」的文件补拷进来，补全继承（不删已有）
            for (const f of fs.readdirSync(target)) {
              const dst = path.join(link, f);
              const src = path.join(target, f);
              try {
                if (!fs.existsSync(dst) && fs.statSync(src).isFile()) fs.copyFileSync(src, dst);
              } catch {
                /* ignore */
              }
            }
            continue;
          }
        } else continue;
      } catch {
        continue;
      }
    }
    try {
      fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      /* 权限不足等：best-effort 忽略 */
    }
  }
  // 单文件式记忆（如 opencode 的 AGENTS.md）：真实目录有、沙箱没有才拷（不覆盖沙箱已有）
  for (const f of AG.inheritFiles) {
    const src = path.join(AG.realHome, f);
    const dst = path.join(BRAIN_CONFIG_DIR, f);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    } catch {
      /* ignore */
    }
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 把 agent 的凭据文件同步进沙箱（如 DSH 的 `.credentials.yaml`）。
 * 新者胜：首次复制；真实 home 的 token 刷新后覆盖沙箱；沙箱自己刷新过则保留沙箱版本。
 * 这是敏感文件，仅放在账号沙箱内；Windows 无 POSIX 600，建议专用账号 + 目录 ACL。
 */
function syncCredentialFile(): void {
  if (!AG.credentialFile || !AG.realHome) return;
  const src = path.join(AG.realHome, AG.credentialFile);
  const dst = path.join(BRAIN_CONFIG_DIR, AG.credentialFile);
  try {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const s = fs.statSync(src);
    const d = fs.existsSync(dst) ? fs.statSync(dst) : null;
    if (!d || s.mtimeMs > d.mtimeMs + 1000) fs.copyFileSync(src, dst);
  } catch {
    /* best-effort */
  }
}

function loadCatalog(): Record<string, unknown> {
  return readMcpServers(readJson(CATALOG), AG.mcpFormat);
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

/** 按激活集从目录取定义，写入沙箱 MCP 配置（默认空）。保留配置里其它键（如 opencode 的 model）。 */
export function applySandbox(): void {
  const cat = loadCatalog();
  const active = loadActive().filter((n) => cat[n] && !FORBIDDEN.has(n));
  const servers: Record<string, unknown> = {};
  for (const n of active) servers[n] = cat[n];
  const existing = readJson(BRAIN_MCP_JSON) ?? {};
  const next = withMcpServers(existing, servers, AG.mcpFormat);
  fs.mkdirSync(path.dirname(BRAIN_MCP_JSON), { recursive: true });
  fs.writeFileSync(BRAIN_MCP_JSON, JSON.stringify(next, null, 2), "utf-8");
}

/** kiro：继承真实 settings/ 下除 mcp.json 外的文件（cli.json 含模型/免确认等），让大脑与日常使用同款配置。 */
function syncKiroSettings(): void {
  const realSettings = path.join(AG.realHome!, "settings");
  const brainSettings = path.join(BRAIN_CONFIG_DIR, "settings");
  if (!fs.existsSync(realSettings)) return;
  try {
    fs.mkdirSync(brainSettings, { recursive: true });
  } catch {
    /* ignore */
  }
  let names: string[] = [];
  try {
    names = fs.readdirSync(realSettings);
  } catch {
    return;
  }
  for (const f of names) {
    if (f === "mcp.json") continue; // MCP 必须用沙箱 curated 版本（防 wechat 回环）
    try {
      const src = path.join(realSettings, f);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(brainSettings, f));
    } catch {
      /* best-effort */
    }
  }
}

/** opencode：把用户全局 opencode.json(c)（去掉 mcp 段）作为基底写进沙箱，继承 model 等设置；mcp 仍由 applySandbox 权威覆盖。 */
function syncOpencodeBase(): void {
  const src = ["opencode.json", "opencode.jsonc"]
    .map((f) => path.join(AG.realHome!, f))
    .find((f) => fs.existsSync(f));
  if (!src) return;
  let parsed: Record<string, unknown> | null = null;
  try {
    const raw = fs.readFileSync(src, "utf-8");
    parsed = src.endsWith(".jsonc")
      ? parseJsonc(raw)
      : (JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  delete (parsed as Record<string, unknown>).mcp; // MCP 必须走沙箱 curated（防 wechat 回环）
  fs.mkdirSync(BRAIN_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(BRAIN_MCP_JSON, JSON.stringify(parsed, null, 2), "utf-8");
}

/** 继承真实配置目录的「非 MCP」设置（模型/免确认等），让大脑与日常使用同款配置；mcp 段保持沙箱权威。 */
function syncSettings(): void {
  if (!AG.inherit || !AG.realHome) return;
  if (AG.mcpFormat === "opencode") syncOpencodeBase();
  else syncKiroSettings();
}

/** 启动时确保沙箱存在并与激活集一致。 */
export function ensureBrainHome(): void {
  syncSettings(); // 先同步「非 MCP」设置(模型/免确认等)，让大脑与日常使用同款配置
  applySandbox(); // 再写 curated mcp（权威，保持 MCP 隔离防回环）
  mirrorRealKiro(); // 继承真实配置目录的记忆/steering/skills（sessions 仍隔离）
  syncCredentialFile(); // 桌面登录态等凭据（如 DSH 的 .credentials.yaml）
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
