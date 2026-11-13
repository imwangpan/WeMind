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
  stripWechatFromConfigCopy,
  syncCredentials,
  syncProfilePatch,
  warnUnwritableRealHome,
  writeSettingsBase,
} from "./sandbox-common.js";
import { syncInherited } from "./sandbox-inherit.js";
import { writeJsonAtomic } from "../../shared/io/atomic-json.js";
import { agentRuntime, sandboxRoot, type AgentRuntime } from "../config/runtime.js";
import {
  overlayDisableSet,
  overlayExtraServers,
  readOverlay,
  writeOverlay,
} from "../config/overlay.js";
const log = createLogger("wechat-daemon/mcp");

/**
 * brain 的 MCP 策略：
 * - `direct`（默认）：Agent 直接加载自己的完整真实配置，WeMind 不写文件、不改 MCP；
 *   只有用户显式配置的 `overlay.mcp.extra` 会经 ACP 补进会话（且仅 `acpMcpServers` 的 Agent），**不重发 catalog**。
 * - `sandbox`：从真实目录复制出账号沙箱，MCP 只用「激活集」（默认空，对话中按需加载）；
 *   `mcpDelivery: "acp"` 的 Agent 随会话下发，其余 Agent 写沙箱配置文件。
 *
 * 格式知识集中在 `mcp-adapters.ts` 的 `McpAdapter`（顶层 JSON / 嵌套 JSON / TOML / DSH profile YAML），
 * 这里只算激活集、排除集与投递方式，不再按 agent 名或格式分支。
 *
 * agent 不再存成模块常量：每个函数显式收 `ag`，或在入口用 `getAgent("brain")` 取一次当前大脑。
 */

/** sandbox 模式的 brain 沙箱根目录。 */
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
 * 让 sandbox 继承所用 agent 真实配置目录的「知识/记忆/技能」：
 * - 目录式（inheritDirs）用目录 junction（Windows）/ symlink 指向真实目录；
 * - 单文件式（inheritFiles）直接拷入配置目录。
 * **MCP 与会话不照搬**：MCP 必须走沙箱的激活集（排除 wechat，防它把消息发回自己）。
 */
function linkRealKnowledge(ag: ResolvedAgent, rt: AgentRuntime): void {
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
  try {
    return mcpAdapterFor(ag).readCatalog(file);
  } catch {
    return {};
  }
}

/** 启动检查要看的文件（存在才查）：sandbox 看副本，direct 看真实文件。 */
function nativeScanFiles(ag: ResolvedAgent, rt?: AgentRuntime): string[] {
  const out = new Set<string>();
  const base = rt?.mode === "sandbox" ? rt.configDir : ag.realHome;
  if (ag.realProfile && base) {
    for (const name of ["cordis.patch.yml", "cordis.yml"]) {
      out.add(path.join(base, "profiles", ag.realProfile, name));
    }
  }
  if (ag.catalogFile && base) {
    out.add(path.resolve(base, ag.catalogFile));
  }
  if (ag.mcpDelivery !== "acp" && ag.realHome) out.add(mcpCatalogPath(ag));
  if (ag.mcpDelivery !== "acp" && ag.settingsBase && base) {
    out.add(path.join(base, ag.settingsBase));
  }
  for (const extra of ag.extraConfigFiles ?? []) out.add(extra);
  return [...out];
}

/**
 * 启动前提示：agent 自己会加载的配置里有微信 MCP。
 *
 * 只告警、不阻止启动——用户明确要求完全按终端配置运行。同一个 bot token 被两个程序长轮询时
 * 会互相抢消息/回环，所以日志必须写清风险。
 */
