import path from "node:path";
import fs from "node:fs";

import { createLogger, DATA_DIR } from "@wemind/wechat-ilink-core";
import { ensureKiroV3Permissions, type ResolvedAgent } from "../brain-agents.js";
import { getAgent } from "../agent-slot.js";
import type { AgentRole } from "../brain-config.js";
import {
  forbiddenMcpServer,
  isForbiddenMcpName,
  normalizeMcpName,
  parseJsonc,
} from "./agent-mcp.js";
import { mcpAdapterFor, mcpAdapterForFile, mcpCatalogPath, mcpConfigPath } from "./mcp-adapters.js";
import { parseTomlMcpServers } from "./toml-mcp.js";
import { stripWechatMcpEntries } from "../profile-model.js";
import {
  applySettingsDefaults,
  canWriteAgentConfig,
  readJsonConfig,
  sanitizeView,
  syncCredentials,
  syncProfilePatch,
  warnOverlayProblems,
  warnUnwritableRealHome,
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
 * 或在入口用 `getAgent("brain")` 取一次当前大脑——热切换后视图/沙箱会写到新 agent 的配置目录。
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

/** 旧版全局激活集只提示一次（真正迁移发生在下一次 add/remove）。 */
let legacyActiveNoticed = false;

/**
 * 让 brain 继承所用 agent 真实配置目录的「知识/记忆/技能」：
 * - 目录式（inheritDirs，如 kiro 的 steering/memories/skills、opencode 的 skills/agents/commands）用目录 junction（Windows）/ symlink 指向真实目录；
 * - 单文件式（inheritFiles，如 opencode 的 AGENTS.md）直接拷入配置目录。
 * 使微信里的大脑和你日常使用读到同样的记忆、规则、技能。
 * **MCP（settings/opencode.json 的 mcp 段）与 brain 自有会话（sessions）不照搬**：MCP 必须走视图/沙箱的排除集（排除 wechat，防它把消息发回自己），会话不能混。
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

/** 读 JSON 配置文件里的 MCP 定义（两种格式都查：不依赖 agent 的 mcpFormat，检查要更严）。 */
function jsonMcpFromFile(file: string): Record<string, unknown> {
  const raw = fs.readFileSync(file, "utf-8");
  if (!raw.trim()) return {};
  const parsed = parseJsonc(raw);
  if (!parsed) throw new Error(`无法解析 ${file}（JSON/JSONC 语法错误），无法确认其中的 MCP 定义`);
  const out: Record<string, unknown> = {};
  const top = parsed.mcpServers;
  if (top && typeof top === "object" && !Array.isArray(top)) Object.assign(out, top);
  const nested = parsed.mcp;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const servers = (nested as Record<string, unknown>).servers;
    if (servers && typeof servers === "object" && !Array.isArray(servers))
      Object.assign(out, servers);
  }
  return out;
}

/** 原生配置文件（agent 自己加载、WeMind 无法替它剥离）里的 MCP。 */
export function nativeMcpServers(ag: ResolvedAgent): Record<string, unknown> {
  if (!ag.realHome || !ag.catalogFile) return {};
  const file = path.resolve(ag.realHome, ag.catalogFile);
  if (path.extname(file).toLowerCase() === ".toml") {
    try {
      return parseTomlMcpServers(fs.readFileSync(file, "utf-8")).mcpServers;
    } catch {
      return {};
    }
  }
  try {
    return jsonMcpFromFile(file);
  } catch {
    return {};
  }
}

