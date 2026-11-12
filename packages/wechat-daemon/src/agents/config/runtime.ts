import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

import type { AgentRole } from "../brain-config.js";
import type { ResolvedAgent } from "../brain-agents.js";
import { buildConfigView, type ConfigView } from "./config-view.js";
import { readHomeMode, type HomeMode } from "./home-mode.js";
import { overlayPathProblems, readOverlay, type AgentOverlay } from "./overlay.js";
import { ensureWorkspace } from "./workspace.js";

/**
 * 一次 Agent 启动所需的全部路径。
 *
 * `home` 是传给 homeEnvVar 的目录（real/mirror 是视图根，sandbox 是账号沙箱根）；
 * `cwd` 是 ACP session 的工作目录；`mediaDir` 是入站媒体落点。三者刻意分开，避免旧实现把
 * “配置根 / 工作区 / 媒体目录”全绑在 BRAIN_HOME 上。
 */
export type AgentRuntime = {
  role: AgentRole;
  mode: HomeMode;
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

export function agentRuntime(
  role: AgentRole,
  ag: ResolvedAgent,
  dir: string = DATA_DIR,
  opts: { cwd?: string } = {},
): AgentRuntime {
  const mode = readHomeMode(dir);
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
  if (mode === "sandbox") {
    const home = sandboxRoot(role, dir);
    const { overlay, problems } = readOverlay(ag.name, dir);
    problems.push(
      ...overlayPathProblems(
        ag.realHome,
        overlay,
        (ag.extraConfigFiles ?? []).map((x) => x.source),
      ),
    );
    if (problems.length)
      throw new Error(`微信侧 overlay 无效（${ag.name}）：${problems.join("；")}`);
    return {
      role,
      mode,
      home,
      configDir: path.join(home, ag.configSubdir),
      cwd,
      mediaDir: mediaDirFor(role, mode, dir),
      overlay,
    };
  }
  const { overlay, problems } = readOverlay(ag.name, dir);
  problems.push(
    ...overlayPathProblems(
      ag.realHome,
      overlay,
      (ag.extraConfigFiles ?? []).map((x) => x.source),
    ),
  );
  if (problems.length) {
    // 不静默忽略：坏 overlay 会让用户以为“微信侧配置生效了”，其实没有。
    throw new Error(`微信侧 overlay 无效（${ag.name}）：${problems.join("；")}`);
  }
  // 没有 homeEnvVar 的 agent（如 codex）无法把配置目录指到视图：直接用真实目录。
  // 这类 agent 的 overlay 配置不生效，但真实配置修改仍然有效；不要假装已经隔离。
  if (!ag.homeEnvVar && ag.realHome) {
    return {
      role,
      mode,
      home: ag.realHome,
      configDir: ag.realHome,
      cwd,
      mediaDir: mediaDirFor(role, mode, dir),
      overlay,
    };
  }
  const view = buildConfigView(role, ag, dir, overlay);
  return {
    role,
    mode,
    home: view.root,
    configDir: view.configDir,
    cwd,
    mediaDir: mediaDirFor(role, mode, dir),
    view,
    overlay,
  };
}
