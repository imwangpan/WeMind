import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "./account.js";

/**
 * 配对授权清单（allowFrom）：每账号一份持久化的「被授权用户 userId 清单」，
 * 取代单一 `WECHAT_OWNER_ID` 环境变量白名单。
 * 文件：`<账号数据目录>/allowFrom.json`，格式 `{ version, allowFrom: string[] }`（对齐官方 openclaw-weixin）。
 *
 * 配对(pairing)：扫码登录者的 userId 在归档时自动加入(见 manage finalize)；daemon 启动时也会把账号本人种入，
 * 故现有账号无需手动配置即可继续工作。鉴于大脑 `--trust-all-tools`，本清单是核心安全闸。
 *
 * 各函数可传入指定账号的数据目录 dir（默认当前进程 DATA_DIR），便于 manage 操作非当前账号。
 */

type AllowFromFile = { version: number; allowFrom: string[] };

function filePath(dir: string = DATA_DIR): string {
  return path.join(dir, "allowFrom.json");
}

export function readAllowFrom(dir: string = DATA_DIR): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath(dir), "utf-8");
  } catch {
    return []; // 不存在：正常（daemon 启动会种入本人）
  }
  try {
    const j = JSON.parse(raw) as AllowFromFile;
    return Array.isArray(j.allowFrom)
      ? j.allowFrom.filter((x): x is string => typeof x === "string" && !!x)
      : [];
  } catch (e) {
    // 存在但损坏：本清单是安全闸，损坏返回 [] 是 fail-closed（全员锁死），必须可见 → 记日志 + 备份坏文件
    console.error(`[allow-from] ${filePath(dir)} parse failed, backing up: ${String(e)}`);
    try {
      fs.renameSync(filePath(dir), `${filePath(dir)}.corrupt-${Date.now()}`);
    } catch {
      /* best-effort */
    }
    return [];
  }
}

/** 原子写：临时文件 + rename，避免写途崩溃/并发损坏这个安全闸文件。 */
function writeAllowFrom(list: string[], dir: string = DATA_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  const uniq = [...new Set(list.filter((x) => typeof x === "string" && !!x))];
  const fp = filePath(dir);
  const tmp = `${fp}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, allowFrom: uniq }, null, 2), "utf-8");
  fs.renameSync(tmp, fp);
}

/** 加入授权用户（去重）。返回更新后的清单。 */
export function addAllowFrom(userId: string, dir: string = DATA_DIR): string[] {
  const list = readAllowFrom(dir);
  if (userId && !list.includes(userId)) list.push(userId);
  writeAllowFrom(list, dir);
  return list;
}

/** 移除授权用户。返回更新后的清单。 */
export function removeAllowFrom(userId: string, dir: string = DATA_DIR): string[] {
  const list = readAllowFrom(dir).filter((x) => x !== userId);
  writeAllowFrom(list, dir);
  return list;
}

/** 该 userId 是否被授权。 */
export function isAllowed(userId: string, dir: string = DATA_DIR): boolean {
  return !!userId && readAllowFrom(dir).includes(userId);
}
