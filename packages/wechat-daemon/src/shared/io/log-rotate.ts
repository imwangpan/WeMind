/**
 * daemon.log 轮转与保留。
 *
 * 三个常驻 runner 都把 stdout/stderr 写进账号目录的 `daemon.log`；此前没有任何轮转，
 * 长期运行（或崩溃循环被 `WEMIND_MAX_RESTARTS` 拦下之前）会把日志无限撑大。
 * 这里提供一套不依赖外部模块的轮转：`daemon.log` → `daemon.log.1`（最新）… `daemon.log.<keep>`。
 *
 * 轮转只能用 `appendFileSync` 这种「每次打开→写→关闭」的写法：Windows 上无法重命名一个
 * 仍被写入进程持有的文件。内置 watchdog 因此把子进程 stdout/stderr 接成管道，由它逐块追加，
 * 轮转时文件没有打开句柄；`scripts/run-daemon.ps1 -Mode shell` 则在每次重拉前（子进程已退出）轮转。
 */
import { createLogger } from "@wemind/wechat-ilink-core";
import fs from "node:fs";
const log = createLogger("wechat-daemon/wrapper");

export type LogLimits = { maxBytes: number; keep: number };

/** 默认单文件上限 10MB；保留 3 份（`.1` 最新，`.3` 最旧）。 */
export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_KEEP = 3;

/** 读 `WEMIND_LOG_MAX_MB` / `WEMIND_LOG_KEEP`；非法值回落默认，keep=0 表示轮转时直接删掉旧文件（不留历史）。 */
export function logLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): LogLimits {
  const mb = Number(env.WEMIND_LOG_MAX_MB);
  const maxBytes =
    Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : DEFAULT_LOG_MAX_BYTES;
  const keepRaw = Number(env.WEMIND_LOG_KEEP);
  const keep = Number.isInteger(keepRaw) && keepRaw >= 0 ? keepRaw : DEFAULT_LOG_KEEP;
  return { maxBytes, keep };
}

/**
 * 文件达到上限就轮转；返回是否真的轮转过。文件不存在/还小返回 false。
 * 先删最旧的 `.keep`，再把 `.keep-1 → .keep` … `.1 → .2`、`daemon.log → .1` 依次改名；
 * 任何一步失败（权限/文件被占用）向上抛，由调用方决定记日志还是放弃。
 */
export function rotateLogFile(file: string, limits: LogLimits): boolean {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false; // 还没写过日志
  }
  if (size < limits.maxBytes) return false;
  const keep = Math.max(0, Math.floor(limits.keep));
  if (keep === 0) {
    fs.rmSync(file, { force: true });
    return true;
  }
  fs.rmSync(`${file}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) {
    try {
      fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  fs.renameSync(file, `${file}.1`);
  return true;
}

/**
 * 逐块追加并自动轮转。内置 watchdog 用它接管子进程的 stdout/stderr：
 * 写文件不用持久的 fd，因此 Windows 上也能在子进程运行期间改名。
 */
export class RotatingLog {
  private bytes = 0;

  constructor(
    private readonly file: string,
    private readonly limits: LogLimits,
  ) {
    try {
      this.bytes = fs.statSync(file).size;
    } catch {
      this.bytes = 0;
    }
    this.rotateIfNeeded();
  }

  /** 追加一块输出；写失败只记到 stderr（不能因为日志问题拖垮 watchdog 的重拉循环）。 */
  write(chunk: string | Buffer): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    try {
      fs.appendFileSync(this.file, buf);
      this.bytes += buf.length;
    } catch (e) {
      log.warn("写 daemon.log 失败：", String(e));
      return;
    }
    this.rotateIfNeeded();
  }

  writeLine(text: string): void {
    this.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  private rotateIfNeeded(): void {
    if (this.bytes < this.limits.maxBytes) return;
    try {
      if (!rotateLogFile(this.file, this.limits)) return;
    } catch (e) {
      // 轮转失败不致命：继续往当前文件追加，下次写满再试。
      log.warn("daemon.log 轮转失败：", String(e));
      return;
    }
    this.bytes = 0;
    // 轮转标记直接追加，不经过 write()：否则 maxBytes 极小时会「写完标记立刻再轮转」无限递归。
    try {
      // 轮转标记由 RotatingLog 自己直接 append（不经过 logger），格式与 wrapperLine/createLogger 对齐，保证 daemon.log 每行都有级别标记。
      const marker = `[wemind/wechat-daemon/wrapper][INFO] daemon.log 达到 ${Math.round(this.limits.maxBytes / 1024 / 1024)}MB，已轮转（保留 ${this.limits.keep} 份）\n`;
      fs.appendFileSync(this.file, marker);
      this.bytes += Buffer.byteLength(marker);
    } catch {
      /* 标记写失败不影响轮转本身 */
    }
  }
}
