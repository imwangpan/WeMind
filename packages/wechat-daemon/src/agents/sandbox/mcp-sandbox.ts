import path from "node:path";

import { createLogger, DATA_DIR } from "@wemind/wechat-ilink-core";
import { ensureKiroV3Permissions, type ResolvedAgent } from "../brain-agents.js";
import { getAgent } from "../agent-slot.js";
import { isWechatMcpServer } from "./agent-mcp.js";
import { mcpAdapterFor, mcpAdapterForFile, mcpCatalogPath, mcpConfigPath } from "./mcp-adapters.js";
import {
  applySettingsDefaults,
  readJsonConfig,
  syncCredentials,
  syncProfilePatch,
  warnOverlayProblems,
  writeSettingsBase,
} from "./sandbox-common.js";
import { syncInherited } from "./sandbox-inherit.js";
import { writeJsonAtomic } from "../../shared/io/atomic-json.js";
import { agentRuntime, sandboxRoot, type AgentRuntime } from "../config/runtime.js";
import { markGenerated } from "../config/config-view.js";
import {
  overlayDisableSet,
  overlayExtraServers,
  readOverlay,
  writeOverlay,
} from "../config/overlay.js";
const log = createLogger("wechat-daemon/mcp");

/**
 * brain 的 MCP 视图：brain 的配置根是 agent-view（real/mirror）或 brain-home（sandbox），默认不加载任何 MCP。
 * 通过对话指令（加载/卸载/列出）动态调整「激活集」，从全局 MCP 目录取定义写入视图/沙箱。
 * DATA_DIR 从 core 导入（支持 WECHAT_DATA_DIR 覆盖，便于多账号隔离）。
 *
 * 按 agent 适配（见 brain-agents.ts 里的 agent 配置与 docs/接入-OpenCode.md）：
 * - 配置目录：kiro = home 根本身（KIRO_HOME）；opencode = <home>/opencode（XDG_CONFIG_HOME）。
 * - MCP 文件：kiro = settings/mcp.json（{mcpServers}）；opencode = opencode.json（mcp.servers）。
 * kiro 行为与改造前完全一致（默认值即 kiro 约定）。
 *
 * agent 不再存成模块常量（改造前是 import 时解析的 `AG`）：每个函数显式收 `ag`，
 * 或在入口用 `getAgent("brain")` 取一次当前大脑——热切换后沙箱会写到新 agent 的配置目录。
 */

/** sandbox 模式的 brain 沙箱根目录（显式回退；real/mirror 用 agentRuntime().home）。 */
export const BRAIN_HOME = process.env.WECHAT_BRAIN_HOME?.trim() || sandboxRoot("brain", DATA_DIR);

/** 该 agent 的「配置目录」（kiro=home 根；opencode=<home>/opencode）。 */
function brainConfigDir(ag: ResolvedAgent, rt?: AgentRuntime): string {
  return rt ? rt.configDir : path.join(BRAIN_HOME, ag.configSubdir);
}

/** MCP 配置文件（相对配置目录，按 agent 的 mcpConfigFile）。 */
function brainMcpJson(ag: ResolvedAgent, rt?: AgentRuntime): string {
  return mcpConfigPath(ag, brainConfigDir(ag, rt));
}

/** 激活集持久化文件（按账号；同一账号内按 agent 分键）。 */
function activeFile(dir: string = DATA_DIR): string {
  return path.join(dir, "brain-mcps.json");
}

/** 永不允许 brain 加载（防它把消息发回自己）。 */
const FORBIDDEN = new Set(["wechat"]);

/** 名字命中禁用集，或定义本身就是微信 MCP（改名也拦得住）。 */
function forbiddenServer(name: string, def: unknown): boolean {
  return FORBIDDEN.has(name) || isWechatMcpServer(def);
}

/**
 * 让 brain 继承所用 agent 真实配置目录的「知识/记忆/技能」：
 * - 目录式（inheritDirs，如 kiro 的 steering/memories/skills、opencode 的 skills/agents/commands）用目录 junction（Windows）/ symlink 指向真实目录；
 * - 单文件式（inheritFiles，如 opencode 的 AGENTS.md）直接拷入配置目录。
 * 使微信里的大脑和你日常使用读到同样的记忆、规则、技能。
 * **MCP（settings/opencode.json 的 mcp 段）与 brain 自有会话（sessions）不照搬**：MCP 必须走沙箱（排除 wechat，防它把消息发回自己），会话不能混。
 */
