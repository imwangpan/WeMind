import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

import { writeJsonAtomic } from "../../shared/io/atomic-json.js";

/**
 * homeMode：Agent 的配置/会话/记忆从哪里读。
 *
 * - `direct`（默认）：Agent 直接使用完整真实配置；WeMind 在 daemon 启动/运行期不自动写 Agent 配置（显式 `wemind config agent ...` 例外）。
 * - `managed`：WeMind 在账号目录维护一份 Agent 配置副本（`brain-home` / `worker-home`），微信侧用这一份。
 */
export type HomeMode = "direct" | "managed";

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
  return v === "direct" || v === "managed" ? v : null;
}

/** 读账号级 homeMode；环境变量 `WEMIND_HOME_MODE` 是一次性覆盖，缺失/损坏/无法识别的取值回落 `direct`。 */
export function readHomeMode(dir: string = DATA_DIR): HomeMode {
  const env = normalizeHomeMode(process.env.WEMIND_HOME_MODE);
  if (env) return env;
  try {
    const j = JSON.parse(fs.readFileSync(homeModePath(dir), "utf-8")) as Partial<HomeModeConfig>;
    return normalizeHomeMode(j?.homeMode) ?? "direct";
  } catch {
    return "direct";
  }
}

export function writeHomeMode(mode: HomeMode, dir: string = DATA_DIR): void {
  writeJsonAtomic(homeModePath(dir), { version: 1, homeMode: mode } satisfies HomeModeConfig);
}

export function homeModeDescription(mode: HomeMode): string {
  if (mode === "managed")
    return "managed（WeMind 在账号目录维护 Agent 配置副本，微信侧用这一份；不是安全边界）";
  return "direct（默认：Agent 使用完整真实配置；WeMind 启动/运行期不自动写 Agent 配置（显式 config agent 例外），MCP/技能/记忆/权限与终端一致）";
}
