import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { print, accountDir } from "@wemind/wechat-ilink-core";
import { pm2Start, pm2Stop } from "./pm2-runner.js";
import { watchdogStart } from "./watchdog-runner.js";
import {
  CLI_PID_MARKERS,
  brainPidMarkers,
  commandLines,
  isAlive,
  matchesMarkers,
} from "../shared/process/proc-identity.js";
import { resolveAgent } from "../agents/brain-agents.js";
import { loadBrainConfig } from "../agents/brain-config.js";
import { readPid } from "./cli-context.js";
import { readPidRecords, recordMarkers } from "../shared/process/pid-record.js";
import { BRAIN_RUNTIME_FILE } from "../agents/brain-state.js";

/**
 * 账号 daemon 的进程生命周期：启停、身份校验、整棵进程树清理。
 * 从 manage.ts 拆出（2026-11-06）：命令分派与进程操作是两件事，后者被 stop/start 与账号命令共用。
 */

/**
 * 大脑进程的身份记录（`brain.pid` 现在是 JSON，见 pid-record.ts）：首条非 legacy 记录。
 * 记录里存的是**起进程时真实用的** bin/args —— 比「按当前配置猜」可靠：
 * `wemind brain set X` 之后、热切换窗口内、以及 brain≠worker 时，配置值都可能与实际在跑的进程不一致。
 * （导出仅供单测。）
 */
export function brainRecord(dir: string): {
  pid: number | null;
  markers: string[][] | null;
  agent: string;
} {
  const rec = readPidRecords(path.join(dir, "brain.pid"))[0];
  if (!rec) return { pid: null, markers: null, agent: "" };
  const markers = recordMarkers(rec);
  return { pid: rec.pid, markers: markers.length ? markers : null, agent: rec.agent };
}
/** 阻塞式 sleep（CLI 是同步流程；Atomics.wait 不占 CPU、不比 spawn 一个进程贵）。 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* ignore */
  }
}

/**
 * 某 pid 的全部后代（POSIX）。Windows 不需要——`taskkill /T` 自己会走进程树。
 * 用 `ps -A -o pid=,ppid=` 一次取全表再在内存里建树，比逐层 `pgrep -P` 少起进程。
 * （导出仅供单测；CLI 内部不对外。）
 */
export function descendantPids(pid: number): number[] {
  try {
    // procps（Linux）与 BSD/macOS 的 ps 都认 `-A`；个别精简环境（BusyBox）只有 `-e`，故兜底一次。
    const psArgs = [
      ["-A", "-o", "pid=,ppid="],
      ["-e", "-o", "pid=,ppid="],
    ];
    let stdout = "";
    for (const args of psArgs) {
      const r = spawnSync("ps", args, { encoding: "utf8", timeout: 5000 });
      if (r.status === 0 && r.stdout) {
        stdout = r.stdout;
        break;
      }
    }
    const childrenOf = new Map<number, number[]>();
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!m) continue;
      const child = Number(m[1]);
      const parent = Number(m[2]);
      const bucket = childrenOf.get(parent);
      if (bucket) bucket.push(child);
      else childrenOf.set(parent, [child]);
    }
    const out: number[] = [];
    const walk = (p: number): void => {
      for (const c of childrenOf.get(p) ?? []) {
        out.push(c);
        walk(c);
      }
    };
    walk(pid);
    return out;
  } catch {
    return [];
  }
}

/**
 * 杀「pid 及其整棵进程树」。
 *
 * Windows：`taskkill /T /F` 本来就连带子树。
 * POSIX：`process.kill(pid)` **只**结束该进程，不动它的子进程——daemon 被停后，它拉起的 ACP 大脑 / worker 会留下来继续占着会话与文件句柄（Windows 的 `taskkill /T` 会连带子树，所以这个缺陷只在 POSIX 暴露）。
 * 所以这里先收集后代、由叶子往根 SIGTERM（daemon 的 SIGTERM 处理器会自己清 pid 文件），等一小会儿再对仍存活的补 SIGKILL。
 */