export function warnForbiddenNativeMcp(ag: ResolvedAgent, rt?: AgentRuntime): void {
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
        const text = fs.readFileSync(file, "utf-8");
        if (ag.mcpFormat === "dshProfileYaml") {
          for (const [name, def] of Object.entries(mcpAdapterFor(ag).readCatalog(file))) {
            if (forbiddenMcpServer(name, def)) bad.push(`${name}（${file}）`);
          }
        } else {
          const { removed } = stripWechatMcpEntries(text);
          for (const name of removed) bad.push(`${name}（${file}）`);
        }
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
    log.warn(
      `agent 自己的配置文件里有微信 MCP（${bad.join(", ")}）：WeMind 不会替它剥离，也不会阻止启动；` +
        `同一条微信消息可能被两个程序抢/回环，请自行删除这些条目。`,
    );
  }
  if (problems.length) {
    log.warn(
      `无法完整检查 agent 自己的配置（${problems.join("；")}）：按用户配置继续启动，风险由用户承担。`,
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

/** 按激活集从 catalog 取定义，写入沙箱 MCP 配置（默认空）。保留配置里其它键（如 opencode 的 model）。 */
function applySandbox(ag: ResolvedAgent, rt?: AgentRuntime, dir: string = DATA_DIR): void {
  if (ag.mcpDelivery === "acp") return;
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
}

/** overlay 里「微信独享」的额外 MCP（direct 下唯一由 WeMind 下发的集合）。 */
export function overlayExtraAcpServers(
  ag: ResolvedAgent = getAgent("brain"),
  dir: string = DATA_DIR,
) {
  if (!ag.acpMcpServers) return [];
  const overlay = readOverlay(ag.name, dir).overlay;
  const extra = overlayExtraServers(overlay);
  const disabled = overlayDisableSet(overlay);
  const picked: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(extra)) {
    if (disabled.has(normalizeMcpName(name)) || forbiddenMcpServer(name, def)) continue;
    picked[name] = def;
  }
  if (!Object.keys(picked).length) return [];
  const { servers, skipped } = mcpAdapterFor(ag).toAcp(picked);
  if (skipped.length) log.warn(`跳过无法转换的 MCP：${skipped.join(", ")}`);
  return servers;
}

/**
 * brain 当前应挂载的 ACP mcpServers。
 * - `direct`：**不重发** Agent 已经原生加载的 catalog，只下发 overlay.mcp.extra（微信独享项）；
 * - `sandbox`：curated 激活集（默认空），并排除微信 MCP。
 * 跳过不可转换的坏条目并记日志——官方 DSH 的 session/new 遇到起不来的 MCP 会回滚整个会话。
 */
export function activeMcpServers(
  ag: ResolvedAgent = getAgent("brain"),
  rt?: AgentRuntime,
  dir: string = DATA_DIR,
) {
  if (rt?.mode === "direct") return overlayExtraAcpServers(ag, dir);
  if (ag.mcpDelivery !== "acp") return [];
  const cat = loadCatalog(ag, dir);
  const disabled = overlayDisableSet(readOverlay(ag.name, dir).overlay);
  const picked: Record<string, unknown> = {};
  for (const n of loadActive(ag.name, dir)) {
    if (!cat[n] || disabled.has(normalizeMcpName(n))) continue;
    if (forbiddenMcpServer(n, cat[n])) continue;
    picked[n] = cat[n];
  }
  const { servers, skipped } = mcpAdapterFor(ag).toAcp(picked);
  if (skipped.length) log.warn(`跳过无法转换的 MCP：${skipped.join(", ")}`);
  return servers;
}

/** 按适配器继承该 Agent 的「非 MCP」设置（kiro 的 settings/*；opencode 的 model 等同文件设置）。 */
function syncFormatSettings(ag: ResolvedAgent, rt: AgentRuntime): void {
  const adapter = mcpAdapterFor(ag);
  if (!adapter.inheritSettings || !ag.realHome) return;
  adapter.inheritSettings(ag, ag.realHome, brainConfigDir(ag, rt));
}

/** 继承真实配置目录的「非 MCP」设置（模型/免确认等）；MCP 段保持沙箱权威。 */
function syncSettings(ag: ResolvedAgent, rt: AgentRuntime): void {
  if (rt.mode === "sandbox") syncProfilePatch(ag, rt.home, "大脑");
  if (ag.mcpDelivery === "acp") return;
  if (ag.settingsBase && ag.realHome) {
    if (!canWriteAgentConfig(ag, rt)) {
      warnUnwritableRealHome(ag, "基础设置（settings）");
      return;
    }
    writeSettingsBase(ag, brainConfigDir(ag, rt));
    return;
  }
  if (!ag.inherit || !ag.realHome) return;
  if (!canWriteAgentConfig(ag, rt)) return;
  syncFormatSettings(ag, rt);
}

/**
 * 启动前准备：direct 原样返回（不写任何文件）；sandbox 才同步设置、MCP、技能/记忆与凭据。
 * `forAgent` 可显式指定 agent（切换流程启动新大脑用，此刻槽位还指着旧大脑）。
 */
export function ensureBrainHome(forAgent?: ResolvedAgent, dir: string = DATA_DIR): AgentRuntime {
  const ag = forAgent ?? getAgent("brain");
  const rt = agentRuntime("brain", ag, dir);
  if (rt.mode === "direct") return rt;
  syncSettings(ag, rt);
  linkRealKnowledge(ag, rt);
  syncCredentials(ag, brainConfigDir(ag, rt));
  stripWechatFromConfigCopy(ag, rt);
  applySandbox(ag, rt, dir);
  applySettingsDefaults(ag, brainConfigDir(ag, rt));
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
  const rt = agentRuntime(role, ag, dir);
  if (rt.mode === "direct")
    return {
      ok: false,
      changed: false,
      text:
        `当前是 direct 模式：MCP 完全由 ${ag.name} 自己的配置决定，WeMind 不写文件、也不维护激活集。` +
        `微信里发「加载/卸载」会原样转给 Agent；CLI 没有 Agent 回合，请直接改 Agent 配置（改完重启 daemon 生效）。`,
    };
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
  if (ag.mcpDelivery === "acp" && !mcpAdapterFor(ag).toAcp({ [name]: cat[name] }).servers.length)
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
  applySandbox(ag, rt, dir);
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
  const rt = agentRuntime(role, ag, dir);
  if (rt.mode === "direct")
    return {
      ok: false,
      changed: false,
      text:
        `当前是 direct 模式：MCP 完全由 ${ag.name} 自己的配置决定，WeMind 不写文件、也不维护激活集。` +
        `微信里发「加载/卸载」会原样转给 Agent；CLI 没有 Agent 回合，请直接改 Agent 配置（改完重启 daemon 生效）。`,
    };
  const a = loadActive(ag.name, dir);
  if (!a.includes(name)) return { ok: false, changed: false, text: `「${name}」当前未激活。` };
  const next = a.filter((x) => x !== name);
  saveActive(next, ag.name, dir);
  applySandbox(ag, rt, dir);
  return {
    ok: true,
    changed: true,
    text: `已卸载 MCP「${name}」。当前激活：${next.join(", ") || "（空）"}`,
  };
}

export function listMcp(dir: string = DATA_DIR): string {
  const ag = getAgent("brain");
  // 只用于提示 direct 模式；工作区异常时不应让「列出 MCP」整体失败，按非 direct 继续展示目录。
  let direct = false;
  try {
    direct = agentRuntime("brain", ag, dir).mode === "direct";
  } catch {
    direct = false;
  }
  const avail = catalogNames(ag, dir);
  const cat = loadCatalog(ag, dir);
  const disabled = overlayDisableSet(readOverlay(ag.name, dir).overlay);
  const raw = loadActive(ag.name, dir);
  // 已激活但「当前不可用」的条目不静默丢掉：可能是配置被删、被禁用，或定义已变成微信 MCP。
  const missing = raw.filter((n) => !cat[n]).filter((n) => !disabled.has(normalizeMcpName(n)));
  const active = raw.filter(
    (n) => cat[n] && !disabled.has(normalizeMcpName(n)) && !forbiddenMcpServer(n, cat[n]),
  );
  const lines = direct
    ? [
        "当前是 direct 模式：MCP 由 Agent 真实配置决定，下面的激活集仅在 sandbox 生效。",
        `Agent 配置里的 MCP：${avail.join(", ") || "（无）"}`,
      ]
    : [
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
