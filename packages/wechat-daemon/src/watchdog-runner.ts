// 自带看门狗（方案 b）：`wemind start --runner builtin` 用它常驻，不依赖 pm2。
// - runWatchdog：看门狗循环本体（由 `cli.js _watchdog` 调用），单实例守卫 + 循环 spawn daemon、崩溃 5s 重拉。
// - watchdogStart：从 manage 脱离式启动看门狗进程。
// 单实例用 wrapper.pid + 存活检查（零依赖、复用现有停止句柄）；竞态由「start 前先 stop」进一步压低。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, accountDir } from "@wemind/wechat-ilink-core";

const RESTART_DELAY_MS = 5000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(file: string): number | null {
  try {
    const n = Number.parseInt(fs.readFileSync(file, "utf-8").trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 单实例守卫：已有存活看门狗返回 false；否则写自己 pid、返回 true。 */
function acquireSingleton(wrapperPidFile: string): boolean {
  const old = readPidFile(wrapperPidFile);
  if (old && isAlive(old)) return false;
  fs.writeFileSync(wrapperPidFile, String(process.pid), "ascii");
  return true;
}

/** 看门狗循环本体（由 `cli.js _watchdog` 调用，常驻）：单实例守卫 → 循环拉起 daemon、退出 5s 重拉。 */
export async function runWatchdog(): Promise<void> {
  const dataDir = DATA_DIR; // 本进程已设 WECHAT_ACCOUNT，core 据此解析到账号目录
  fs.mkdirSync(dataDir, { recursive: true });
  const log = path.join(dataDir, "daemon.log");
  const wrapperPidFile = path.join(dataDir, "wrapper.pid");

  if (!acquireSingleton(wrapperPidFile)) {
    fs.appendFileSync(log, `[wrapper] 已有实例在跑，本次退出。${new Date().toISOString()}\n`);
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
    fs.appendFileSync(log, `[wrapper] start daemon ${new Date().toISOString()}\n`);
    const logFd = fs.openSync(log, "a");
    const child: ChildProcess = spawn(process.execPath, [cliPath, "daemon"], {
      env: process.env, // WECHAT_ACCOUNT 已在本进程环境中
      stdio: ["ignore", logFd, logFd], // stdout/stderr 都并入 daemon.log（与 run-daemon.ps1 一致）
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
    fs.appendFileSync(
      log,
      `[wrapper] daemon exited (code=${code}), restart in 5s ${new Date().toISOString()}\n`,
    );
    await sleep(RESTART_DELAY_MS);
  }
}

/** 从 manage 脱离式启动某账号的看门狗（方案 b：builtin runner）。 */
export function watchdogStart(key: string, cliPath: string): { ok: boolean; msg: string } {
  const child = spawn(process.execPath, [cliPath, "_watchdog"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, WECHAT_ACCOUNT: key },
  });
  child.unref();
  return {
    ok: true,
    msg: `已启动自带看门狗（账号 ${key}，看门狗 pid ${child.pid}）。日志：${path.join(accountDir(key), "daemon.log")}`,
  };
}