function killProcessTrees(pids: number[]): void {
  const unique = [...new Set(pids.filter((p) => isAlive(p)))];
  if (!unique.length) return;
  if (process.platform === "win32") {
    for (const pid of unique)
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true, // 避免瞬时闪出控制台窗口
      });
    return;
  }
  // 先收集所有后代（按叶子优先排序：后出现的更深，反过来就是叶子先）
  const targets: number[] = [];
  for (const pid of unique) targets.push(...descendantPids(pid).reverse(), pid);
  const all = [...new Set(targets)].filter((p) => isAlive(p));
  for (const pid of all) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
  sleepSync(800); // 给 SIGTERM 处理器一点时间（daemon 会清 pid 文件、关子进程）
  for (const pid of all) {
    if (!isAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
}
/** 启动某账号的 daemon（方案 a：委托 pm2 常驻，跑 `wemind daemon`，注入 WECHAT_ACCOUNT）。 */
export function startDaemon(key: string, runner?: string): { ok: boolean; msg: string } {
  // 用 process.argv[1]（即正在执行的 cli.js 绝对路径），而不是 dirname(import.meta.url)：
  // 发布后 tsdown 把 manage.ts 内联进 dist/cli.js，两者恰好相同；但若将来拆成多 chunk，argv[1] 才是「用户装的那个 bin」，dirname(import.meta.url) 可能是 dist/chunks/ 下。
  const cliPath =
    process.argv[1] || path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  // start 前先停现有任何 runner（pm2 app / builtin 后台守护进程），避免同账号双跑抢 token
  stopDaemon(key);
  const useRunner = (runner || process.env.WEMIND_RUNNER || "builtin").toLowerCase();
  const r = useRunner === "pm2" ? pm2Start(key, cliPath) : watchdogStart(key, cliPath);
  if (!r.ok) process.exitCode = 1; // runner 起不来时别让「已启动」的文案配一个成功退出码
  print(r.msg);
  return r;
}

export type StopResult = {
  msg: string;
  /** kill 后所有目标都确认不在了。false 时调用方**不能**删账号目录（进程可能还在写）。 */
  ok: boolean;
};

/** 汇总 stop 的三类结果。`survivors` 是 kill 后仍活着的目标；导出仅供单测。 */
export function stopSummary(stopped: string[], skipped: string[], survivors: string[]): StopResult {
  const parts: string[] = [];
  if (stopped.length) parts.push(`已停止 ${stopped.join(" + ")}`);
  if (skipped.length)
    parts.push(`跳过 ${skipped.join(" + ")}（非本程序，未杀；已清陈旧 pid 文件）`);
  if (survivors.length) parts.push(`未能停止 ${survivors.join(" + ")}（仍在运行）`);
  return { msg: parts.length ? parts.join("；") : "无运行中的进程", ok: survivors.length === 0 };
}

/**
 * 停止某账号的常驻：先 pm2 delete（方案 a），再按 pid 兜底杀 wrapper/daemon/brain/worker（兼容直接启动的）。停的是**整条链**：除列出的进程外，还连带它们的子进程树。
 * 只有确认全部目标都停下才清 pid 文件：否则 `delete` 的存活检查会在文件被删后失去依据（旧实现先删文件再查，必然判「已停止」）。
 */
export function stopDaemon(key: string): StopResult {
  pm2Stop(key); // best-effort：停掉 pm2 托管的 app（若有）
  const dir = accountDir(key);
  const ag = resolveAgent(loadBrainConfig(dir), dir);
  // brain：优先用身份记录里「起进程时真实用的」bin/args 算特征串；没有记录（旧账号/未起过）才回退配置。
  const brec = brainRecord(dir);
  const brainMarkers = brec.markers ?? brainPidMarkers(ag.bin, ag.args);
  const cand: Array<{ pid: number | null; name: string; markers: string[][] }> = [
    { pid: readPid(dir, "wrapper.pid"), name: "wrapper", markers: CLI_PID_MARKERS },
    { pid: readPid(dir, "daemon.pid"), name: "daemon", markers: CLI_PID_MARKERS },
    { pid: brec.pid ?? readPid(dir, "brain.pid"), name: "brain", markers: brainMarkers },
  ];
  // worker：现在可能**多条并存**（多任务/多 agent），身份记录 `workers.pid.json` 里每条都带着起进程时真实用的 bin/args
  // → 逐条按自己的特征串判定。旧账号只有裸整数 `worker.pid`（无 bin/args）→ 回退「按配置算特征串」的老办法。
  const wrecs = readPidRecords(path.join(dir, "workers.pid.json"));
  if (wrecs.length) {
    for (const w of wrecs)
      cand.push({
        pid: w.pid,
        name: `worker${w.taskId ? `#${w.taskId}` : ""}(${w.agent || "?"})`,
        markers: recordMarkers(w),
      });
  } else {
    cand.push({
      pid: readPid(dir, "worker.pid"),
      name: "worker",
      markers: brainPidMarkers(ag.bin, ag.args),
    });
  }
  // 只杀「活着**且身份确认**」的：pid 会被复用，陈旧 pid 文件可能指向别人的进程 → 绝不误杀。
  // 命令行一次批量查（Windows 下较慢）；正常情况（陈旧 pid 早已不存在）根本不会发起查询。
  const lines = commandLines(cand.map((c) => c.pid));
  const stopped: string[] = [];
  const skipped: string[] = [];
  const toKill: number[] = [];
  const nameOf = new Map<number, string>();
  const seen = new Set<number>();
  for (const c of cand) {
    if (!c.pid || seen.has(c.pid) || !isAlive(c.pid)) continue;
    seen.add(c.pid);
    if (matchesMarkers(lines.get(c.pid), c.markers)) {
      toKill.push(c.pid);
      nameOf.set(c.pid, c.name);
      stopped.push(`${c.name} ${c.pid}`);
    } else {
      skipped.push(`${c.name} ${c.pid}`); // 活着的 pid 但不是我们的（pid 复用）→ 不杀
    }
  }
  // 身份校验都通过了才动手：一次性杀掉这些进程**及其子进程树**（见 killProcessTrees 注释）。
  killProcessTrees(toKill);
  // kill 之后仍活着的目标（权限不足、进程卡住等）：保留 pid 文件让下一次 stop 还能找到它。
  const survivors = toKill
    .filter((pid) => isAlive(pid))
    .map((pid) => `${nameOf.get(pid) ?? "进程"} ${pid}`);
  if (!survivors.length)
    for (const f of [
      "wrapper.pid",
      "daemon.pid",
      "brain.pid",
      "worker.pid",
      "workers.pid.json",
      BRAIN_RUNTIME_FILE,
    ]) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        /* ignore */
      }
    }
  return stopSummary(stopped, skipped, survivors);
}

/**
 * `delete` 前的最后一道闸：stop 失败/被跳过时 daemon 可能还活着，此时删目录等于删它正在用的文件。
 * 导出仅供单测。
 */
export function deleteGuard(key: string, alive: boolean): string | null {
  return alive
    ? `账号 ${key} 仍有 WeMind 进程未能停止（仍在运行），为避免删掉它正在使用的文件，本次**没有删除目录**。\n先确认并结束它：wemind stop ${key}（或看 wemind list / 进程管理器），再执行 delete。`
    : null;
}
