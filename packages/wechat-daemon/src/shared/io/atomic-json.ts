import fs from "node:fs";
import path from "node:path";

/**
 * 原子写 JSON：同目录唯一临时文件 → rename 覆盖。
 *
 * 为什么不用固定 `${file}.tmp`：brain.json / session-registry.json 这类文件会有多个写者（CLI 与 daemon、
 * 升级旧版与新版的边界），共用一个临时文件名时两个进程可以互相覆盖对方写到一半的内容——rename 虽是原子的，
 * 但「写 tmp」这一步不是。唯一后缀（pid + 时间 + 随机）保证每个写者各写各的，rename 到同一个目标仍原子。
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2) + "\n");
}

/** 原子写任意文本：同目录唯一临时文件 → rename 覆盖（写 YAML/TOML 副本用）。 */
export function writeFileAtomic(filePath: string, data: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, data, "utf-8");
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
    throw e;
  }
}