function mirrorRealKiro(ag: ResolvedAgent, rt: AgentRuntime): void {
  syncInherited(rt.home, brainConfigDir(ag, rt), ag);
}

/** 读「目录」文件：格式由实际文件后缀与 agent 配置决定（JSON/JSONC/TOML）。 */
function readCatalog(ag: ResolvedAgent): Record<string, unknown> {
  const file = mcpCatalogPath(ag);
  return mcpAdapterForFile(ag, file).readCatalog(file);
}

function loadCatalog(ag: ResolvedAgent, dir: string = DATA_DIR): Record<string, unknown> {
  const base = readCatalog(ag);
  const overlay = readOverlay(ag.name, dir).overlay;
  return { ...base, ...overlayExtraServers(overlay) };
}

/** Agent 自己配置文件里的 MCP（目前只有 Codex 的 config.toml 属于这种「WeMind 管不住」的来源）。 */
export function nativeMcpServers(ag: ResolvedAgent): Record<string, unknown> {
  const file = mcpCatalogPath(ag);
  const adapter = mcpAdapterForFile(ag, file);
  return adapter.nativeOwned ? adapter.nativeCatalog(file) : {};
}

/**
 * Codex 的 `config.toml` 由 Codex 自己加载，WeMind 只读、不会改写；因此「永久排除 wechat」不能靠下发空列表实现。
 * 原生配置里一旦有 wechat（或任何会跑 `wemind-mcp` 的定义），brain/worker 都会把它拉起来形成第二个 poller → 直接拒绝启动。
 */
export function assertNoForbiddenNativeMcp(ag: ResolvedAgent): void {
  const native = nativeMcpServers(ag);
  const bad = Object.keys(native).filter((name) => forbiddenServer(name, native[name]));
  if (!bad.length) return;
  throw new Error(
    `agent 自己的配置文件里有微信 MCP（${bad.join(", ")}），WeMind 只读、无法替它剥离；同一条微信消息会被两个程序抢/回环。请从 ${mcpCatalogPath(ag)} 删除这些条目后重启，或换一个大脑。`,
  );
}

/** 目录中可选的 server 名（排除禁用项）。 */
export function catalogNames(forAgent?: ResolvedAgent, dir: string = DATA_DIR): string[] {
  const ag = forAgent ?? getAgent("brain");
  const cat = loadCatalog(ag, dir);
  const disabled = overlayDisableSet(readOverlay(ag.name, dir).overlay);
  return Object.keys(cat).filter((n) => !disabled.has(n) && !forbiddenServer(n, cat[n]));
}

/** 按 agent 分键；旧版 `{active:[...]}` 全局列表在第一次读取时归到当前 agent。 */
export function loadActive(
  agentName: string = getAgent("brain").name,
  dir: string = DATA_DIR,
): string[] {
  const j = readJsonConfig(activeFile(dir));
  if (!j) return [];
  if (Array.isArray(j.active)) {
    const legacy = (j.active as unknown[]).filter((x): x is string => typeof x === "string");
    saveActive(legacy, agentName, dir);
    return legacy;
  }
  const map = j.active;
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  const a = (map as Record<string, unknown>)[agentName];
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
}

function saveActive(
  list: string[],
  agentName: string = getAgent("brain").name,
  dir: string = DATA_DIR,
): void {
  const j = readJsonConfig(activeFile(dir));
  const map: Record<string, unknown> =
    j?.active && typeof j.active === "object" && !Array.isArray(j.active)
      ? { ...(j.active as Record<string, unknown>) }
      : {};
  map[agentName] = list;
  writeJsonAtomic(activeFile(dir), { version: 2, active: map });
}

/** 按激活集从目录取定义，写入沙箱 MCP 配置（默认空）。保留配置里其它键（如 opencode 的 model）。
 *  配了 `mcpViaAcp` 的 agent（DSH）不写文件——激活集经 activeMcpServers() 转成 ACP mcpServers 随 session 下发。 */
