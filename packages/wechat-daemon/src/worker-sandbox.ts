import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { DATA_DIR } from "@wemind/wechat-ilink-core";
import type { ResolvedAgent } from "./brain-agents.js";
import { getAgent } from "./agent-slot.js";
import { readMcpServers, withMcpServers, parseJsonc, toAcpMcpServers } from "./agent-mcp.js";

/**
 * worker 沙箱：与 brain 沙箱（mcp-sandbox.ts）并列，但 MCP 策略相反。
 *
 * worker 是无人值守的任务执行机，默认**继承真实配置目录的全部 MCP**（仅排除 wechat 防回环），而非 brain 的「默认空 + 对话中按需加载」——因为没人在旁边逐个加载工具，任务需要开箱即用的完整能力。
 * 记忆/技能/规则（mirrorRealKiro）与 settings（syncSettings，含模型/信任）的继承与 brain 一致。
 *
 * 按 agent 适配（同 mcp-sandbox.ts）：配置目录、MCP 格式、设置继承方式均随 agent 而变。
 * agent 不再存成模块常量：函数显式收 `ag`，入口用 `getAgent("worker")`（默认任务大脑）。
 *
 * 设计依据：docs/方案C-MVP-远程human-in-the-loop.md §8.4。
 * 与 mcp-sandbox.ts 有少量重复（mirrorRealKiro/syncSettings），刻意复制以隔离演进、不动已稳定的 brain 沙箱。
 */

/** worker 专用沙箱根（由 agent 的 homeEnvVar 指向它）。与 agent 无关。 */
export const WORKER_HOME =
  process.env.WEMIND_WORKER_HOME?.trim() || path.join(DATA_DIR, "worker-home");

/** 该 agent 在 worker 沙箱里的「配置目录」（kiro=沙箱根；opencode=<沙箱>/opencode）。 */
function workerConfigDir(ag: ResolvedAgent): string {
  return path.join(WORKER_HOME, ag.configSubdir);
}

function workerMcpJson(ag: ResolvedAgent): string {
  return path.join(workerConfigDir(ag), ag.mcpConfigFile);
}

/** MCP「目录」：可继承的 MCP 定义来源（同 brain，默认取 agent 真实配置目录的 catalogFile）。 */
function catalogPath(ag: ResolvedAgent): string {
  return (
    process.env.WEMIND_MCP_CATALOG?.trim() ||
    process.env.WECHAT_MCP_CATALOG?.trim() ||
    path.join(ag.realHome || path.join(os.homedir(), ".kiro"), ag.catalogFile)
  );
}

/** worker 不继承的 MCP：wechat 始终强制排除（防回环），外加 WEMIND_WORKER_MCP_EXCLUDE 指定的。 */
function excludeSet(): Set<string> {
  const raw = process.env.WEMIND_WORKER_MCP_EXCLUDE ?? "wechat";
  const s = new Set(
    raw
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean),
  );
  s.add("wechat"); // 强制：worker 加载 wechat 会用同一 bot token 长轮询、与 daemon 抢消息（坑①回环）
  return s;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 同 brain：把凭据文件（如 DSH 的 `.credentials.yaml`、Qoder 的 `.auth/user`）同步进 worker 沙箱。
 *  `newer`=新者胜；`always`=内容不同即覆盖（标识类文件必须与真实目录一致，见 mcp-sandbox.ts）。 */
function syncCredentialFile(ag: ResolvedAgent, file: string, mode: "newer" | "always"): void {
  if (!ag.realHome) return;
  const src = path.join(ag.realHome, file);
  const dst = path.join(workerConfigDir(ag), file);
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

/** worker 继承全量 MCP：复制 catalog 全部 server，去掉排除集与 disabled:true 的。
 *  `mcpViaAcp` 预设（DSH）不写文件——全量集合经 workerMcpServers() 转成 ACP mcpServers 随 session 下发。 */
function applyWorkerSandbox(ag: ResolvedAgent): void {
  if (ag.mcpViaAcp) return;
  const cat = loadCatalog(ag);
  const ex = excludeSet();
  const servers: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(cat)) {
    if (ex.has(name)) continue;
    if (def && typeof def === "object" && (def as { disabled?: unknown }).disabled === true)
      continue; // 跳过用户已禁用的
    servers[name] = def;
  }
  const file = workerMcpJson(ag);
  const existing = readJson(file) ?? {};
  const next = withMcpServers(existing, servers, ag.mcpFormat);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf-8");
}