/** 启动检查要看的文件（存在才查）：视图里的副本优先（real/mirror 下已清洗），否则真实文件。 */
function nativeScanFiles(ag: ResolvedAgent, rt?: AgentRuntime): string[] {
  const out = new Set<string>();
  if (ag.realProfile && ag.realHome) {
    const base = rt?.view ? rt.configDir : ag.realHome;
    for (const name of ["cordis.patch.yml", "cordis.yml"]) {
      out.add(path.join(base, "profiles", ag.realProfile, name));
    }
  }
  if (ag.catalogFile && ag.realHome) {
    const base = rt?.view ? rt.configDir : ag.realHome;
    out.add(path.resolve(base, ag.catalogFile));
  }
  // 无视图的文件式 agent（qoder/cline 等）：MCP 文件就是真实配置文件，只能检查不能改
  if (!ag.mcpViaAcp && ag.realHome) out.add(mcpCatalogPath(ag));
  if (!ag.mcpViaAcp && !rt?.view && ag.settingsBase && ag.realHome) {
    out.add(path.join(ag.realHome, ag.settingsBase));
  }
  for (const extra of ag.extraConfigFiles ?? []) out.add(extra.source);
  return [...out];
}

/**
 * brain/worker 启动前的强制检查：agent 自己会加载的配置里不得出现微信 MCP。
 * - Codex TOML：WeMind 只读，解析失败/截断一律拒绝（fail-closed）；
 * - DSH profile / Copilot 等 JSON：视图副本已由 sanitizeView 剔除，真实文件仍含就拒绝（无法替它剥离）；
 * - 无视图的文件式 agent：真实 MCP 文件里含微信条目就拒绝（real 模式不会写入，只会冲突）。
 */
export function assertNoForbiddenNativeMcp(ag: ResolvedAgent, rt?: AgentRuntime): void {
  const problems: string[] = [];
  const bad: string[] = [];
  for (const file of nativeScanFiles(ag, rt)) {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      problems.push(`无法读取 ${file}：${(e as Error)?.message ?? String(e)}`);
      continue;
    }
    if (!st.isFile()) continue;
    if (path.extname(file).toLowerCase() === ".toml") {
      try {
        const parsed = parseTomlMcpServers(fs.readFileSync(file, "utf-8"));
        problems.push(...parsed.problems.map((p) => `${file}：${p}`));
        for (const [name, def] of Object.entries(parsed.mcpServers)) {
          if (forbiddenMcpServer(name, def)) bad.push(`${name}（${file}）`);
        }
      } catch (e) {
        problems.push(`无法读取 ${file}：${(e as Error)?.message ?? String(e)}`);
      }
      continue;
    }
    if (/\.ya?ml$/i.test(file)) {
      try {
        const { removed } = stripWechatMcpEntries(fs.readFileSync(file, "utf-8"));
        for (const name of removed) bad.push(`${name}（${file}）`);
      } catch (e) {
        problems.push(`无法读取 ${file}：${(e as Error)?.message ?? String(e)}`);
      }
      continue;
    }
    try {
      for (const [name, def] of Object.entries(jsonMcpFromFile(file))) {
        if (forbiddenMcpServer(name, def)) bad.push(`${name}（${file}）`);
      }
    } catch (e) {
      problems.push((e as Error)?.message ?? String(e));
    }
  }
  if (bad.length) {
    throw new Error(
      `agent 自己的配置文件里有微信 MCP（${bad.join(", ")}），WeMind 无法替它剥离；同一条微信消息会被两个程序抢/回环。请删除这些条目后重启，或换一个大脑。`,
    );
  }
  if (problems.length) {
    throw new Error(
      `无法确认 agent 自己的配置里是否含微信 MCP，已拒绝启动：${problems.join("；")}。`,
    );
  }
}

/** 目录中可选的 server 名（排除禁用项）。 */
export function catalogNames(forAgent?: ResolvedAgent, dir: string = DATA_DIR): string[] {
  const ag = forAgent ?? getAgent("brain");
  const cat = loadCatalog(ag, dir);
  const disabled = overlayDisableSet(readOverlay(ag.name, dir).overlay);
  return Object.keys(cat).filter(
    (n) => !disabled.has(normalizeMcpName(n)) && !forbiddenMcpServer(n, cat[n]),
  );
}

/** 按 agent 分键；旧版 `{active:[...]}` 全局列表不再在读取时改写文件（读操作不产生副作用），
 *  下次 add/remove 迁移到当前 agent 名下；读取时已经过滤掉禁用项。 */
