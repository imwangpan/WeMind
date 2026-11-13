import path from "node:path";

import { createLogger, DATA_DIR } from "@wemind/wechat-ilink-core";
import { ensureKiroV3Permissions, type ResolvedAgent } from "../brain-agents.js";
import { getAgent } from "../agent-slot.js";
import { isWechatMcpServer, normalizeMcpName } from "./agent-mcp.js";
import { mcpAdapterFor, mcpAdapterForFile, mcpCatalogPath, mcpConfigPath } from "./mcp-adapters.js";
import {
  applySettingsDefaults,
  canWriteAgentConfig,
  sanitizeView,
  syncCredentials,
  syncProfilePatch,
  warnOverlayProblems,
  warnUnwritableRealHome,
  writeSettingsBase,
} from "./sandbox-common.js";
import { syncInherited } from "./sandbox-inherit.js";
import { agentRuntime, type AgentRuntime } from "../config/runtime.js";
import { markGenerated } from "../config/config-view.js";
import { overlayDisableSet, overlayExtraServers, readOverlay } from "../config/overlay.js";
const log = createLogger("wechat-daemon/mcp");

/**
 * worker 配置视图/沙箱：与 brain（mcp-sandbox.ts）并列，但 MCP 策略相反。
 *
 * worker 是无人值守的任务执行机，默认**继承真实配置目录的全部 MCP**（仅排除 wechat，防它把消息发回自己），而非 brain 的「默认空 + 对话中按需加载」——因为没人在旁边逐个加载工具，任务需要开箱即用的完整能力。
 * `view` 下技能/记忆/会话链接真实 home；`direct` 直接用完整真实配置、不写任何文件；`sandbox` 模式才用 linkRealKnowledge/syncSettings 复制继承。
 *
 * 按 agent 适配（同 mcp-sandbox.ts）：配置目录、MCP 格式、设置继承方式均随 agent 而变。
 * agent 不再存成模块常量：函数显式收 `ag`，入口用 `getAgent("worker")`（默认任务大脑）。
 *
 * 设计依据：docs/方案C-MVP-远程human-in-the-loop.md §8.4。
 * MCP 格式与设置继承走 `mcp-adapters.ts`；凭据/默认设置/overlay 与 brain 共用 `sandbox-common.ts`。
 */

/** sandbox 模式的 worker 沙箱根（显式回退；view/direct 用 agentRuntime().home）。 */
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

/** worker 继承全量 MCP：复制 catalog 全部 server，去掉排除集与 disabled:true 的。
 *  配了 `mcpViaAcp` 的 agent（DSH）不写文件——全量集合经 workerMcpServers() 转成 ACP mcpServers 随 session 下发。 */
function applyWorkerSandbox(ag: ResolvedAgent, rt?: AgentRuntime, dir: string = DATA_DIR): void {
  if (ag.mcpViaAcp) return;
  // 复用调用方的 rt：重算会重建视图，把刚应用的 overlay 覆盖回真实值。
  const target = rt ?? agentRuntime("worker", ag, dir);
  if (target.mode === "direct") {
    warnUnwritableRealHome(ag, "worker MCP 配置");
    return;
  }
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
  if (rt?.view) markGenerated(rt.view, file);
}

/** worker 当前应挂载的 ACP mcpServers（配了 mcpViaAcp 的 agent 用）：全量 catalog（除排除集/disabled/坏条目）→ ACP 声明。 */
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

/** 按适配器继承该 Agent 的「非 MCP」设置（kiro 的 settings/*；opencode 的 model 等同文件设置）。 */
function syncFormatSettings(ag: ResolvedAgent, rt: AgentRuntime): void {
  const adapter = mcpAdapterFor(ag);
  if (!adapter.inheritSettings || !ag.realHome) return;
  if (!canWriteAgentConfig(ag, rt)) return;
  adapter.inheritSettings(ag, ag.realHome, workerConfigDir(ag, rt));
  if (adapter.rebuildSettingsInView && rt.view) markGenerated(rt.view, workerMcpJson(ag, rt));
}

