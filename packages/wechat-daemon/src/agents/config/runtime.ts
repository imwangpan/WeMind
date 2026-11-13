import fs from "node:fs";
import path from "node:path";

import { DATA_DIR, createLogger } from "@wemind/wechat-ilink-core";

import type { AgentRole } from "../brain-config.js";
import type { ResolvedAgent } from "../brain-agents.js";
import { buildConfigView, type ConfigView } from "./config-view.js";
import { readHomeMode, type HomeMode } from "./home-mode.js";
import {
  overlayKeyProblems,
  overlayPath,
  overlayPathProblems,
  readOverlay,
  type AgentOverlay,
} from "./overlay.js";
import { ensureWorkspace } from "./workspace.js";

const log = createLogger("wechat-daemon/config");

/** 读 overlay 并剔除「会让 daemon 起不来」的键：坏键只告警 + 忽略，不让一个手滑的 overlay 变成 watchdog 重启循环。 */
function loadOverlay(
  ag: ResolvedAgent,
  dir: string,
): { overlay: AgentOverlay; problems: string[] } {
  const read = readOverlay(ag.name, dir);
  const problems = [...read.problems];
  const config = { ...read.overlay.config };
  const extras = (ag.extraConfigFiles ?? []).map((x) => x.source);
  for (const key of Object.keys(config)) {
    const bad = overlayKeyProblems(
      ag.realHome,
      { version: 1, config: { [key]: config[key] } },
      extras,
    );
    if (!bad.length) continue;
    delete config[key];
    problems.push(...bad);
  }
  problems.push(...overlayPathProblems(ag.realHome, read.overlay, extras));
  const overlay: AgentOverlay = { ...read.overlay };
  if (Object.keys(config).length) overlay.config = config;
  else delete overlay.config;
  return { overlay, problems };
}

/**
 * 一次 Agent 启动所需的全部路径。
 *
 * `home` 是传给 homeEnvVar 的目录（view 是视图根，sandbox 是账号沙箱根，direct 不注入 homeEnvVar，取真实配置目录）；
 * `cwd` 是 ACP session 的工作目录；`mediaDir` 是入站媒体落点。三者刻意分开，避免旧实现把
 * “配置根 / 工作区 / 媒体目录”全绑在 BRAIN_HOME 上。
 */
export type AgentRuntime = {
  role: AgentRole;
  /** 本次实际生效的模式；`view` 建视图失败时可能是降级后的 `direct`。 */
  mode: HomeMode;
  /** 用户在 runtime.json / 环境变量里请求的模式（不因本次降级而改变）。 */
  requestedMode: HomeMode;
  /** `view` 降级为 `direct` 的原因；正常时为空。 */
  fallbackReason?: string;
  home: string;
  configDir: string;
  cwd: string;
  mediaDir: string;
  view?: ConfigView;
  overlay: AgentOverlay;
};

export function sandboxRoot(role: AgentRole, dir: string = DATA_DIR): string {
  const env =
    role === "brain"
      ? process.env.WECHAT_BRAIN_HOME?.trim()
      : process.env.WEMIND_WORKER_HOME?.trim();
  return env || path.join(dir, role === "brain" ? "brain-home" : "worker-home");
}

/** 媒体目录是纯路径计算，不在每次收到附件时重建视图。 */
export function mediaDirFor(role: AgentRole, mode: HomeMode, dir: string = DATA_DIR): string {
  if (mode === "sandbox") return path.join(sandboxRoot(role, dir), "media", "inbound");
  return path.join(dir, "media", "inbound");
}

/** 同一进程里同一 agent 的降级/忽略提示只打一次，避免长跑 daemon 每轮刷屏。 */
const warnedFallback = new Set<string>();
const warnedDirectOverlay = new Set<string>();
/** 本次进程内已确认建不出视图的 `<role>:<agent>` → 原因。降级后不再逐条消息重试，显式 reload 才重试。 */
const viewFallback = new Map<string, string>();

function runtimeKey(role: AgentRole, ag: ResolvedAgent): string {
  return `${role}:${ag.name}`;
}

/** 本次进程内该角色/agent 是否已从 view 降级为 direct；返回降级原因。 */
export function viewFallbackReason(role: AgentRole, ag: ResolvedAgent): string | undefined {
  return viewFallback.get(runtimeKey(role, ag));
}

/** 显式 reload 时调用：清掉降级缓存，让下一次启动重新尝试 view。 */
export function resetViewFallback(role?: AgentRole, agentName?: string): void {
  if (!role) {
    viewFallback.clear();
    return;
  }
  for (const key of viewFallback.keys()) {
    if (!key.startsWith(`${role}:`)) continue;
    if (agentName && key !== `${role}:${agentName}`) continue;
    viewFallback.delete(key);
  }
}

