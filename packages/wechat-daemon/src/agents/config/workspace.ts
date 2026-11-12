import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

import { writeJsonAtomic } from "../../shared/io/atomic-json.js";
import { ACP_AGENT_PRESETS } from "../brain-presets.js";

export type AgentRole = "brain" | "worker";
export type WorkspaceMode = "managed" | "external";

export type WorkspaceEntry = {
  mode: WorkspaceMode;
  /** managed 可省略（按账号目录计算）；external 必须是绝对路径。 */
  path?: string;
};

export type WorkspaceConfig = {
  version: 1;
  brain: WorkspaceEntry;
  worker: WorkspaceEntry;
};

export type ResolvedWorkspace = {
  mode: WorkspaceMode;
  path: string;
  /** 非空表示配置有问题；调用方应报错，不要静默换目录。 */
  problem?: string;
};

export function workspaceConfigPath(dir: string = DATA_DIR): string {
  return path.join(dir, "workspace.json");
}

export function defaultWorkspacePath(role: AgentRole, dir: string = DATA_DIR): string {
  return path.join(dir, "workspace", role);
}

function emptyConfig(): WorkspaceConfig {
  return {
    version: 1,
    brain: { mode: "managed" },
    worker: { mode: "managed" },
  };
}

function normEntry(raw: unknown): WorkspaceEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const j = raw as Record<string, unknown>;
  const mode = j.mode === "external" ? "external" : j.mode === "managed" ? "managed" : null;
  if (!mode) return null;
  const p = typeof j.path === "string" && j.path.trim() ? j.path.trim() : undefined;
  return p ? { mode, path: p } : { mode };
}

/** 读 workspace.json；缺文件/损坏回落默认 managed（损坏只影响本次读取，不覆盖用户文件）。 */
export function loadWorkspaceConfig(dir: string = DATA_DIR): {
  config: WorkspaceConfig;
  problem?: string;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(workspaceConfigPath(dir), "utf-8"));
  } catch {
    return { config: emptyConfig() };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { config: emptyConfig(), problem: "workspace.json 不是对象，已按默认工作区处理" };
  }
  const j = raw as Record<string, unknown>;
  const brain = normEntry(j.brain);
  const worker = normEntry(j.worker);
  if (!brain || !worker) {
    return {
      config: emptyConfig(),
      problem: "workspace.json 的 brain/worker 段无效，已按默认工作区处理",
    };
  }
  const config: WorkspaceConfig = { version: 1, brain, worker };
  if (brain.mode === "external" && !brain.path)
    return { config, problem: "workspace.brain 是 external 但缺少 path" };
  if (worker.mode === "external" && !worker.path)
    return { config, problem: "workspace.worker 是 external 但缺少 path" };
  return { config };
}

