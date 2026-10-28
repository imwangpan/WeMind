import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { DATA_DIR } from "@wemind/wechat-ilink-core";
import type { ResolvedAgent } from "./brain-agents.js";
import { getAgent } from "./agent-slot.js";
import { readMcpServers, withMcpServers, parseJsonc, toAcpMcpServers } from "./agent-mcp.js";

/**
 * brain 的 MCP 沙箱：brain 跑在独立配置目录下，默认不加载任何 MCP。
 * 通过对话指令（加载/卸载/列出）动态调整「激活集」，从全局 MCP 目录取定义写入沙箱。
 * DATA_DIR 从 core 导入（支持 WECHAT_DATA_DIR 覆盖，便于多账号隔离）。
 *
 * 按 agent 适配（见 brain-agents.ts 预设与 docs/接入-OpenCode.md）：
 * - 配置目录：kiro = 沙箱根（KIRO_HOME）；opencode = <沙箱>/opencode（XDG_CONFIG_HOME）。
 * - MCP 文件：kiro = settings/mcp.json（{mcpServers}）；opencode = opencode.json（mcp.servers）。
 * kiro 行为与改造前完全一致（默认值即 kiro 约定）。
 *
 * agent 不再存成模块常量（改造前是 import 时解析的 `AG`）：每个函数显式收 `ag`，
 * 或在入口用 `getAgent("brain")` 取一次当前大脑——热切换后沙箱会写到新 agent 的配置目录。
 */

/** brain 专用沙箱根目录（由 agent 的 homeEnvVar 指向它）。与 agent 无关。 */
export const BRAIN_HOME =
  process.env.WECHAT_BRAIN_HOME?.trim() || path.join(DATA_DIR, "brain-home");

/** 该 agent 在沙箱里的「配置目录」（kiro=沙箱根；opencode=<沙箱>/opencode）。 */
function brainConfigDir(ag: ResolvedAgent): string {
  return path.join(BRAIN_HOME, ag.configSubdir);
}

/** MCP 配置文件（相对配置目录，按 agent 的 mcpConfigFile）。 */
function brainMcpJson(ag: ResolvedAgent): string {
  return path.join(brainConfigDir(ag), ag.mcpConfigFile);
}

/** 激活集持久化文件（与 agent 无关：切脑后再切回，激活的 MCP 仍是那套）。 */
const ACTIVE_FILE = path.join(DATA_DIR, "brain-mcps.json");

/** 「目录」：可选 MCP 的定义来源。默认取所用 agent 真实配置目录（realHome）下的
 *  catalogFile（kiro: settings/mcp.json / opencode: opencode.json）；可用 `WEMIND_MCP_CATALOG` / `WECHAT_MCP_CATALOG` 覆盖为任意路径。 */
function catalogPath(ag: ResolvedAgent): string {
  return (
    process.env.WEMIND_MCP_CATALOG?.trim() ||
    process.env.WECHAT_MCP_CATALOG?.trim() ||
    path.join(ag.realHome || path.join(os.homedir(), ".kiro"), ag.catalogFile)
  );
}

/** 永不允许 brain 加载（防回环）。 */
const FORBIDDEN = new Set(["wechat"]);

/**
 * 让 brain 继承所用 agent 真实配置目录的「知识/记忆/技能」：
 * - 目录式（inheritDirs，如 kiro 的 steering/memories/skills、opencode 的 skills/agents/commands）用目录 junction（Windows）/ symlink 指向真实目录；
 * - 单文件式（inheritFiles，如 opencode 的 AGENTS.md）直接拷入配置目录。
 * 使微信里的大脑和你日常使用读到同样的记忆、规则、技能。
 * **MCP（settings/opencode.json 的 mcp 段）与 brain 自有会话（sessions）不镜像**：MCP 必须走沙箱（排除 wechat 防回环），会话不能混。
 */
