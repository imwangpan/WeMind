import { spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * 结束 ACP 子进程并主动断掉三路 stdio。
 *
 * ACP agent 常会再拉起脱离进程树的孙进程；只杀直接子进程时，孙进程继承的管道会让 CLI
 * 成功打印后仍不退出。这里统一 taskkill 进程树（Windows）/ SIGKILL（POSIX），随后 destroy
 * 三路管道并 unref。调用方仍应只调用一次。
 */
export function disposeAgentProcess(
  proc: Pick<
    ChildProcessWithoutNullStreams,
    "pid" | "kill" | "stdin" | "stdout" | "stderr" | "unref"
  >,
): void {
  let killed = false;
  try {
    if (process.platform === "win32" && proc.pid) {
      const result = spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killed = result.status === 0;
    } else {
      proc.kill("SIGKILL");
      killed = true;
    }
  } catch {
    /* 已退出 / 无权限：继续关管道 */
  }
  if (!killed) {
    // taskkill 失败或测试替身没有 pid 时，再给 Node 的 kill 一次机会。
    try {
      proc.kill();
    } catch {
      /* 已退出：继续关管道 */
    }
  }
  for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
    try {
      stream.destroy();
    } catch {
      /* ignore */
    }
  }
  try {
    proc.unref();
  } catch {
    /* ignore */
  }
}