function syncSettings(ag: ResolvedAgent, rt: AgentRuntime): void {
  if (rt.mode === "sandbox") syncProfilePatch(ag, rt.home, "worker"); // DSH 等：继承真实 profile 用户层（provider 目录 / 默认模型）；MCP 仍走 ACP 注入
  if (ag.mcpViaAcp) return; // 无「配置文件式」的 MCP/settings 可继承（模型走 set_config_option）
  if (ag.settingsBase && ag.realHome) {
    if (!canWriteAgentConfig(ag, rt)) {
      warnUnwritableRealHome(ag, "worker 基础设置（settings）");
      return;
    }
    writeSettingsBase(ag, workerConfigDir(ag, rt), rt.view); // 不依赖 inherit：视图/沙箱硬化（关自动更新）与隔离始终生效
    return;
  }
  if (!ag.inherit || !ag.realHome) return;
  if (!canWriteAgentConfig(ag, rt)) return;
  if (rt.mode !== "sandbox" && !mcpAdapterFor(ag).rebuildSettingsInView) return; // view 的普通设置由 config view 链接真实文件
  syncFormatSettings(ag, rt);
}

/** 用 junction/symlink 把真实配置目录的记忆/技能/规则类子目录链入 worker 配置目录；单文件记忆直接拷。逻辑同 brain（共用 `sandbox-inherit.ts`）。 */
function linkRealKnowledge(ag: ResolvedAgent, rt: AgentRuntime): void {
  syncInherited(rt.home, workerConfigDir(ag, rt), ag);
}

/**
 * 确保 worker 配置视图/沙箱就绪：继承 settings（除 mcp）→ 写全量 MCP（除排除集）→ 预设默认设置项；链入记忆/技能与凭据同步仅 sandbox 执行（view 的视图整目录链接真实配置）。
 * daemon 启动时按默认任务大脑调用一次；**每次派发新 worker 前**（`worker-pool.ts` 的 `acquire`）再按**这条任务的 agent** 调一次——
 * 否则派到非默认 agent（如 `--agent pi`）时，它自己的 settings/凭据/MCP 还没进视图/沙箱，agent 会拿空配置跑。
 * `forAgent` 可显式指定 agent（此刻槽位可能指着别的默认）。
 */
export function ensureWorkerHome(
  forAgent?: ResolvedAgent,
  dir: string = DATA_DIR,
  opts: { cwd?: string } = {},
): AgentRuntime {
  const ag = forAgent ?? getAgent("worker");
  const rt = agentRuntime("worker", ag, dir, opts);
  // direct：不生成视图、不写 MCP/设置/overlay/权限；Agent 完全按自己的真实配置启动。
  if (rt.mode === "direct") return rt;
  syncSettings(ag, rt); // 先同步「非 MCP」设置（模型/免确认等）
  warnOverlayProblems(ag, rt);
  sanitizeView(ag, rt); // 视图副本里剔除微信 MCP（DSH profile / Copilot 原生配置等）
  applyWorkerSandbox(ag, rt, dir); // 再写全量 MCP（除 wechat 等排除集）
  if (rt.mode === "sandbox") {
    linkRealKnowledge(ag, rt); // 链入记忆/steering/skills（sessions 仍隔离）
    syncCredentials(ag, workerConfigDir(ag, rt)); // 凭据（如 DSH 的 .credentials.yaml、Qoder 的 .auth/*）
  }
  applySettingsDefaults(ag, workerConfigDir(ag, rt), rt.view); // 预设默认设置项（如 pi 的 quietStartup：关掉 pi-acp 当消息发出来的启动信息）
  // kiro v3 的免审批在 settings/permissions.yaml；view 下该文件已在
  // config-view 里被强制生成副本，不会穿透 junction 写到真实 ~/.kiro。
  if (ag.kiroV3 && canWriteAgentConfig(ag, rt))
    ensureKiroV3Permissions(ag, path.join(rt.configDir, "settings"));
  return rt;
}