function mirrorRealKiro(ag: ResolvedAgent): void {
  if (!ag.inherit || !ag.realHome) return;
  const dir = brainConfigDir(ag);
  if (path.resolve(BRAIN_HOME) === path.resolve(ag.realHome)) return; // 安全：别把自己链给自己
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  for (const d of ag.inheritDirs) {
    const target = path.join(ag.realHome, d);
    const link = path.join(dir, d);
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
  for (const f of ag.inheritFiles) {
    const src = path.join(ag.realHome, f);
    const dst = path.join(dir, f);
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
 * 把 agent 的凭据文件同步进沙箱（如 DSH 的 `.credentials.yaml`、Qoder 的 `.auth/user`）。
 * - `newer`：首次复制；真实 home 的 token 刷新后覆盖沙箱；沙箱自己刷新过则保留沙箱版本。
 * - `always`：内容不同即覆盖（标识类文件，如 Qoder 的 `.auth/machine_id`——agent 在缺凭据时会自造一个，它比真实文件新，「新者胜」会把错的留下，导致永远认证失败）。
 * 这是敏感文件，仅放在账号沙箱内；Windows 无 POSIX 600，建议专用账号 + 目录 ACL。
 */
function syncCredentialFile(ag: ResolvedAgent, file: string, mode: "newer" | "always"): void {
  if (!ag.realHome) return;
  const src = path.join(ag.realHome, file);
  const dst = path.join(brainConfigDir(ag), file);
  try {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (mode === "always") {
      const same = fs.existsSync(dst) && fs.readFileSync(src).equals(fs.readFileSync(dst));
      if (!same) fs.copyFileSync(src, dst);
      return;
    }
    const s = fs.statSync(src);
    const d = fs.existsSync(dst) ? fs.statSync(dst) : null;
    if (!d || s.mtimeMs > d.mtimeMs + 1000) fs.copyFileSync(src, dst);
  } catch {
    /* best-effort */
  }
}

function syncCredentials(ag: ResolvedAgent): void {
  for (const f of ag.credentialFiles) syncCredentialFile(ag, f, "newer");
  for (const f of ag.identityFiles) syncCredentialFile(ag, f, "always");
}

function loadCatalog(ag: ResolvedAgent): Record<string, unknown> {
  return readMcpServers(readJson(catalogPath(ag)), ag.mcpFormat);
}

/** 目录中可选的 server 名（排除禁用项）。 */
export function catalogNames(): string[] {
  const ag = getAgent("brain");
  return Object.keys(loadCatalog(ag)).filter((n) => !FORBIDDEN.has(n));
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

/** 按激活集从目录取定义，写入沙箱 MCP 配置（默认空）。保留配置里其它键（如 opencode 的 model）。
 *  `mcpViaAcp` 预设（DSH）不写文件——激活集经 activeMcpServers() 转成 ACP mcpServers 随 session 下发。 */
function applySandbox(ag: ResolvedAgent): void {
  if (ag.mcpViaAcp) return;
  const cat = loadCatalog(ag);
  const active = loadActive().filter((n) => cat[n] && !FORBIDDEN.has(n));
  const servers: Record<string, unknown> = {};
  for (const n of active) servers[n] = cat[n];
  const file = brainMcpJson(ag);
  const existing = readJson(file) ?? {};
  const next = withMcpServers(existing, servers, ag.mcpFormat);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf-8");
}

/** brain 当前应挂载的 ACP mcpServers（mcpViaAcp 预设用）：激活集 → catalog 定义 → ACP 声明。
 *  跳过不可转换的坏条目并记日志——官方 DSH 的 session/new 遇到起不来的 MCP 会回滚整个会话。 */
export function activeMcpServers() {
  const ag = getAgent("brain");
  const cat = loadCatalog(ag);
  const active = loadActive().filter((n) => cat[n] && !FORBIDDEN.has(n));
  const picked: Record<string, unknown> = {};
  for (const n of active) picked[n] = cat[n];
  const { servers, skipped } = toAcpMcpServers(picked, { exclude: FORBIDDEN });
  if (skipped.length)
    console.error(`[wemind/wechat-daemon/mcp] 跳过无法转换的 MCP：${skipped.join(", ")}`);
  return servers;
}

/** kiro：继承真实 settings/ 下除 mcp.json 外的文件（cli.json 含模型/免确认等），让大脑与日常使用同款配置。 */
function syncKiroSettings(ag: ResolvedAgent): void {
  const realSettings = path.join(ag.realHome!, "settings");
  const brainSettings = path.join(brainConfigDir(ag), "settings");
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
function syncOpencodeBase(ag: ResolvedAgent): void {
  const src = ["opencode.json", "opencode.jsonc"]
    .map((f) => path.join(ag.realHome!, f))
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
  const file = brainMcpJson(ag);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2), "utf-8");
}

/** Qoder 这类「设置与 MCP 同文件」的 agent：以真实 settings.json 为基底生成沙箱设置。
 *  剥离必须由沙箱权威决定的键：
 *  - `mcpServers`：MCP 只能来自沙箱 curated（防 wechat 回环）；
 *  - `enabledPlugins`：插件可自带 MCP，且沙箱不继承 `plugins/`；
 *  - `providers` / `model`：自定义供应商（BYOK）含明文密钥，`model` 又可能指向已剥离的供应商。
 *  并强制 `general.enableAutoUpdate=false`：否则每个沙箱都会各下一份约 210 MB 的 CLI。 */
function settingsBase(ag: ResolvedAgent): Record<string, unknown> {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(ag.realHome!, ag.settingsBase!), "utf-8"));
  } catch {
    /* 缺失/损坏 → 空基底 */
  }
  const base =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  delete base.mcpServers;
  delete base.enabledPlugins;
  delete base.providers;
  delete base.model;
  const general = base.general;
  base.general = {
    ...(general && typeof general === "object" && !Array.isArray(general)
      ? (general as Record<string, unknown>)
      : {}),
    enableAutoUpdate: false,
  };
  return base;
}

