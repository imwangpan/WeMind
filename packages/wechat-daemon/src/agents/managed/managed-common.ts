import fs from "node:fs";
import path from "node:path";

import { createLogger } from "@wemind/wechat-ilink-core";

import type { ResolvedAgent } from "../brain-agents.js";
import { copyProfilePatch, stripWechatMcpEntries } from "../profile-model.js";
import type { AgentRuntime } from "../config/runtime.js";
import { writeFileAtomic } from "../../shared/io/atomic-json.js";
import { forbiddenMcpServer, parseJsonc } from "./agent-mcp.js";
import { mcpAdapterFor, mcpAdapterForFile, mcpConfigPath } from "./mcp-adapters.js";

const log = createLogger("wechat-daemon/mcp");

/** 已经告警过的「direct 模式下不可写」组合，避免每条消息刷日志。 */
const warnedRealHome = new Set<string>();

/** 目标目录是不是 agent 的真实 home。 */
export function isRealHomeTarget(ag: ResolvedAgent, dir: string): boolean {
  return !!ag.realHome && path.resolve(dir) === path.resolve(ag.realHome);
}

/** 只有 managed 才由 WeMind 写 Agent 配置；direct 一律不写。 */
export function canWriteAgentConfig(_ag: ResolvedAgent, rt: AgentRuntime): boolean {
  return rt.mode === "managed";
}

/** direct 模式不写 Agent 配置：只告警一次，绝不写真实配置。 */
export function warnUnwritableRealHome(ag: ResolvedAgent, what: string): void {
  const key = `${ag.name}:${what}`;
  if (warnedRealHome.has(key)) return;
  warnedRealHome.add(key);
  log.warn(
    `agent「${ag.name}」当前按 direct 运行，不会改写真实配置（跳过${what}）；` +
      `MCP/设置以 Agent 自己的配置为准。需要 WeMind 托管请设 homeMode=managed。`,
  );
}