export function loadActive(
  agentName: string = getAgent("brain").name,
  dir: string = DATA_DIR,
): string[] {
  const j = readJsonConfig(activeFile(dir));
  if (!j) return [];
  if (Array.isArray(j.active)) {
    if (!legacyActiveNoticed) {
      legacyActiveNoticed = true;
      log.info(
        `检测到旧版全局 MCP 激活集：将保留现有条目，并在下一次 wemind mcp 变更时归入「${agentName}」。`,
      );
    }
    return (j.active as unknown[])
      .filter((x): x is string => typeof x === "string")
      .filter((n) => !isForbiddenMcpName(n));
  }
  const map = j.active;
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  const a = (map as Record<string, unknown>)[agentName];
  return Array.isArray(a)
    ? a.filter((x): x is string => typeof x === "string").filter((n) => !isForbiddenMcpName(n))
    : [];
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
  if (Array.isArray(j?.active)) {
    // 旧版全局列表：保留，但只归入当前 agent，避免其它 agent 继承微信相关条目。
    map[agentName] = (j.active as unknown[]).filter((x): x is string => typeof x === "string");
  } else {
    map[agentName] = list;
  }
  writeJsonAtomic(activeFile(dir), { version: 2, active: map });
}

/** 按激活集从目录取定义，写入视图/沙箱 MCP 配置（默认空）。保留配置里其它键（如 opencode 的 model）。
 *  配了 `mcpViaAcp` 的 agent（DSH）不写文件——激活集经 activeMcpServers() 转成 ACP mcpServers 随 session 下发。 */
