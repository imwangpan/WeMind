// 自带后台守护进程（方案 b）：`wemind start --runner builtin` 用它常驻，不依赖 pm2。
// - runWatchdog：后台守护进程循环本体（由 `cli.js _watchdog` 调用），单实例守卫 + 循环 spawn daemon、崩溃 5s 重拉。
// - watchdogStart：从 manage 脱离式启动后台守护进程。
// 单实例用 wrapper.pid + isOurProcess() 身份校验（不只看 pid 存活，防重启后 pid 复用误判）；竞态由「start 前先 stop」进一步压低。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, accountDir } from "@wemind/wechat-ilink-core";
import { BRAIN_CONFIG_EXIT_CODE } from "../agents/brain-agents.js";
import { stripVscodeDebugEnv } from "../shared/debug-env.js";
import { launcherEnv, stableExecPath } from "../shared/launcher-env.js";
import { logLimitsFromEnv, RotatingLog } from "../shared/io/log-rotate.js";
import { CLI_PID_MARKERS, otherOurProcessPid } from "../shared/process/proc-identity.js";

const RESTART_DELAY_MS = 5000;
/** 连续崩溃上限（与 pm2 的默认 max_restarts 对齐）：只统计「短暂运行就崩」的连续次数。 */
const DEFAULT_MAX_RESTARTS = 50;
/** daemon 跑满这么久视为稳定，连续崩溃计数清零（避免几个月里偶发崩溃累积到上限后不再重拉）。 */
const RESTART_STABLE_MS = 10 * 60 * 1000;

/**
 * 连续崩溃计数：`prev` 是上一次的计数，`ranMs` 是这次 daemon 活了多久。
 * 跑满稳定期就清零；超过上限返回 stop=true——后台守护进程应停止重拉，等人看日志，而不是无限刷。
 */
export function nextRestartBudget(
  prev: number,
  ranMs: number,
  max: number = DEFAULT_MAX_RESTARTS,
): { crashes: number; stop: boolean } {
  const base = ranMs >= RESTART_STABLE_MS ? 0 : prev;
  const crashes = base + 1;
  return { crashes, stop: crashes > max };
}
/**
 * daemon 发现同账号已有另一个实例在跑时用它退出。
 * 这不是配置错误，重拉无益——另一个实例已经在消费同一个 bot token；后台守护进程/pm2 都应停止重拉。
 */
