// 自带看护进程（方案 b）：`wemind start --runner builtin` 用它常驻，不依赖 pm2。
// - runWatchdog：看护进程循环本体（由 `cli.js _watchdog` 调用），单实例守卫 + 循环 spawn daemon、崩溃 5s 重拉。
// - watchdogStart：从 manage 脱离式启动看护进程。
// 单实例用 wrapper.pid + isOurProcess() 身份校验（不只看 pid 存活，防重启后 pid 复用误判）；竞态由「start 前先 stop」进一步压低。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, accountDir } from "@wemind/wechat-ilink-core";
import { BRAIN_CONFIG_EXIT_CODE } from "./brain-agents.js";
import { stripVscodeDebugEnv } from "./debug-env.js";
import { CLI_PID_MARKERS, isOurProcess } from "./proc-identity.js";

const RESTART_DELAY_MS = 5000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readPidFile(file: string): number | null {
  try {
    const n = Number.parseInt(fs.readFileSync(file, "utf-8").trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 单实例守卫：已有存活**且确认是我们**的看护进程返回 false；否则写自己 pid、返回 true。 */
function acquireSingleton(wrapperPidFile: string): boolean {
  const old = readPidFile(wrapperPidFile);
  // 身份校验：陈旧 pid + 重启后 pid 复用时会误判「已有实例」→ 看护进程直接退出、daemon 静默不起。
  if (old && isOurProcess(old, CLI_PID_MARKERS)) return false;
  fs.writeFileSync(wrapperPidFile, String(process.pid), "ascii");
  return true;
}

/** 看护进程循环本体（由 `cli.js _watchdog` 调用，常驻）：单实例守卫 → 循环拉起 daemon、退出 5s 重拉。 */
export async function runWatchdog(): Promise<void> {
  const dataDir = DATA_DIR; // 本进程已设 WECHAT_ACCOUNT，core 据此解析到账号目录
  fs.mkdirSync(dataDir, { recursive: true });
  const log = path.join(dataDir, "daemon.log");
  const wrapperPidFile = path.join(dataDir, "wrapper.pid");

  if (!acquireSingleton(wrapperPidFile)) {
    fs.appendFileSync(
      log,
      `[wemind/wechat-daemon/wrapper] 已有实例在跑，本次退出。${new Date().toISOString()}\n`,
    );
    return;
  }
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

  const cliPath = process.argv[1]; // 当前 cli.js（本进程即 `node cli.js _watchdog`）
  for (;;) {
    fs.appendFileSync(
      log,
      `[wemind/wechat-daemon/wrapper] start daemon ${new Date().toISOString()}\n`,
    );
    const logFd = fs.openSync(log, "a");
    const child: ChildProcess = spawn(process.execPath, [cliPath, "daemon"], {
      // WECHAT_ACCOUNT 已在本进程环境中；同时摘掉 VS Code 终端注入的调试引导（看护进程若本身被注入过，daemon 不能再被带坏，见 debug-env.ts）
      env: stripVscodeDebugEnv(process.env),
      stdio: ["ignore", logFd, logFd], // stdout/stderr 都并入 daemon.log（与 run-daemon.ps1 一致）
      windowsHide: true, // 不弹出控制台窗口（Windows）：日志已重定向到 daemon.log，无需可见窗口
    });
    const code = await new Promise<number>((resolve) => {
      child.on("exit", (c) => resolve(c ?? -1));
      child.on("error", () => resolve(-1));
    });
    try {
      fs.closeSync(logFd);
    } catch {
      /* ignore */
    }
    if (code === BRAIN_CONFIG_EXIT_CODE) {
      // 大脑配置错误：重拉无益（需人工修），停在看护进程循环外，避免每 5s 刷一条。
      fs.appendFileSync(
        log,
        `[wemind/wechat-daemon/wrapper] 大脑配置错误（exit ${code}），已停止自动重启。修好后执行：wemind start <账号>\n`,
      );
      return;
    }
    fs.appendFileSync(
      log,
      `[wemind/wechat-daemon/wrapper] daemon exited (code=${code}), restart in 5s ${new Date().toISOString()}\n`,
    );
    await sleep(RESTART_DELAY_MS);
  }
}

/** 从 manage 脱离式启动某账号的看护进程（方案 b：builtin runner）。 */
export function watchdogStart(key: string, cliPath: string): { ok: boolean; msg: string } {
  const child = spawn(process.execPath, [cliPath, "_watchdog"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    // 脱离出的看护进程拿不到 VS Code 的调试器，带着 bootloader 注入会被「等调试器」卡死 → 摘掉（见 debug-env.ts）
    env: stripVscodeDebugEnv({ ...process.env, WECHAT_ACCOUNT: key }),
  });
  child.unref();
  return {
    ok: true,
    msg: `已启动自带看护进程（账号 ${key}，看护进程 pid ${child.pid}）。日志：${path.join(accountDir(key), "daemon.log")}`,
  };
}
