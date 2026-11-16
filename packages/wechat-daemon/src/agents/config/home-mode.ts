import fs from "node:fs";
import path from "node:path";

import { createLogger, DATA_DIR } from "@wemind/wechat-ilink-core";

import { writeJsonAtomic } from "../../shared/io/atomic-json.js";

/**
 * homeMode：Agent 的配置/会话/记忆从哪里读。
 *
 * - `direct`（默认）：Agent 直接使用完整真实配置；WeMind 在 daemon 启动/运行期不自动写 Agent 配置（显式 `wemind config agent ...` 例外）。
 * - `managed`：WeMind 在账号目录维护一份 Agent 配置副本（`brain-home` / `worker-home`），微信侧用这一份。
 */
export type HomeMode = "direct" | "managed";

/** 排队未消费的配置重载：进程内标志会随 daemon 退出消失，落盘让下次启动能发现并清掉。 */
export type ReloadMarker = { reason: string; at: number };

export type HomeModeConfig = {
  version: 1;
  homeMode: HomeMode;
  /** 仅由 acp-brain 的排队重启写入；新 daemon 启动按当前配置重建进程后清掉。 */
  pendingReload?: ReloadMarker;
};

const log = createLogger("wechat-daemon/home-mode");

export function homeModePath(dir: string = DATA_DIR): string {
  return path.join(dir, "runtime.json");
}

export function normalizeHomeMode(value: unknown): HomeMode | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return v === "direct" || v === "managed" ? v : null;
}

/** 读磁盘上的原始 runtime.json；不存在/损坏时返回空对象（不抛）。 */
function readConfig(dir: string): Partial<HomeModeConfig> {
  try {
    const j = JSON.parse(fs.readFileSync(homeModePath(dir), "utf-8")) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Partial<HomeModeConfig>) : {};
  } catch {
    return {};
  }
}

/** 只看磁盘上的持久值，不受 `WEMIND_HOME_MODE` 一次性覆盖影响；老账号迁移必须用这个。 */
export function readPersistedHomeMode(dir: string = DATA_DIR): HomeMode {
  return normalizeHomeMode(readConfig(dir).homeMode) ?? "direct";
}

/** 读账号级 homeMode；环境变量 `WEMIND_HOME_MODE` 是一次性覆盖，缺失/损坏/无法识别的取值回落 `direct`。 */
export function readHomeMode(dir: string = DATA_DIR): HomeMode {
  const env = normalizeHomeMode(process.env.WEMIND_HOME_MODE);
  if (env) return env;
  return readPersistedHomeMode(dir);
}

/** 写 homeMode；保留 runtime.json 里其它字段（如 pendingReload），避免把排队标记抹掉。 */
export function writeHomeMode(mode: HomeMode, dir: string = DATA_DIR): void {
  const prev = readConfig(dir);
  writeJsonAtomic(homeModePath(dir), { ...prev, version: 1 as const, homeMode: mode });
}

/** 读「上次退出前还排着队的重载」；没有/损坏返回 null。 */
export function readReloadMarker(dir: string = DATA_DIR): ReloadMarker | null {
  const m = readConfig(dir).pendingReload;
  return m && typeof m.reason === "string" && typeof m.at === "number" ? m : null;
}

/** 标记「配置已改，但 brain 重启排到回合结束」；写失败只记日志，内存标志仍是本轮权威。 */
export function markReloadPending(reason: string, dir: string = DATA_DIR): void {
  try {
    const prev = readConfig(dir);
    writeJsonAtomic(homeModePath(dir), {
      ...prev,
      version: 1 as const,
      homeMode: normalizeHomeMode(prev.homeMode) ?? "direct",
      pendingReload: { reason, at: Date.now() },
    });
  } catch (e) {
    log.warn(`落盘待重启标记失败：${String((e as Error)?.message ?? e)}`);
  }
}

/** 已生效（或新 daemon 按当前配置重建）后清标记；写失败只记日志，不拖垮回合。 */
export function clearReloadPending(dir: string = DATA_DIR): void {
  try {
    const prev = readConfig(dir);
    if (!prev.pendingReload) return;
    const next: Partial<HomeModeConfig> = {
      ...prev,
      version: 1 as const,
      homeMode: normalizeHomeMode(prev.homeMode) ?? "direct",
    };
    delete next.pendingReload;
    writeJsonAtomic(homeModePath(dir), next);
  } catch (e) {
    log.warn(`清掉待重启标记失败：${String((e as Error)?.message ?? e)}`);
  }
}

export function homeModeDescription(mode: HomeMode): string {
  if (mode === "managed")
    return "managed（WeMind 在账号目录维护 Agent 配置副本，微信侧用这一份；不是安全边界）";
  return "direct（默认：Agent 使用完整真实配置；WeMind 启动/运行期不自动写 Agent 配置（显式 config agent 例外），MCP/技能/记忆/权限与终端一致）";
}