function applySandbox(ag: ResolvedAgent, rt?: AgentRuntime, dir: string = DATA_DIR): void {
  if (ag.mcpViaAcp) return;
  // 不要在这里重建视图：调用方的 rt 里已经有 overlay 之后的视图，重算会把 overlay 覆盖回真实值。
  const target = rt ?? agentRuntime("brain", ag, dir);
  if (!canWriteAgentConfig(ag, target)) {
    warnUnwritableRealHome(ag, "MCP 激活集");
    return;
  }
  const cat = loadCatalog(ag, dir);
  const disabled = overlayDisableSet(readOverlay(ag.name, dir).overlay);
  const active = loadActive(ag.name, dir).filter(
    (n) => cat[n] && !disabled.has(normalizeMcpName(n)) && !forbiddenMcpServer(n, cat[n]),
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
    (n) => cat[n] && !disabled.has(normalizeMcpName(n)) && !forbiddenMcpServer(n, cat[n]),
  );
  const picked: Record<string, unknown> = {};
  for (const n of active) picked[n] = cat[n];
  const forbiddenNames = new Set(
    Object.keys(picked).filter((n) => forbiddenMcpServer(n, picked[n])),
  );
  const { servers, skipped } = mcpAdapterFor(ag).toAcp(picked, forbiddenNames);
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

/** 继承真实配置目录的「非 MCP」设置（模型/免确认等），让大脑与日常使用同款配置；mcp 段保持视图/沙箱权威。
 *  配了 `mcpViaAcp` 的 agent 也仍有「profile 用户层」可继承（DSH 的 provider 目录/默认模型），只是 MCP 不写文件。 */
function syncSettings(ag: ResolvedAgent, rt: AgentRuntime): void {
  if (rt.mode === "sandbox") syncProfilePatch(ag, rt.home, "大脑");
  if (ag.mcpViaAcp) return;
  if (ag.settingsBase && ag.realHome) {
    if (!canWriteAgentConfig(ag, rt)) {
      warnUnwritableRealHome(ag, "基础设置（settings）");
      return;
    }
    writeSettingsBase(ag, brainConfigDir(ag, rt), rt.view); // 不依赖 inherit：视图/沙箱的硬化（关自动更新）始终生效
    return;
  }
  if (!ag.inherit || !ag.realHome) return;
  if (!canWriteAgentConfig(ag, rt)) return;
  if (rt.mode !== "sandbox" && !mcpAdapterFor(ag).rebuildSettingsInView) return;
  syncFormatSettings(ag, rt);
}

/**
 * 启动时确保配置视图/沙箱存在并与激活集一致。
 * `forAgent` 可显式指定 agent（切换流程启动新大脑用：启动新大脑时要先备好**它**的视图/沙箱，此刻槽位还指着旧大脑）。
 */
export function ensureBrainHome(forAgent?: ResolvedAgent, dir: string = DATA_DIR): AgentRuntime {
  const ag = forAgent ?? getAgent("brain");
  const rt = agentRuntime("brain", ag, dir);
  syncSettings(ag, rt); // 先同步「非 MCP」设置(模型/免确认等)，让大脑与日常使用同款配置
  if (rt.mode === "sandbox") {
    mirrorRealKiro(ag, rt); // 继承真实配置目录的记忆/steering/skills
    syncCredentials(ag, brainConfigDir(ag, rt)); // 登录态/凭据（如 DSH 的 .credentials.yaml、Qoder 的 .auth/*）
  }
  warnOverlayProblems(ag, rt);
  sanitizeView(ag, rt); // 视图副本里剔除微信 MCP（DSH profile / Copilot 原生配置等）
  applySandbox(ag, rt, dir); // 再写 curated mcp（权威，保持 MCP 隔离——防它把消息发回自己）
  applySettingsDefaults(ag, brainConfigDir(ag, rt), rt.view); // 预设默认设置项（如 pi 的 quietStartup：关掉 pi-acp 当消息发出来的启动信息）
  if (ag.kiroV3) ensureKiroV3Permissions(ag, path.join(rt.configDir, "settings"));
  return rt;
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
  role: AgentRole = "brain",
): McpChangeResult {
  const ag = forAgent ?? getAgent(role);
  const cat = loadCatalog(ag, dir);
  if (forbiddenMcpServer(name, cat[name]))
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
  applySandbox(ag, agentRuntime(role, ag, dir), dir);
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
  role: AgentRole = "brain",
): McpChangeResult {
  const ag = forAgent ?? getAgent(role);
  const a = loadActive(ag.name, dir);
  if (!a.includes(name)) return { ok: false, changed: false, text: `「${name}」当前未激活。` };
  const next = a.filter((x) => x !== name);
  saveActive(next, ag.name, dir);
  applySandbox(ag, agentRuntime(role, ag, dir), dir);
  return {
    ok: true,
    changed: true,
    text: `已卸载 MCP「${name}」。当前激活：${next.join(", ") || "（空）"}`,
  };
}

export function listMcp(dir: string = DATA_DIR): string {
  const ag = getAgent("brain");
  const avail = catalogNames(ag, dir);
  const cat = loadCatalog(ag, dir);
  const disabled = overlayDisableSet(readOverlay(ag.name, dir).overlay);
  const raw = loadActive(ag.name, dir);
  // 已激活但「当前不可用」的条目不静默丢掉：可能是配置被删、被禁用，或定义已变成微信 MCP。
  const missing = raw.filter((n) => !cat[n]).filter((n) => !disabled.has(normalizeMcpName(n)));
  const active = raw.filter(
    (n) => cat[n] && !disabled.has(normalizeMcpName(n)) && !forbiddenMcpServer(n, cat[n]),
  );
  const lines = [
    `可选 MCP：${avail.join(", ") || "（无）"}`,
    `已激活：${active.join(", ") || "（空，默认不加载）"}`,
  ];
  if (missing.length) lines.push(`缺少定义（保留在激活集）：${missing.join(", ")}`);
  const blocked = raw.filter(
    (n) => !missing.includes(n) && !active.includes(n) && !disabled.has(normalizeMcpName(n)),
  );
  if (blocked.length) lines.push(`已忽略（微信/不可用）：${blocked.join(", ")}`);
  return lines.join("\n");
}