/** 宽松读取（JSONC）：Gemini 的 settings.json 允许注释，严格 JSON.parse 会把合法配置当损坏。 */
export function readJsonConfig(file: string): Record<string, unknown> | null {
  try {
    return parseJsonc(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * 把 agent 的凭据文件同步进副本（如 DSH 的 `.credentials.yaml`、Qoder 的 `.auth/user`）。
 * - `newer`：首次复制；真实 home 的 token 刷新后覆盖副本；副本自己刷新过则保留副本版本。
 * - `always`：内容不同即覆盖（标识类文件，如 Qoder 的 `.auth/machine_id`——agent 在缺凭据时会自造一个，它比真实文件新，「新者胜」会把错的留下，导致永远认证失败）。
 * 这是敏感文件，仅放在账号副本内；Windows 无 POSIX 600，建议专用账号 + 目录 ACL。
 */
function syncCredentialFile(
  ag: ResolvedAgent,
  configDir: string,
  file: string,
  mode: "newer" | "always",
): void {
  if (!ag.realHome) return;
  const src = path.join(ag.realHome, file);
  const dst = path.join(configDir, file);
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

/** 按 `credentialFiles`（新者胜）与 `identityFiles`（内容不同即覆盖）同步登录态。 */
export function syncCredentials(ag: ResolvedAgent, configDir: string): void {
  for (const file of ag.credentialFiles) syncCredentialFile(ag, configDir, file, "newer");
  for (const file of ag.identityFiles) syncCredentialFile(ag, configDir, file, "always");
}

/** 把预设的默认设置项补进副本 settings.json：只补缺失键（用户显式设过就保留用户的值）。 */
export function applySettingsDefaults(ag: ResolvedAgent, configDir: string): void {
  if (Object.keys(ag.settingsDefaults).length === 0) return;
  if (isRealHomeTarget(ag, configDir)) {
    warnUnwritableRealHome(ag, "settingsDefaults");
    return;
  }
  const file = path.join(configDir, ag.settingsBase ?? "settings.json");
  const cur = readJsonConfig(file) ?? {};
  let changed = false;
  for (const [key, value] of Object.entries(ag.settingsDefaults)) {
    if (cur[key] === undefined) {
      cur[key] = value;
      changed = true;
    }
  }
  if (!changed) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cur, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
}

/** 「设置与 MCP 同文件」的 agent：把真实 settings.json **整份**复制进副本，只拿掉 MCP 段。
 *  唯一必须由副本权威决定的键就是 MCP：MCP 只能来自 curated 激活集（防 wechat 回环），键名按格式不同（`mcpServers` / `mcp`），
 *  由 `mcpAdapterFor().stripSettings()` 处理。其余键（`model` / `providers` / `security` / 插件…）**一律原样保留**：
 *  剥它们等于替用户改配置，上游一改键名就静默剥错，表现成「终端能用、微信不能用」；凭据本来也会随 `credentialFiles` 进副本
 *  （如 Cline 的 `data/settings/providers.json`），单独剥 `providers` 反而口径不一致。
 *  并强制 `general.enableAutoUpdate=false`：否则每个副本都会各下一份约 210 MB 的 CLI。 */
export function settingsBaseFor(ag: ResolvedAgent): Record<string, unknown> {
  const base =
    ag.settingsBase && ag.realHome
      ? (readJsonConfig(path.join(ag.realHome, ag.settingsBase)) ?? {})
      : {};
  mcpAdapterFor(ag).stripSettings(base); // 不同格式的 MCP 段键名不同（mcpServers / mcp）
  const general = base.general;
  base.general = {
    ...(general && typeof general === "object" && !Array.isArray(general)
      ? (general as Record<string, unknown>)
      : {}),
    enableAutoUpdate: false,
  };
  return base;
}

/** 把 `settingsBaseFor()` 的结果写到该 agent 的「设置与 MCP 同文件」路径。 */
export function writeSettingsBase(ag: ResolvedAgent, configDir: string): boolean {
  if (isRealHomeTarget(ag, configDir)) {
    warnUnwritableRealHome(ag, "settingsBase/MCP");
    return false;
  }
  fs.mkdirSync(configDir, { recursive: true });
  const file = mcpConfigPath(ag, configDir);
  fs.writeFileSync(file, JSON.stringify(settingsBaseFor(ag), null, 2), "utf-8");
  return true;
}

/**
 * 把副本副本里由真实 home 复制来的 MCP 文件再清一遍：
 *  - DSH：`profiles/<realProfile>/cordis.patch.yml`（mcpDelivery=acp，MCP 条目在复制时已剥离）；
 *  - Copilot 这类「catalog 文件在配置目录」的 agent：JSON 里的微信条目逐条剔除。
 *  只改副本副本，不碰真实文件。
 */
export function stripWechatFromConfigCopy(ag: ResolvedAgent, rt: AgentRuntime): void {
  if (rt.mode !== "managed") return;
  const base = rt.configDir;
  if (ag.realProfile) {
    for (const name of ["cordis.patch.yml", "cordis.yml"]) {
      const file = path.join(base, "profiles", ag.realProfile, name);
      if (!isRegularFile(file)) continue;
      try {
        const { text, removed } = stripWechatMcpEntries(fs.readFileSync(file, "utf-8"));
        if (!removed.length) continue;
        writeFileAtomic(file, text);
        log.warn(
          `副本副本里的微信 MCP 已剔除（${ag.name} → ${file}）：${removed.join(", ")}（真实文件未改）`,
        );
      } catch (e) {
        log.error(
          `副本副本清洗失败（${ag.name} → ${file}）：${String((e as Error)?.message ?? e)}`,
        );
      }
    }
  }
  if (!ag.catalogFile || ag.catalogFile.includes("..")) return;
  const file = path.join(base, ag.catalogFile);
  if (!isRegularFile(file)) return;
  const adapter = mcpAdapterForFile(ag, file);
  if (adapter.nativeOwned) return;
  try {
    const servers = adapter.readCatalog(file);
    const kept = Object.fromEntries(
      Object.entries(servers).filter(([name, def]) => !forbiddenMcpServer(name, def)),
    );
    if (Object.keys(kept).length === Object.keys(servers).length) return;
    adapter.writeCatalog(file, kept);
    const removed = Object.keys(servers).filter((n) => !(n in kept));
    log.warn(
      `副本副本里的微信 MCP 已剔除（${ag.name} → ${file}）：${removed.join(", ")}（真实文件未改）`,
    );
  } catch (e) {
    log.error(
      `副本副本 MCP 清洗失败（${ag.name} → ${file}）：${String((e as Error)?.message ?? e)}`,
    );
  }
}

/** 跟随链接读内容，写入时由 writeFileAtomic 换成独立副本。 */
function isRegularFile(file: string): boolean {
  try {
    const st = fs.lstatSync(file);
    return (st.isFile() || st.isSymbolicLink()) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * 继承真实 profile 的用户层（DSH：`profiles/<名>/cordis.patch.yml`，桌面端写 provider 目录与默认模型）：
 * provider/模型等非 MCP 条目**原样复制**，WeMind 不合成（`- id: acp` 由用户自己维护，缺失时 CLI 提示怎么补）。
 * MCP 条目按投递方式处理：`mcpDelivery: "acp"` 时**全部剥离**（副本里的集合由 WeMind 经 ACP 注入，避免重复）；
 * 否则只剔除用户自己挂的微信 MCP 条目（防回环）。
 */
export function syncProfilePatch(ag: ResolvedAgent, targetHome: string, label: string): void {
  if (!ag.realProfile || !ag.realHome || !ag.inherit) return;
  if (path.resolve(targetHome) === path.resolve(ag.realHome)) return; // 副本就是真实目录时不自我覆盖
  const src = path.join(ag.realHome, "profiles", ag.realProfile, "cordis.patch.yml");
  try {
    if (!fs.existsSync(src)) return;
    const removed = copyProfilePatch(ag.realHome, ag.realProfile, targetHome, {
      stripAllMcp: ag.mcpDelivery === "acp",
    });
    if (removed.length) {
      log.warn(
        ag.mcpDelivery === "acp"
          ? `${label}副本副本里的 MCP 条目已剥离（由 WeMind 按${label === "大脑" ? "激活集" : "全量集"}经 ACP 注入，真实文件未改）：${removed.join(", ")}`
          : `真实 profile 里的微信 MCP 已从${label}副本副本剔除（防回环，真实文件未改）：${removed.join(", ")}`,
      );
    }
  } catch {
    /* best-effort */
  }
}