export const DAEMON_ALREADY_RUNNING_EXIT_CODE = 75;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readPidFile(file: string): number | null {
  try {
    const n = Number.parseInt(fs.readFileSync(file, "utf-8").trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 单实例守卫：已有存活**且确认是我们**的后台守护进程返回 false；否则写自己 pid、返回 true。 */
function acquireSingleton(wrapperPidFile: string): boolean {
  const old = readPidFile(wrapperPidFile);
  // 身份校验：陈旧 pid + 重启后 pid 复用时会误判「已有实例」→ 后台守护进程直接退出、daemon 静默不起。
  if (otherOurProcessPid(old, process.pid, CLI_PID_MARKERS)) return false;
  fs.writeFileSync(wrapperPidFile, String(process.pid), "ascii");
  return true;
}

/** 后台守护进程循环本体（由 `cli.js _watchdog` 调用，常驻）：单实例守卫 → 循环拉起 daemon、退出 5s 重拉。 */

/** watchdog 自己的日志不走 console（stderr 被 ignore），但格式与 createLogger 保持一致，保证 daemon.log 每行都有级别标记。 */
function wrapperLine(level: "INFO" | "WARN" | "ERROR", text: string): string {
  return `[wemind/wechat-daemon/wrapper][${level}] ${text}`;
}

export async function runWatchdog(): Promise<void> {
  const dataDir = DATA_DIR; // 本进程已设 WECHAT_ACCOUNT，core 据此解析到账号目录
  fs.mkdirSync(dataDir, { recursive: true });
  const log = path.join(dataDir, "daemon.log");
  const wrapperPidFile = path.join(dataDir, "wrapper.pid");

  if (!acquireSingleton(wrapperPidFile)) {
    fs.appendFileSync(
      log,
      wrapperLine("WARN", `已有实例在跑，本次退出。${new Date().toISOString()}`) + "\n",
    );
    return;
  }
  // 拿到单实例后才碰日志轮转：另一个实例可能正在写，不能去改名它的文件。
  // 子进程 stdout/stderr 走管道、由 RotatingLog 逐块追加——Windows 上运行中也能轮转（文件没有常驻句柄）。
  const rotator = new RotatingLog(log, logLimitsFromEnv());
  const cleanup = () => {
    try {
      if (readPidFile(wrapperPidFile) === process.pid) fs.unlinkSync(wrapperPidFile);
    } catch {
      /* ignore */
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  // 当前 cli.js 与 node 的稳定路径：wrapper 可能由 fnm 的临时 shell 联接启动，
  // 若这个 shell 已退出，直接拿 process.execPath / argv[1] 的联接路径重拉会失败。
  const nodePath = stableExecPath(process.execPath);
  const cliPath = stableExecPath(process.argv[1] ?? "");
  const maxRestarts =
    Number(process.env.WEMIND_MAX_RESTARTS) > 0
      ? Number(process.env.WEMIND_MAX_RESTARTS)
      : DEFAULT_MAX_RESTARTS;
  let crashes = 0;
  for (;;) {
    const startedAt = Date.now();
    rotator.writeLine(wrapperLine("INFO", `start daemon ${new Date().toISOString()}`));
    const child: ChildProcess = spawn(nodePath, [cliPath, "daemon"], {
      // WECHAT_ACCOUNT 已在本进程环境中；同时摘掉 VS Code 终端注入的调试引导（后台守护进程若本身被注入过，daemon 不能再被带坏，见 debug-env.ts）
      env: stripVscodeDebugEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"], // stdout/stderr 由 rotator 合并进 daemon.log（可轮转）
      windowsHide: true, // 不弹出控制台窗口（Windows）：日志已重定向到 daemon.log，无需可见窗口
    });
    child.stdout?.on("data", (chunk: Buffer) => rotator.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => rotator.write(chunk));
    const code = await new Promise<number>((resolve) => {
      let exitCode = -1;
      child.on("exit", (c) => {
        exitCode = c ?? -1;
      });
      // close 在 stdio 全部关闭后触发：先收完最后一块输出，再写「daemon exited」，否则末尾日志可能丢。
      child.on("close", () => resolve(exitCode));
      child.on("error", () => resolve(-1));
    });
    if (code === DAEMON_ALREADY_RUNNING_EXIT_CODE) {
      // 同账号已有另一个 daemon 在消费同一个 bot token：本后台守护进程再拉只会每 5s 撞一次，停在这里。
      rotator.writeLine(
        wrapperLine(
          "WARN",
          `同账号已有 daemon 在跑（exit ${code}），本后台守护进程退出。${new Date().toISOString()}`,
        ),
      );
      return;
    }
    if (code === BRAIN_CONFIG_EXIT_CODE) {
      // 大脑配置错误：重拉无益（需人工修），停在后台守护进程循环外，避免每 5s 刷一条。
      rotator.writeLine(
        wrapperLine(
          "ERROR",
          `大脑配置错误（exit ${code}），已停止自动重启。修好后执行：wemind start <账号>`,
        ),
      );
      return;
    }
    const plan = nextRestartBudget(crashes, Date.now() - startedAt, maxRestarts);
    crashes = plan.crashes;
    if (plan.stop) {
      rotator.writeLine(
        wrapperLine(
          "ERROR",
          `连续崩溃 ${crashes} 次（上限 ${maxRestarts}），已停止自动重启。看 daemon.log 排查；修好后执行：wemind start <账号>${new Date().toISOString()}`,
        ),
      );
      return;
    }
    rotator.writeLine(
      wrapperLine(
        "WARN",
        `daemon exited (code=${code}), restart in 5s ${new Date().toISOString()}`,
      ),
    );
    await sleep(RESTART_DELAY_MS);
  }
}

/** 从 manage 脱离式启动某账号的后台守护进程（方案 b：builtin runner）。 */
export function watchdogStart(key: string, cliPath: string): { ok: boolean; msg: string } {
  // 先解析到稳定路径：fnm 的 fnm_multishells 联接会在 shell 退出后消失，之后 wrapper 重拉 daemon 就找不到 node 了。
  const child = spawn(stableExecPath(process.execPath), [stableExecPath(cliPath), "_watchdog"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    // 脱离出的后台守护进程拿不到 VS Code 的调试器，带着 bootloader 注入会被「等调试器」卡死 → 摘掉（见 debug-env.ts）
    // 同时应用 launcherEnv()：丢弃 WECHAT_DATA_DIR 污染，强制按 key 寻址（P0 Bug Fix）
    env: stripVscodeDebugEnv(launcherEnv(key)),
  });
  child.unref();
  return {
    ok: true,
    msg: `已启动自带后台守护进程（账号 ${key}，pid ${child.pid}）。日志：${path.join(accountDir(key), "daemon.log")}`,
  };
}
