import fs from "node:fs";
import path from "node:path";

import { createLogger, DATA_DIR } from "@wemind/wechat-ilink-core";

import { readHomeMode } from "./home-mode.js";

const log = createLogger("wechat-daemon/migrate");

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function moveMedia(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  let names: string[] = [];
  try {
    names = fs.readdirSync(src);
  } catch {
    return;
  }
  for (const name of names) {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    if (fs.existsSync(to)) continue;
    try {
      fs.renameSync(from, to);
    } catch {
      try {
        fs.copyFileSync(from, to);
        fs.rmSync(from, { force: true });
      } catch {
        /* best-effort：搬不走的留在原目录，备份里仍有一份 */
      }
    }
  }
}

/**
 * 老账号从“沙箱优先”迁到默认 direct：只做尽力迁移 + 备份，不碰真实 Agent home。
 * 沙箱模式（显式选择或测试）不动；`WECHAT_BRAIN_HOME` / `WEMIND_WORKER_HOME` 显式覆盖也不动。
 */
export function migrateLegacySandbox(dir: string = DATA_DIR): void {
  if (readHomeMode(dir) === "sandbox") return;
  const brainHome = path.join(dir, "brain-home");
  const workerHome = path.join(dir, "worker-home");
  const media = path.join(dir, "media", "inbound");
  if (!process.env.WECHAT_BRAIN_HOME?.trim() && fs.existsSync(brainHome))
    moveMedia(path.join(brainHome, "media", "inbound"), media);
  const suffix = `.bak-${stamp()}`;
  for (const [src, label, env] of [
    [brainHome, "brain-home", process.env.WECHAT_BRAIN_HOME],
    [workerHome, "worker-home", process.env.WEMIND_WORKER_HOME],
  ] as const) {
    if (env?.trim() || !fs.existsSync(src)) continue;
    const dst = `${src}${suffix}`;
    try {
      fs.renameSync(src, dst);
      log.info(`legacy ${label} → ${dst}（已备份；direct 模式不再使用）`);
    } catch (e) {
      log.warn(`无法备份 legacy ${label}：${String(e)}（保留原目录）`);
    }
  }
}