export function saveWorkspaceConfig(config: WorkspaceConfig, dir: string = DATA_DIR): void {
  writeJsonAtomic(workspaceConfigPath(dir), config);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isNetworkPath(p: string): boolean {
  if (process.platform !== "win32") return false;
  return p.startsWith("\\\\") || p.startsWith("//");
}

function systemDangerRoots(): string[] {
  if (process.platform === "win32") {
    return [
      process.env.SystemRoot,
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.ProgramData,
    ].filter((p): p is string => !!p?.trim());
  }
  return ["/etc", "/usr", "/bin", "/sbin", "/var", "/opt", "/dev", "/proc", "/sys", "/boot"];
}

/**
 * 校验工作区：绝对路径、存在且是目录、不是系统/账号/Agent 配置目录、不是家目录根。
 * `external` 必须已经存在；`managed` 由 ensure 创建。
 */
export function validateWorkspacePath(
  raw: string,
  role: AgentRole,
  dir: string = DATA_DIR,
): string | null {
  if (!path.isAbsolute(raw)) return "工作区必须是绝对路径";
  if (isNetworkPath(raw)) return "工作区不能是 UNC/网络路径";
  let real: string;
  try {
    real = fs.realpathSync(raw);
  } catch {
    return "工作区不存在，或当前用户无法访问";
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch {
    return "工作区无法读取";
  }
  if (!st.isDirectory()) return "工作区不是目录";
  const account = path.resolve(dir);
  const forbiddenExact = new Set(
    [
      path.resolve(account),
      path.join(account, "brain-home"),
      path.join(account, "worker-home"),
      path.join(account, "agent-view"),
      path.join(account, "agent-overrides"),
      path.join(account, "media"),
      path.join(account, "agent-sessions"),
      path.resolve(os.homedir()),
      path.parse(real).root,
    ].map((p) => path.resolve(p)),
  );
  const forbiddenRoots = new Set(
    [
      path.resolve(account),
      path.join(account, "brain-home"),
      path.join(account, "worker-home"),
      path.join(account, "agent-view"),
      path.join(account, "agent-overrides"),
      path.join(account, "media"),
      path.join(account, "agent-sessions"),
    ].map((p) => path.resolve(p)),
  );
  for (const p of systemDangerRoots()) {
    forbiddenExact.add(path.resolve(p));
    forbiddenRoots.add(path.resolve(p));
  }
  for (const preset of Object.values(ACP_AGENT_PRESETS)) {
    if (preset.realHome) {
      forbiddenExact.add(path.resolve(preset.realHome));
      forbiddenRoots.add(path.resolve(preset.realHome));
    }
  }
  if (forbiddenExact.has(real)) return "工作区不能是账号目录、Agent 配置目录、家目录根或系统目录";
  for (const p of forbiddenRoots) {
    if (isInside(real, p) && real !== p) {
      return "工作区不能位于账号数据、Agent 真实配置目录或系统目录内";
    }
  }
  return null;
}

/** 解析某角色的工作区；external 先校验再返回，managed 只计算路径。 */
export function resolveWorkspace(role: AgentRole, dir: string = DATA_DIR): ResolvedWorkspace {
  const { config, problem } = loadWorkspaceConfig(dir);
  const entry = config[role];
  if (entry.mode === "managed") {
    return {
      mode: "managed",
      path: defaultWorkspacePath(role, dir),
      ...(problem ? { problem } : {}),
    };
  }
  if (!entry.path) return { mode: "external", path: "", problem: `workspace.${role} 缺少 path` };
  const invalid = validateWorkspacePath(entry.path, role, dir);
  return {
    mode: "external",
    path: path.resolve(entry.path),
    ...(invalid || problem ? { problem: invalid ?? problem } : {}),
  };
}

/** 确保 managed 工作区存在；external 只校验，不自动创建。问题通过返回值交给调用方报错。 */
export function ensureWorkspace(role: AgentRole, dir: string = DATA_DIR): ResolvedWorkspace {
  const ws = resolveWorkspace(role, dir);
  if (ws.problem) return ws;
  try {
    fs.mkdirSync(ws.path, { recursive: true, mode: 0o700 });
  } catch (e) {
    return { ...ws, problem: `无法创建工作区：${e instanceof Error ? e.message : String(e)}` };
  }
  return ws;
}

/** `set`/`reset` 都走这里：null = 恢复 managed 默认。 */
export function updateWorkspace(
  role: AgentRole,
  value: string | null,
  dir: string = DATA_DIR,
): WorkspaceConfig {
  const { config } = loadWorkspaceConfig(dir);
  if (value === null) {
    config[role] = { mode: "managed" };
  } else {
    const invalid = validateWorkspacePath(value, role, dir);
    if (invalid) throw new Error(invalid);
    config[role] = { mode: "external", path: path.resolve(value) };
  }
  saveWorkspaceConfig(config, dir);
  return config;
}

export const WORKSPACE_CHANGE_NOTICE = "默认工作区已更新；已有会话保持原 cwd，新会话才会生效。";
