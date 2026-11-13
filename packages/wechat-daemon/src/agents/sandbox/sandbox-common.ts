import fs from "node:fs";
import path from "node:path";

import { createLogger } from "@wemind/wechat-ilink-core";

import type { ResolvedAgent } from "../brain-agents.js";
import { copyProfilePatch, stripWechatMcpEntries } from "../profile-model.js";
import { applyOverlayToView, markGenerated, type ConfigView } from "../config/config-view.js";
import type { AgentRuntime } from "../config/runtime.js";
import { writeFileAtomic } from "../../shared/io/atomic-json.js";
import { forbiddenMcpServer, parseJsonc } from "./agent-mcp.js";
import { mcpAdapterFor, mcpAdapterForFile, mcpConfigPath } from "./mcp-adapters.js";

const log = createLogger("wechat-daemon/mcp");

/** 已经告警过的「real 模式下不可写」组合，避免每条消息刷日志。 */
const warnedRealHome = new Set<string>();

/** 目标目录是不是 agent 的真实 home（real/mirror 下没有视图时，写它就是改用户配置）。 */
export function isRealHomeTarget(ag: ResolvedAgent, dir: string): boolean {
  return !!ag.realHome && path.resolve(dir) === path.resolve(ag.realHome);
}

/** real/mirror 模式只有在生成了配置视图时才可以写；sandbox 模式写的是账号沙箱。 */
export function canWriteAgentConfig(ag: ResolvedAgent, rt: AgentRuntime): boolean {
  return rt.mode === "sandbox" || !!rt.view || !isRealHomeTarget(ag, rt.configDir);
}

