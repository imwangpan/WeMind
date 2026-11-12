import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

import { writeJsonAtomic } from "../../shared/io/atomic-json.js";

/**
 * homeMode：Agent 的配置/会话/记忆从哪里读。
 *
 * `real` 是默认值，但“real”不等于“把真实文件原样交给 Agent”：brain 的 MCP 默认空、`wechat` 必须排除、
 * yolo 可能只能靠配置文件开启，这些硬覆盖需要最小 config view。模式只决定“主目录来源”，不决定是否覆盖。
 */
export type HomeMode = "real" | "mirror" | "sandbox";

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
  return v === "real" || v === "mirror" || v === "sandbox" ? v : null;
}

/** 读账号级 homeMode；环境变量 `WEMIND_HOME_MODE` 是一次性覆盖，缺失/损坏回落 `real`。 */
export function readHomeMode(dir: string = DATA_DIR): HomeMode {
  const env = normalizeHomeMode(process.env.WEMIND_HOME_MODE);
  if (env) return env;
  try {
    const j = JSON.parse(fs.readFileSync(homeModePath(dir), "utf-8")) as Partial<HomeModeConfig>;
    return normalizeHomeMode(j?.homeMode) ?? "real";
  } catch {
    return "real";
  }
}

export function writeHomeMode(mode: HomeMode, dir: string = DATA_DIR): void {
  writeJsonAtomic(homeModePath(dir), { version: 1, homeMode: mode } satisfies HomeModeConfig);
}

export function homeModeDescription(mode: HomeMode): string {
  if (mode === "sandbox") return "sandbox（完整复制到账号目录，与真实配置隔离）";
  if (mode === "mirror") return "mirror（以真实配置为基线，生成必要视图并做合并）";
  return "real（真实配置/技能/记忆/会话为主，必要时生成最小视图）";
}
