import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

import { writeJsonAtomic } from "../../shared/io/atomic-json.js";

/**
 * homeMode：Agent 的配置/会话/记忆从哪里读。
 *
 * - `view`（默认）：以真实配置为基线生成最小视图，WeMind 只覆盖必须覆盖的文件（MCP/权限/overlay）。
 * - `direct`：不生成视图，Agent 直接使用完整真实配置；WeMind 不写任何 Agent 配置。
 * - `sandbox`：完整复制到账号目录，与真实配置隔离。
 *
 * 旧值 `real` / `mirror` 都映射到 `view`（写入时只写新值）。
 */
export type HomeMode = "view" | "direct" | "sandbox";

export type HomeModeConfig = {
  version: 1;
  homeMode: HomeMode;
};

export function homeModePath(dir: string = DATA_DIR): string {
  return path.join(dir, "runtime.json");
}

export function normalizeHomeMode(value: unknown): HomeMode | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "view" || v === "real" || v === "mirror") return "view";
  return v === "direct" || v === "sandbox" ? v : null;
}

/** 读账号级 homeMode；环境变量 `WEMIND_HOME_MODE` 是一次性覆盖，缺失/损坏回落 `view`。 */
export function readHomeMode(dir: string = DATA_DIR): HomeMode {
  const env = normalizeHomeMode(process.env.WEMIND_HOME_MODE);
  if (env) return env;
  try {
    const j = JSON.parse(fs.readFileSync(homeModePath(dir), "utf-8")) as Partial<HomeModeConfig>;
    return normalizeHomeMode(j?.homeMode) ?? "view";
  } catch {
    return "view";
  }
}

export function writeHomeMode(mode: HomeMode, dir: string = DATA_DIR): void {
  writeJsonAtomic(homeModePath(dir), { version: 1, homeMode: mode } satisfies HomeModeConfig);
}

export function homeModeDescription(mode: HomeMode): string {
  if (mode === "sandbox") return "sandbox（完整复制到账号目录，与真实配置隔离）";
  if (mode === "direct")
    return "direct（直读：不生成视图，Agent 使用完整真实配置；WeMind 不改 MCP/overlay/权限）";
  return "view（默认：生成最小配置视图，技能/记忆/会话继承真实目录；MCP/overlay/权限由 WeMind 管理）";
}
