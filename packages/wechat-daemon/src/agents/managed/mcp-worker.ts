import path from "node:path";

import { createLogger, DATA_DIR } from "@wemind/wechat-ilink-core";
import { ensureKiroV3Permissions, type ResolvedAgent } from "../brain-agents.js";
import { getAgent } from "../agent-slot.js";
import { isWechatMcpServer, normalizeMcpName } from "./agent-mcp.js";
import { mcpAdapterFor, mcpAdapterForFile, mcpCatalogPath, mcpConfigPath } from "./mcp-adapters.js";
import {
  applySettingsDefaults,
  canWriteAgentConfig,
  stripWechatFromConfigCopy,
  syncCredentials,
  syncProfilePatch,
  warnUnwritableRealHome,
  writeSettingsBase,
} from "./managed-common.js";
import { syncInherited } from "./inherit.js";
import { overlayExtraAcpServers } from "./mcp-brain.js";
import { agentRuntime, type AgentRuntime } from "../config/runtime.js";
import { overlayDisableSet, overlayExtraServers, readOverlay } from "../config/overlay.js";
const log = createLogger("wechat-daemon/mcp");

/**
 * worker 的 MCP 策略：与 brain 并列，但默认**继承全量 MCP**（仅排除 wechat，防它把消息发回自己），
 * 因为没人在旁边逐个加载工具，任务需要开箱即用的完整能力。
 *
 * - `direct`（默认）：Agent 用自己的完整真实配置，WeMind 不写任何文件；
 * - `managed`：完整复制到账号目录；全量集（除排除集）按 `mcpDelivery` 写进副本副本或随 ACP 会话下发。
 */

/** managed 模式的 worker 副本根。 */
export const WORKER_HOME =
  process.env.WEMIND_WORKER_HOME?.trim() || path.join(DATA_DIR, "worker-home");

/** 该 agent 的「配置目录」（kiro=home 根；opencode=<home>/opencode）。 */
function workerConfigDir(ag: ResolvedAgent, rt?: AgentRuntime): string {
  return rt ? rt.configDir : path.join(WORKER_HOME, ag.configSubdir);
}

function workerMcpJson(ag: ResolvedAgent, rt?: AgentRuntime): string {
  return mcpConfigPath(ag, workerConfigDir(ag, rt));
}

/** worker 不继承的 MCP：wechat 始终强制排除（防它把消息发回自己），外加 WEMIND_WORKER_MCP_EXCLUDE 指定的。 */
function excludeSet(): Set<string> {
  const raw = process.env.WEMIND_WORKER_MCP_EXCLUDE ?? "wechat";
  const s = new Set(
    raw
      .split(/[,\s]+/)
      .map((x) => normalizeMcpName(x))
      .filter(Boolean),
  );
  s.add("wechat"); // 强制：worker 加载 wechat 会用同一 bot token 长轮询、与 daemon 抢消息（坑①回环）
  return s;
}

function loadCatalog(ag: ResolvedAgent, dir: string = DATA_DIR): Record<string, unknown> {
  const file = mcpCatalogPath(ag);
  const base = mcpAdapterForFile(ag, file).readCatalog(file);
  const overlay = readOverlay(ag.name, dir).overlay;
  return { ...base, ...overlayExtraServers(overlay) };
}

/** worker 继承全量 MCP：复制 catalog 全部 server，去掉排除集与 disabled:true 的（managed 写文件）。 */
function applyWorkerCopy(ag: ResolvedAgent, rt?: AgentRuntime, dir: string = DATA_DIR): void {
  if (ag.mcpDelivery === "acp") return;
  const target = rt ?? agentRuntime("worker", ag, dir);
  if (!canWriteAgentConfig(ag, target)) {
    warnUnwritableRealHome(ag, "worker MCP 配置");
    return;
  }
  const cat = loadCatalog(ag, dir);
  const ex = excludeSet();
  const disabledSet = overlayDisableSet(readOverlay(ag.name, dir).overlay);
  const servers: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(cat)) {
    const norm = normalizeMcpName(name);
    if (ex.has(norm) || disabledSet.has(norm) || isWechatMcpServer(def)) continue; // 名字或定义命中微信 MCP 都排除（防改名绕开）
    if (def && typeof def === "object" && (def as { disabled?: unknown }).disabled === true)
      continue; // 跳过用户已禁用的
    servers[name] = def;
  }
  const file = workerMcpJson(ag, rt);
  mcpAdapterForFile(ag, file).writeCatalog(file, servers);
}

