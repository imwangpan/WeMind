import fs from "node:fs";
import path from "node:path";

import { DATA_DIR, createLogger } from "@wemind/wechat-ilink-core";

import type { AgentRole } from "../brain-config.js";
import type { ResolvedAgent } from "../brain-agents.js";
import { readHomeMode, type HomeMode } from "./home-mode.js";
import { readOverlay, type AgentOverlay } from "./overlay.js";
import { ensureWorkspace } from "./workspace.js";

const log = createLogger("wechat-daemon/config");

/**
 * 一次 Agent 启动所需的全部路径。
 *
 * - `direct`：`home` / `configDir` 都是 Agent 的真实配置目录；WeMind 不注入 homeEnvVar，也不写任何文件。
 * - `managed`：`home` 是账号副本根，`configDir` 是它下面的 Agent 配置子目录。
 *
 * `cwd` 是 ACP session 的工作目录，`mediaDir` 是入站媒体落点；三者刻意分开。
 */
export type AgentRuntime = {
  role: AgentRole;
  mode: HomeMode;
  home: string;
  configDir: string;
  cwd: string;
  mediaDir: string;
  overlay: AgentOverlay;
};

export function managedRoot(role: AgentRole, dir: string = DATA_DIR): string {
  const env =
    role === "brain"
      ? process.env.WECHAT_BRAIN_HOME?.trim()
      : process.env.WEMIND_WORKER_HOME?.trim();
  return env || path.join(dir, role === "brain" ? "brain-home" : "worker-home");
}

/** 媒体目录是纯路径计算，不在每次收到附件时做任何 IO。 */
export function mediaDirFor(role: AgentRole, mode: HomeMode, dir: string = DATA_DIR): string {
  if (mode === "managed") return path.join(managedRoot(role, dir), "media", "inbound");
  return path.join(dir, "media", "inbound");
}

/** 同一进程里同一 agent 的 overlay 告警只打一次，避免长跑 daemon 每轮刷屏。 */
const warnedOverlay = new Set<string>();

function resolveCwd(role: AgentRole, dir: string, requested?: string): string {
  if (role === "worker" && requested?.trim()) {
    const cwd = path.resolve(requested.trim());
    try {
      if (!fs.statSync(cwd).isDirectory()) throw new Error("不是目录");
    } catch (e) {
      throw new Error(
        `任务工作目录不可用：${cwd}（${e instanceof Error ? e.message : String(e)}）`,
      );
    }
    return cwd;
  }
  const ws = ensureWorkspace(role, dir);
  if (ws.problem) throw new Error(`工作区不可用（${role}）：${ws.problem}`);
  return ws.path;
}

export function agentRuntime(
  role: AgentRole,
  ag: ResolvedAgent,
  dir: string = DATA_DIR,
  opts: { cwd?: string } = {},
): AgentRuntime {
  const mode = readHomeMode(dir);
  const cwd = resolveCwd(role, dir, opts.cwd);
  const read = readOverlay(ag.name, dir);
  if (read.problems.length && !warnedOverlay.has(ag.name)) {
    warnedOverlay.add(ag.name);
    log.warn(`微信侧 overlay 无效（${ag.name}）：${read.problems.join("；")}（坏键已忽略）`);
  }
  if (mode === "managed") {
    const home = managedRoot(role, dir);
    return {
      role,
      mode,
      home,
      configDir: path.join(home, ag.configSubdir),
      cwd,
      mediaDir: mediaDirFor(role, mode, dir),
      overlay: read.overlay,
    };
  }
  const home = ag.realHome ?? "";
  return {
    role,
    mode: "direct",
    home,
    configDir: home,
    cwd,
    mediaDir: mediaDirFor(role, "direct", dir),
    overlay: read.overlay,
  };
}