function syncSettingsBase(ag: ResolvedAgent): void {
  const dir = brainConfigDir(ag);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(brainMcpJson(ag), JSON.stringify(settingsBase(ag), null, 2), "utf-8");
}

/** 继承真实配置目录的「非 MCP」设置（模型/免确认等），让大脑与日常使用同款配置；mcp 段保持沙箱权威。
 *  `mcpViaAcp` 预设没有文件式 MCP/settings 可继承，跳过（模型走 preset.model + set_config_option）。 */
function syncSettings(ag: ResolvedAgent): void {
  if (ag.mcpViaAcp) return;
  if (ag.settingsBase && ag.realHome) {
    syncSettingsBase(ag); // 不依赖 inherit：沙箱硬化（关自动更新）与隔离始终生效
    return;
  }
  if (!ag.inherit || !ag.realHome) return;
  if (ag.mcpFormat === "opencode") syncOpencodeBase(ag);
  else syncKiroSettings(ag);
}

/**
 * 启动时确保沙箱存在并与激活集一致。
 * `forAgent` 可显式指定 agent（切换流程预热用：预热新大脑时要先备好**它**的沙箱，此刻槽位还指着旧大脑）。
 */
export function ensureBrainHome(forAgent?: ResolvedAgent): void {
  const ag = forAgent ?? getAgent("brain");
  syncSettings(ag); // 先同步「非 MCP」设置(模型/免确认等)，让大脑与日常使用同款配置
  applySandbox(ag); // 再写 curated mcp（权威，保持 MCP 隔离防回环）
  mirrorRealKiro(ag); // 继承真实配置目录的记忆/steering/skills（sessions 仍隔离）
  syncCredentials(ag); // 登录态/凭据（如 DSH 的 .credentials.yaml、Qoder 的 .auth/*）
}

export function addMcp(name: string): string {
  const ag = getAgent("brain");
  if (FORBIDDEN.has(name)) return `不允许加载「${name}」（防回环）。`;
  const cat = loadCatalog(ag);
  if (!cat[name]) return `未找到 MCP「${name}」。可选：${catalogNames().join(", ") || "（无）"}`;
  // 预校验：坏条目不进激活集（官方 DSH 的 session/new 会因起不来的 MCP 回滚整会话）
  if (ag.mcpViaAcp && !toAcpMcpServers({ [name]: cat[name] }).servers.length)
    return `MCP「${name}」的定义无法转换（需要 command 或 url），已拒绝加载。`;
  const a = loadActive();
  if (!a.includes(name)) {
    a.push(name);
    saveActive(a);
  }
  applySandbox(ag);
  return `已加载 MCP「${name}」。当前激活：${a.join(", ")}（下一条消息生效）`;
}

export function removeMcp(name: string): string {
  const a = loadActive();
  if (!a.includes(name)) return `「${name}」当前未激活。`;
  const next = a.filter((x) => x !== name);
  saveActive(next);
  applySandbox(getAgent("brain"));
  return `已卸载 MCP「${name}」。当前激活：${next.join(", ") || "（空）"}`;
}

export function listMcp(): string {
  const avail = catalogNames();
  const active = loadActive();
  return `可选 MCP：${avail.join(", ") || "（无）"}\n已激活：${active.join(", ") || "（空，默认不加载）"}`;
}