/** worker 当前应挂载的 ACP mcpServers（mcpDelivery=acp 的 agent 用）：全量 catalog（除排除集/disabled/坏条目）→ ACP 声明。 */
export function workerMcpServers(forAgent?: ResolvedAgent, dir: string = DATA_DIR) {
  const ag = forAgent ?? getAgent("worker");
  const cat = loadCatalog(ag, dir);
  const ex = excludeSet();
  const disabled = overlayDisableSet(readOverlay(ag.name, dir).overlay);
  const picked: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(cat)) {
    const norm = normalizeMcpName(name);
    if (ex.has(norm) || disabled.has(norm) || isWechatMcpServer(def)) continue;
    if (def && typeof def === "object" && (def as { disabled?: unknown }).disabled === true)
      continue;
    picked[name] = def;
  }
  const { servers, skipped } = mcpAdapterFor(ag).toAcp(picked, new Set<string>());
  if (skipped.length) log.warn(`worker 跳过无法转换的 MCP：${skipped.join(", ")}`);
  return servers;
}

/**
 * worker 建立/恢复会话时应随 ACP 下发的集合。
 * - `direct`：Agent 自己加载真实配置，只补 overlay.mcp.extra（微信独享项）；
 * - `managed`：mcpDelivery=acp 的 Agent 拿全量集（除 wechat），其余 Agent 自己读副本配置文件。
 */
export function workerSessionMcpServers(
  ag: ResolvedAgent = getAgent("worker"),
  rt?: AgentRuntime,
  dir: string = DATA_DIR,
) {
  if (!rt || rt.mode === "direct") return overlayExtraAcpServers(ag, dir);
  if (ag.mcpDelivery !== "acp") return [];
  return workerMcpServers(ag, dir);
}

/** 按适配器继承该 Agent 的「非 MCP」设置（kiro 的 settings/*；opencode 的 model 等同文件设置）。 */
function syncFormatSettings(ag: ResolvedAgent, rt: AgentRuntime): void {
  const adapter = mcpAdapterFor(ag);
  if (!adapter.inheritSettings || !ag.realHome) return;
  if (!canWriteAgentConfig(ag, rt)) return;
  adapter.inheritSettings(ag, ag.realHome, workerConfigDir(ag, rt));
}

function syncSettings(ag: ResolvedAgent, rt: AgentRuntime): void {
  syncProfilePatch(ag, rt.home, "worker"); // DSH 等：继承真实 profile 用户层（provider 目录 / 默认模型）；MCP 仍走 ACP 注入
  if (ag.mcpDelivery === "acp") return; // 无「配置文件式」的 MCP/settings 可继承（模型走 set_config_option）
  if (ag.settingsBase && ag.realHome) {
    if (!canWriteAgentConfig(ag, rt)) {
      warnUnwritableRealHome(ag, "worker 基础设置（settings）");
      return;
    }
    writeSettingsBase(ag, workerConfigDir(ag, rt));
    return;
  }
  if (!ag.inherit || !ag.realHome) return;
  if (!canWriteAgentConfig(ag, rt)) return;
  syncFormatSettings(ag, rt);
}

/** 用 junction/symlink 把真实配置目录的记忆/技能/规则类子目录链入 worker 配置目录；单文件记忆直接拷。 */
function linkRealKnowledge(ag: ResolvedAgent, rt: AgentRuntime): void {
  syncInherited(rt.home, workerConfigDir(ag, rt), ag);
}

/**
 * 确保 worker 配置就绪：
 * - `direct`：原样返回，不写任何文件；
 * - `managed`：继承 settings（除 mcp）→ 写全量 MCP（除排除集）→ 预设默认设置项 → 链入记忆/技能与凭据。
 * 每次派发新 worker 前（`worker-pool.ts` 的 `acquire`）按**这条任务的 agent** 调一次。
 */
export function ensureWorkerHome(
  forAgent?: ResolvedAgent,
  dir: string = DATA_DIR,
  opts: { cwd?: string } = {},
): AgentRuntime {
  const ag = forAgent ?? getAgent("worker");
  const rt = agentRuntime("worker", ag, dir, opts);
  if (rt.mode === "direct") return rt;
  syncSettings(ag, rt);
  stripWechatFromConfigCopy(ag, rt);
  applyWorkerCopy(ag, rt, dir);
  linkRealKnowledge(ag, rt);
  syncCredentials(ag, workerConfigDir(ag, rt));
  applySettingsDefaults(ag, workerConfigDir(ag, rt));
  if (ag.kiroV3 && canWriteAgentConfig(ag, rt))
    ensureKiroV3Permissions(ag, path.join(rt.configDir, "settings"));
  return rt;
}