function applySandbox(ag: ResolvedAgent, rt?: AgentRuntime, dir: string = DATA_DIR): void {
  if (ag.mcpViaAcp) return;
  const cat = loadCatalog(ag, dir);
  const disabled = overlayDisableSet(readOverlay(ag.name, dir).overlay);
  const active = loadActive(ag.name, dir).filter(
    (n) => cat[n] && !disabled.has(n) && !forbiddenServer(n, cat[n]),
  );
  const servers: Record<string, unknown> = {};
  for (const n of active) servers[n] = cat[n];
  const file = brainMcpJson(ag, rt);
  mcpAdapterForFile(ag, file).writeCatalog(file, servers);
  if (rt?.view) markGenerated(rt.view, file);
}

/** brain 当前应挂载的 ACP mcpServers（配了 mcpViaAcp 的 agent 用）：激活集 → catalog 定义 → ACP 声明。
 *  跳过不可转换的坏条目并记日志——官方 DSH 的 session/new 遇到起不来的 MCP 会回滚整个会话。
 *  **必须传正在启动的那个 agent**：热切换时槽位还指着旧大脑，用默认值会把旧 agent 的 MCP 目录发给新大脑。 */
export function activeMcpServers(
  ag: ResolvedAgent = getAgent("brain"),
  rt?: AgentRuntime,
  dir: string = DATA_DIR,
) {
  const cat = loadCatalog(ag, dir);
  const disabled = overlayDisableSet(readOverlay(ag.name, dir).overlay);
  const active = loadActive(ag.name, dir).filter(
    (n) => cat[n] && !disabled.has(n) && !forbiddenServer(n, cat[n]),
  );
  const picked: Record<string, unknown> = {};
  for (const n of active) picked[n] = cat[n];
  const { servers, skipped } = mcpAdapterFor(ag).toAcp(picked, FORBIDDEN);
  if (skipped.length) log.warn(`跳过无法转换的 MCP：${skipped.join(", ")}`);
  return servers;
}

/** 按适配器继承该 Agent 的「非 MCP」设置（kiro 的 settings/*；opencode 的 model 等同文件设置）。 */
function syncFormatSettings(ag: ResolvedAgent, rt: AgentRuntime): void {
  const adapter = mcpAdapterFor(ag);
  if (!adapter.inheritSettings || !ag.realHome) return;
  adapter.inheritSettings(ag, ag.realHome, brainConfigDir(ag, rt));
  if (adapter.rebuildSettingsInView && rt.view) markGenerated(rt.view, brainMcpJson(ag, rt));
}

/** 继承真实配置目录的「非 MCP」设置（模型/免确认等），让大脑与日常使用同款配置；mcp 段保持沙箱权威。
 *  配了 `mcpViaAcp` 的 agent 也仍有「profile 用户层」可继承（DSH 的 provider 目录/默认模型），只是 MCP 不写文件。 */
function syncSettings(ag: ResolvedAgent, rt: AgentRuntime): void {
  if (rt.mode === "sandbox") syncProfilePatch(ag, rt.home, "大脑");
  if (ag.mcpViaAcp) return;
  if (ag.settingsBase && ag.realHome) {
    writeSettingsBase(ag, brainConfigDir(ag, rt), rt.view); // 不依赖 inherit：视图/沙箱的硬化（关自动更新）始终生效
    return;
  }
  if (!ag.inherit || !ag.realHome) return;
  if (rt.mode !== "sandbox" && !mcpAdapterFor(ag).rebuildSettingsInView) return;
  syncFormatSettings(ag, rt);
}

/**
 * 启动时确保沙箱存在并与激活集一致。
 * `forAgent` 可显式指定 agent（切换流程启动新大脑用：启动新大脑时要先备好**它**的沙箱，此刻槽位还指着旧大脑）。
 */
