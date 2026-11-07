import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { WEMIND_ROOT } from "@wemind/wechat-ilink-core";

/**
 * PM2 探测与「一次性提示」标记。
 *
 * 自启安装用这里的 `detectPM2()` 决定走 PM2 还是系统原生触发器；
 * 提示标记写在 `<根>/.pm2-persistence-configured`，只用来避免反复提醒 `pm2 startup`，
 * 与版本无关——用户按提示执行过一次就不再打扰。
 */

export interface PM2Status {
  available: boolean;
  version?: string;
}

/** 从 `pm2 --version` 的结果解析，纯函数便于单测。 */
export function parsePM2Version(status: number | null, stdout: string): PM2Status {
  const version = (stdout || "").trim();
  if (status === 0 && /^\d+\.\d+\.\d+/.test(version)) return { available: true, version };
  return { available: false };
}

/** 检测 PM2 是否已安装。Windows 下 pm2 是 `.cmd`，必须经 shell；且不能同时传 args 数组（DEP0190），故用整条命令字符串。 */
export function detectPM2(): PM2Status {
  try {
    const r =
      process.platform === "win32"
        ? spawnSync("pm2 --version", {
            encoding: "utf8",
            timeout: 5000,
            windowsHide: true,
            shell: true,
          })
        : spawnSync("pm2", ["--version"], { encoding: "utf8", timeout: 5000 });
    return parsePM2Version(r.status, r.stdout ?? "");
  } catch {
    return { available: false };
  }
}

/** PM2 实例名：用 key（稳定、无特殊字符），不用 label（可含中文/空格）。 */
export function getPM2InstanceName(key: string): string {
  return `wemind-${key}`;
}

/** 标记文件路径；参数仅用于测试注入临时根目录。 */
export function persistenceMarkerPath(root: string = WEMIND_ROOT): string {
  return path.join(root, ".pm2-persistence-configured");
}

/** 是否已经提示过 `pm2 startup` / `pm2 save`。 */
export function isPersistenceConfigured(root?: string): boolean {
  try {
    return fs.existsSync(persistenceMarkerPath(root));
  } catch {
    return false;
  }
}

/** 记录「已提示过」，下次不再重复。 */
export function markPersistenceConfigured(root?: string): void {
  try {
    const file = persistenceMarkerPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, new Date().toISOString(), "utf-8");
  } catch {
    /* best-effort：标记写不进去不能让安装失败 */
  }
}