function warnOnce(seen: Set<string>, key: string, message: string): void {
  if (seen.has(key)) return;
  seen.add(key);
  log.warn(message);
}

function directRuntime(
  role: AgentRole,
  ag: ResolvedAgent,
  requestedMode: HomeMode,
  cwd: string,
  dir: string,
  fallbackReason?: string,
): AgentRuntime {
  const home = ag.realHome ?? "";
  return {
    role,
    mode: "direct",
    requestedMode,
    ...(fallbackReason ? { fallbackReason } : {}),
    home,
    configDir: home,
    cwd,
    mediaDir: mediaDirFor(role, "direct", dir),
    overlay: { version: 1 },
  };
}

export function agentRuntime(
  role: AgentRole,
  ag: ResolvedAgent,
  dir: string = DATA_DIR,
  opts: { cwd?: string } = {},
): AgentRuntime {
  const requestedMode = readHomeMode(dir);
  let cwd: string;
  if (role === "worker" && opts.cwd?.trim()) {
    cwd = path.resolve(opts.cwd.trim());
    try {
      if (!fs.statSync(cwd).isDirectory()) throw new Error("不是目录");
    } catch (e) {
      throw new Error(
        `任务工作目录不可用：${cwd}（${e instanceof Error ? e.message : String(e)}）`,
      );
    }
  } else {
    const ws = ensureWorkspace(role, dir);
    if (ws.problem) throw new Error(`工作区不可用（${role}）：${ws.problem}`);
    cwd = ws.path;
  }
  if (requestedMode === "sandbox") {
    const home = sandboxRoot(role, dir);
    const { overlay, problems } = loadOverlay(ag, dir);
    if (problems.length)
      log.warn(`微信侧 overlay 无效（${ag.name}）：${problems.join("；")}（坏键已忽略）`);
    return {
      role,
      mode: "sandbox",
      requestedMode,
      home,
      configDir: path.join(home, ag.configSubdir),
      cwd,
      mediaDir: mediaDirFor(role, "sandbox", dir),
      overlay,
    };
  }
  if (requestedMode === "direct") {
    const read = readOverlay(ag.name, dir);
    if (read.overlay.config || read.overlay.mcp)
      warnOnce(
        warnedDirectOverlay,
        ag.name,
        `direct 模式不应用微信侧 overlay（${ag.name}）：${overlayPath(ag.name, dir)} 会被忽略；要使用 overlay 请切回 view 或 sandbox`,
      );
    return directRuntime(role, ag, requestedMode, cwd, dir);
  }
  const cachedFallback = viewFallbackReason(role, ag);
  if (cachedFallback) return directRuntime(role, ag, requestedMode, cwd, dir, cachedFallback);
  const { overlay, problems } = loadOverlay(ag, dir);
  if (problems.length) {
    // 不静默忽略：坏 overlay 会让用户以为“微信侧配置生效了”，其实没有；但也绝不因此让 daemon 起不来。
    log.warn(`微信侧 overlay 无效（${ag.name}）：${problems.join("；")}（坏键已忽略）`);
  }
  // view 需要可重定向的配置目录，并且真实配置目录必须已经存在：
  // 缺失时让 Agent 先按 direct 在自己的真实 home 里初始化（登录/写默认配置），下次启动再建视图。
  const fallback = (reason: string): AgentRuntime => {
    viewFallback.set(runtimeKey(role, ag), reason);
    warnOnce(
      warnedFallback,
      `${ag.name}:${reason}`,
      `view 模式无法为 agent「${ag.name}」生成配置视图（${reason}）→ 本次按 direct 运行；不会改写真实配置，下次启动仍会重试 view`,
    );
    return directRuntime(role, ag, requestedMode, cwd, dir, reason);
  };
  if (!ag.homeEnvVar) return fallback("没有可重定向的配置目录环境变量");
  if (!ag.realHome) return fallback("没有真实配置目录");
  try {
    if (!fs.statSync(ag.realHome).isDirectory()) return fallback("真实配置目录不可用");
  } catch {
    return fallback("真实配置目录不存在");
  }
  let view: ConfigView;
  try {
    view = buildConfigView(role, ag, dir, overlay);
  } catch (e) {
    return fallback(`构建配置视图失败：${e instanceof Error ? e.message : String(e)}`);
  }
  viewFallback.delete(runtimeKey(role, ag));
  return {
    role,
    mode: "view",
    requestedMode,
    home: view.root,
    configDir: view.configDir,
    cwd,
    mediaDir: mediaDirFor(role, "view", dir),
    view,
    overlay,
  };
}