export function ensureBrainHome(forAgent?: ResolvedAgent, dir: string = DATA_DIR): void {
  const ag = forAgent ?? getAgent("brain");
  const rt = agentRuntime("brain", ag, dir);
  syncSettings(ag, rt); // 先同步「非 MCP」设置(模型/免确认等)，让大脑与日常使用同款配置
  if (rt.mode === "sandbox") {
    mirrorRealKiro(ag, rt); // 继承真实配置目录的记忆/steering/skills
    syncCredentials(ag, brainConfigDir(ag, rt)); // 登录态/凭据（如 DSH 的 .credentials.yaml、Qoder 的 .auth/*）
  }
  warnOverlayProblems(ag, rt);
  applySandbox(ag, rt, dir); // 再写 curated mcp（权威，保持 MCP 隔离——防它把消息发回自己）
  applySettingsDefaults(ag, brainConfigDir(ag, rt), rt.view); // 预设默认设置项（如 pi 的 quietStartup：关掉 pi-acp 当消息发出来的启动信息）
  if (ag.kiroV3) ensureKiroV3Permissions(ag, path.join(rt.configDir, "settings"));
}

export interface McpChangeResult {
  /** 指令是否执行成功；失败时调用方不应重启大脑。 */
  ok: boolean;
  /** 激活集是否真的变了；没变就不必重启 ACP 进程。 */
  changed: boolean;
  /** 给用户的答复原文。 */
  text: string;
}

export function addMcp(
  name: string,
  forAgent?: ResolvedAgent,
  dir: string = DATA_DIR,
): McpChangeResult {
  const ag = forAgent ?? getAgent("brain");
  const cat = loadCatalog(ag, dir);
  if (forbiddenServer(name, cat[name]))
    return { ok: false, changed: false, text: `不允许加载「${name}」（防它把消息发回自己）。` };
  if (!cat[name])
    return {
      ok: false,
      changed: false,
      text: `未找到 MCP「${name}」。可选：${catalogNames(ag, dir).join(", ") || "（无）"}`,
    };
  // 预校验：坏条目不进激活集（官方 DSH 的 session/new 会因起不来的 MCP 回滚整会话）
  if (ag.mcpViaAcp && !mcpAdapterFor(ag).toAcp({ [name]: cat[name] }).servers.length)
    return {
      ok: false,
      changed: false,
      text: `MCP「${name}」的定义无法转换（需要 command 或 url），已拒绝加载。`,
    };
  const a = loadActive(ag.name, dir);
  const changed = !a.includes(name);
  if (changed) {
    a.push(name);
    saveActive(a, ag.name, dir);
  }
  // 显式加载会解除同名 disable；否则“加载后仍不生效”会很难解释。
  const ov = readOverlay(ag.name, dir).overlay;
  if (ov.mcp?.disable?.includes(name)) {
    const disable = ov.mcp.disable.filter((x) => x !== name);
    const next = {
      ...ov,
      mcp: { ...ov.mcp, ...(disable.length ? { disable } : {}) },
    };
    if (!next.mcp?.disable?.length && !next.mcp?.extra) delete (next as { mcp?: unknown }).mcp;
    writeOverlay(ag.name, next, dir);
  }
  applySandbox(ag, agentRuntime("brain", ag, dir), dir);
  return {
    ok: true,
    changed,
    text: `已加载 MCP「${name}」。当前激活：${a.join(", ")}（下一条消息生效）`,
  };
}

export function removeMcp(
  name: string,
  forAgent?: ResolvedAgent,
  dir: string = DATA_DIR,
): McpChangeResult {
  const ag = forAgent ?? getAgent("brain");
  const a = loadActive(ag.name, dir);
  if (!a.includes(name)) return { ok: false, changed: false, text: `「${name}」当前未激活。` };
  const next = a.filter((x) => x !== name);
  saveActive(next, ag.name, dir);
  applySandbox(ag, agentRuntime("brain", ag, dir), dir);
  return {
    ok: true,
    changed: true,
    text: `已卸载 MCP「${name}」。当前激活：${next.join(", ") || "（空）"}`,
  };
}

export function listMcp(dir: string = DATA_DIR): string {
  const avail = catalogNames(undefined, dir);
  const active = loadActive(undefined, dir);
  return `可选 MCP：${avail.join(", ") || "（无）"}\n已激活：${active.join(", ") || "（空，默认不加载）"}`;
}
