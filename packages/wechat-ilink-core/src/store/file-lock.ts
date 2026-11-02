import fs from "node:fs";
import path from "node:path";

/**
 * 同步的跨进程文件锁：保护「读-改-写」型 JSON 文件（账号注册表、登录者白名单）。
 * 原子写只保证单次写入不撕裂，不能串行两个进程的「先读旧值再写回」——后写者会用旧快照覆盖前一个。
 * 锁文件用 `wx` 原子创建；持有者崩溃留下的陈旧锁（默认 >10s）自动清理；等不到就报错让用户重试，**不**退化成无锁写。
 */
export type FileLockOptions = {
  /** 等锁上限（毫秒）。 */
  waitMs?: number;
  /** 超过这个年龄的锁视为持有者已崩溃。 */
  staleMs?: number;
  /** 报错时的主语，例如「账号注册表」。 */
  subject?: string;
};

/** Atomics.wait 同步等待，不占 CPU，也不引入异步时序。 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* ignore */
  }
}

export function withFileLock<T>(lockFile: string, fn: () => T, opts: FileLockOptions = {}): T {
  const waitMs = opts.waitMs ?? 5000;
  const staleMs = opts.staleMs ?? 10_000;
  const subject = opts.subject ?? lockFile;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
        try {
          fs.unlinkSync(lockFile);
        } catch {
          /* ignore */
        }
      }
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST")
        throw e instanceof Error ? e : new Error(String(e));
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {
        continue; // 锁刚被释放：立即重试
      }
      if (Date.now() >= deadline)
        throw new Error(
          `${subject}正被另一个 wimind 进程修改（锁文件 ${lockFile}）；请稍后重试。若确认没有其它 wimind 在跑，可删除该锁文件。`,
        );
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockFile);
    } catch {
      /* 已被清理：忽略 */
    }
  }
}