/** real 模式下没有可重定向的配置目录：只告警一次，绝不写真实配置。 */
export function warnUnwritableRealHome(ag: ResolvedAgent, what: string): void {
  const key = `${ag.name}:${what}`;
  if (warnedRealHome.has(key)) return;
  warnedRealHome.add(key);
  log.warn(
    `agent「${ag.name}」没有可重定向的配置目录，real 模式不会改写真实配置（跳过${what}）；` +
      `微信侧 MCP/设置对这些 agent 不生效。需要生效请设 homeMode=sandbox 或换支持配置目录的 agent（mirror 对这类 agent 与 real 等价）。`,
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
 * 把 agent 的凭据文件同步进沙箱（如 DSH 的 `.credentials.yaml`、Qoder 的 `.auth/user`）。
 * - `newer`：首次复制；真实 home 的 token 刷新后覆盖沙箱；沙箱自己刷新过则保留沙箱版本。
 * - `always`：内容不同即覆盖（标识类文件，如 Qoder 的 `.auth/machine_id`——agent 在缺凭据时会自造一个，它比真实文件新，「新者胜」会把错的留下，导致永远认证失败）。
 * 这是敏感文件，仅放在账号沙箱内；Windows 无 POSIX 600，建议专用账号 + 目录 ACL。
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

/** 把预设的默认设置项补进视图/沙箱 settings.json：只补缺失键（用户显式设过就保留用户的值），真实配置不动。 */
export function applySettingsDefaults(
  ag: ResolvedAgent,
  configDir: string,
  view?: ConfigView,
): void {
  if (Object.keys(ag.settingsDefaults).length === 0) return;
  if (!view && isRealHomeTarget(ag, configDir)) {
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
    if (view) markGenerated(view, file);
  } catch {
    /* best-effort */
  }
}

/** 「设置与 MCP 同文件」的 agent：以真实 settings.json 为基底生成视图/沙箱的设置副本。
 *  剥离必须由沙箱权威决定的键（`ag.settingsStrip`，默认 DEFAULT_SETTINGS_STRIP）：
 *  - `mcpServers`：MCP 只能来自视图/沙箱的 curated 激活集（防 wechat 回环）；
 *  - `enabledPlugins`：插件可自带 MCP，且沙箱不继承 `plugins/`；
 *  - `providers` / `model`：自定义供应商（BYOK）含明文密钥，`model` 又可能指向已剥离的供应商。
 *  gemini 只剥 `mcpServers`——它的 model/security 是用户自己的选择，必须原样保留。
 *  并强制 `general.enableAutoUpdate=false`：否则每个视图/沙箱都会各下一份约 210 MB 的 CLI。 */
export function settingsBaseFor(ag: ResolvedAgent): Record<string, unknown> {
  const base =
    ag.settingsBase && ag.realHome
      ? (readJsonConfig(path.join(ag.realHome, ag.settingsBase)) ?? {})
      : {};
  for (const key of ag.settingsStrip) delete base[key];
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

/** 把 `settingsBaseFor()` 的结果写到该 agent 的「设置与 MCP 同文件」路径。
 *  返回 false 表示目标就是真实 home（real 模式无视图）：不写，只告警。 */
export function writeSettingsBase(
  ag: ResolvedAgent,
  configDir: string,
  view?: ConfigView,
): boolean {
  if (!view && isRealHomeTarget(ag, configDir)) {
    warnUnwritableRealHome(ag, "settingsBase/MCP");
    return false;
  }
  fs.mkdirSync(configDir, { recursive: true });
  const file = mcpConfigPath(ag, configDir);
  fs.writeFileSync(file, JSON.stringify(settingsBaseFor(ag), null, 2), "utf-8");
  if (view) markGenerated(view, file);
  return true;
}

/**
 * 把配置视图里由真实 home 链接/复制来的 MCP 文件再清一遍：
 *  - DSH：`profiles/<realProfile>/cordis.patch.yml`（mcpViaAcp，不会走 curated 写入）；
 *  - Copilot 这类「catalog 文件在视图根」的 agent：JSON 里的微信条目逐条剔除。
 *  只改视图副本（普通文件），不碰真实文件；清不掉（TOML/不可解析）就交给启动检查拒绝。
 */
export function sanitizeView(ag: ResolvedAgent, rt: AgentRuntime): void {
  const view = rt.view;
  // 没有视图时写的就是真实目录/沙箱外的实文件，这里一律不碰。
  if (!view) return;
  if (ag.realProfile) {
    for (const name of ["cordis.patch.yml", "cordis.yml"]) {
      const file = path.join(view.configDir, "profiles", ag.realProfile, name);
      if (!isRegularFile(file)) continue;
      try {
        const { text, removed } = stripWechatMcpEntries(fs.readFileSync(file, "utf-8"));
        if (!removed.length) continue;
        writeFileAtomic(file, text);
        log.warn(
          `配置视图里的微信 MCP 已剔除（${ag.name} → ${file}）：${removed.join(", ")}（真实文件未改）`,
        );
      } catch (e) {
        log.error(
          `配置视图清洗失败（${ag.name} → ${file}）：${String((e as Error)?.message ?? e)}`,
        );
      }
    }
  }
  if (!ag.mcpViaAcp || !ag.catalogFile || ag.catalogFile.includes("..")) return;
  const file = path.join(view.configDir, ag.catalogFile);
  if (!isRegularFile(file)) return;
  const adapter = mcpAdapterForFile(ag, file);
  if (adapter.id === "tomlMcpServers") return;
  try {
    const servers = adapter.readCatalog(file);
    const kept = Object.fromEntries(
      Object.entries(servers).filter(([name, def]) => !forbiddenMcpServer(name, def)),
    );
    if (Object.keys(kept).length === Object.keys(servers).length) return;
    adapter.writeCatalog(file, kept);
    const removed = Object.keys(servers).filter((n) => !(n in kept));
    log.warn(
      `配置视图里的微信 MCP 已剔除（${ag.name} → ${file}）：${removed.join(", ")}（真实文件未改）`,
    );
  } catch (e) {
    log.error(
      `配置视图 MCP 清洗失败（${ag.name} → ${file}）：${String((e as Error)?.message ?? e)}`,
    );
  }
}

/** 视图里的路径常是从真实 home 链接过来的：跟随链接读内容，写入时由 writeFileAtomic 换成独立副本。 */
function isRegularFile(file: string): boolean {
  try {
    const st = fs.lstatSync(file);
    return (st.isFile() || st.isSymbolicLink()) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * 继承真实 profile 的用户层（DSH：`profiles/<名>/cordis.patch.yml`，桌面端写 provider 目录与默认模型），**原样复制**。
 * WeMind 只镜像用户配置、不合成（`- id: acp` 由用户自己维护，缺失时 CLI 提示怎么补）；
 * **唯独剔除用户自己挂的微信 MCP 条目**：沙箱里的 MCP 只能是 WeMind 的激活集。
 */
export function syncProfilePatch(ag: ResolvedAgent, targetHome: string, label: string): void {
  if (!ag.realProfile || !ag.realHome || !ag.inherit) return;
  if (path.resolve(targetHome) === path.resolve(ag.realHome)) return; // 沙箱就是真实目录时不自我覆盖
  const src = path.join(ag.realHome, "profiles", ag.realProfile, "cordis.patch.yml");
  try {
    if (!fs.existsSync(src)) return;
    const removed = copyProfilePatch(ag.realHome, ag.realProfile, targetHome);
    if (removed.length) {
      log.warn(
        `真实 profile 里的微信 MCP 已从${label}沙箱副本剔除（防回环，真实文件未改）：${removed.join(", ")}`,
      );
    }
  } catch {
    /* best-effort */
  }
}

/** 把微信侧 config overlay 落到配置视图；没有配置目录环境变量的 agent 只能告警（不假装生效）。 */
export function warnOverlayProblems(ag: ResolvedAgent, rt: AgentRuntime): void {
  const problems = rt.view
    ? applyOverlayToView(rt.view, ag, rt.overlay, rt.mode)
    : Object.keys(rt.overlay.config ?? {}).length
      ? [
          `agent「${ag.name}」没有配置目录环境变量，微信侧 config overlay 无法生效（真实配置不受影响）`,
        ]
      : [];
  for (const problem of problems) log.warn(problem);
}