/** worker 当前应挂载的 ACP mcpServers（mcpViaAcp 预设用）：全量 catalog（除排除集/disabled/坏条目）→ ACP 声明。 */
export function workerMcpServers(forAgent?: ResolvedAgent) {
  const ag = forAgent ?? getAgent("worker");
  const cat = loadCatalog(ag);
  const ex = excludeSet();
  const picked: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(cat)) {
    if (ex.has(name)) continue;
    if (def && typeof def === "object" && (def as { disabled?: unknown }).disabled === true)
      continue;
    picked[name] = def;
  }
  const { servers, skipped } = toAcpMcpServers(picked, { exclude: ex });
  if (skipped.length)
    console.error(`[wemind/wechat-daemon/mcp] worker 跳过无法转换的 MCP：${skipped.join(", ")}`);
  return servers;
}

/** kiro：继承真实 settings/ 下除 mcp.json 外的文件（cli.json 含模型/免确认等）。逻辑同 brain 的 syncKiroSettings。 */
function syncKiroSettings(ag: ResolvedAgent): void {
  const realSettings = path.join(ag.realHome!, "settings");
  const workerSettings = path.join(workerConfigDir(ag), "settings");
  if (!fs.existsSync(realSettings)) return;
  try {
    fs.mkdirSync(workerSettings, { recursive: true });
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
    if (f === "mcp.json") continue; // MCP 用 worker curated 版本（applyWorkerSandbox 全量除排除集）
    try {
      const src = path.join(realSettings, f);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(workerSettings, f));
    } catch {
      /* best-effort */
    }
  }
}

/** opencode：把用户全局 opencode.json(c)（去 mcp 段）作基底写入 worker 沙箱，继承 model 等；mcp 由 applyWorkerSandbox 覆盖。 */
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
  delete (parsed as Record<string, unknown>).mcp;
  const file = workerMcpJson(ag);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2), "utf-8");
}

/** Qoder 这类「设置与 MCP 同文件」的 agent：与 brain 相同的基底疗法（剥离 MCP/插件/自定义供应商 + 关自动更新）。 */
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
  const dir = workerConfigDir(ag);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(workerMcpJson(ag), JSON.stringify(settingsBase(ag), null, 2), "utf-8");
}

function syncSettings(ag: ResolvedAgent): void {
  if (ag.mcpViaAcp) return; // 无文件式 settings/MCP 可继承；模型走 preset.model
  if (ag.settingsBase && ag.realHome) {
    syncSettingsBase(ag); // 不依赖 inherit：沙箱硬化（关自动更新）与隔离始终生效
    return;
  }
  if (!ag.inherit || !ag.realHome) return;
  if (ag.mcpFormat === "opencode") syncOpencodeBase(ag);
  else syncKiroSettings(ag);
}

/** 用 junction/symlink 把真实配置目录的记忆/技能/规则类子目录链入 worker 配置目录；单文件记忆直接拷。逻辑同 brain 的 mirrorRealKiro。 */
function mirrorRealKiro(ag: ResolvedAgent): void {
  if (!ag.inherit || !ag.realHome) return;
  const dir = workerConfigDir(ag);
  if (path.resolve(WORKER_HOME) === path.resolve(ag.realHome)) return; // 安全：别把自己链给自己
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
      try {
        const st = fs.lstatSync(link);
        if (st.isSymbolicLink()) continue; // 已是链接 → 不动
        if (st.isDirectory()) {
          if (fs.readdirSync(link).length === 0) {
            fs.rmdirSync(link); // 空目录 → 删掉，下面改建 junction
          } else {
            // 非空真实目录：补拷真实目录里缺失的文件（不删已有）
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

/**
 * 启动时确保 worker 沙箱就绪：继承 settings（除 mcp）→ 写全量 MCP（除排除集）→ 链入记忆/技能 → 凭据。
 * `forAgent` 可显式指定 agent（多任务/池预热时为**那个** agent 备沙箱，此刻槽位可能指着别的默认）。
 */
export function ensureWorkerHome(forAgent?: ResolvedAgent): void {
  const ag = forAgent ?? getAgent("worker");
  syncSettings(ag); // 先同步「非 MCP」设置（模型/免确认等）
  applyWorkerSandbox(ag); // 再写全量 MCP（除 wechat 等排除集）
  mirrorRealKiro(ag); // 链入记忆/steering/skills（sessions 仍隔离）
  syncCredentials(ag); // 凭据（如 DSH 的 .credentials.yaml、Qoder 的 .auth/*）
}
