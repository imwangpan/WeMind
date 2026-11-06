#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  WEMIND_ROOT,
  accountDir,
  listAccounts,
  registerAccount,
  unregisterAccount,
  setLabel,
  getDefaultKey,
  setDefaultKey,
  loadAccount as readAccount,
  notifyStop,
  addAllowFrom,
  removeAllowFrom,
  readAllowFrom,
} from "@wemind/wechat-ilink-core";
import { pm2Start, pm2Stop } from "./pm2-runner.js";
import { watchdogStart } from "./watchdog-runner.js";
import {
  CLI_PID_MARKERS,
  brainPidMarkers,
  commandLines,
  isAlive,
  matchesMarkers,
} from "./shared/process/proc-identity.js";
import { resolveAgent } from "./agents/brain-agents.js";
import { loadBrainConfig } from "./agents/brain-config.js";
import { agentLabel, cmdBrain } from "./cli-brain.js";
import { cmdLogin, finalizeStaging } from "./cli-login.js";
import { cmdSession, cmdSessionCurrent } from "./cli-session.js";
import { daemonAlive, pickKey, readPid, resolveKey } from "./cli-context.js";
import {
  cmdTask,
  cmdTaskList,
  cmdTaskReply,
  cmdTaskStatus,
  cmdTaskStop,
  parseTaskId,
} from "./cli-task.js";

export { pickKey } from "./cli-context.js";
export { agentLabel } from "./cli-brain.js";
export { createLoginStagingDir } from "./cli-login.js";
export { resolveTaskCwd, taskAckOutcome } from "./cli-task.js";
import { readPidRecords, recordMarkers } from "./shared/process/pid-record.js";
import { BRAIN_RUNTIME_FILE, readBrainState } from "./agents/brain-state.js";
import { CLI_VERSION, versionLine } from "./shared/version.js";
import { renderHelp } from "./chat-commands.js";

/**
 * WeMind 多账号管理 CLI。
 * 账号 key = 由微信 botId 派生的唯一标识；每个账号独立目录 ~/.wemind/<key>。
 * label = 人类可读别名（可改、可重复）；管理命令可用 key 或 label 选择账号。
 * 推荐用 `login` 一条命令完成：自刷新二维码 → 扫码 → 自动登记（→ 可选自动启动）。
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
function startDaemon(key: string, runner?: string): void {
  // 用 process.argv[1]（即正在执行的 cli.js 绝对路径），而不是 dirname(import.meta.url)：
  // 发布后 tsdown 把 manage.ts 内联进 dist/cli.js，两者恰好相同；但若将来拆成多 chunk，argv[1] 才是「用户装的那个 bin」，dirname(import.meta.url) 可能是 dist/chunks/ 下。
  const cliPath =
    process.argv[1] || path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  // start 前先停现有任何 runner（pm2 app / builtin 后台守护进程），避免同账号双跑抢 token
  stopDaemon(key);
  const useRunner = (runner || process.env.WEMIND_RUNNER || "builtin").toLowerCase();
  const r = useRunner === "pm2" ? pm2Start(key, cliPath) : watchdogStart(key, cliPath);
  if (!r.ok) process.exitCode = 1; // runner 起不来时别让「已启动」的文案配一个成功退出码
  console.log(r.msg);
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
function stopDaemon(key: string): StopResult {
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

/** 旧流程的固定暂存目录：仅 `wimind finalize` 兼容命令使用；新登录走 createLoginStagingDir()。 */
const LEGACY_STAGING = path.join(WEMIND_ROOT, ".staging");

function cmdList(): string {
  const def = getDefaultKey();
  const accs = listAccounts();
  if (!accs.length) return "（无已登记账号）。用 `login` 添加。";
  // 先收集各账号的 pid + 大脑特征，再**一次性**批量查命令行（Windows 下每次查询较慢）；只凭「pid 活着」显示状态会在重启后 pid 复用时骗人，所以要带身份校验。
  const entries = accs.map((a) => {
    const dir = accountDir(a.key);
    const ag = resolveAgent(loadBrainConfig(dir), dir);
    const brec = brainRecord(dir);
    return {
      a,
      dir,
      dpid: readPid(dir, "daemon.pid"),
      bpid: brec.pid ?? readPid(dir, "brain.pid"),
      // 身份记录里是「起进程时真实用的」bin/args，比配置值可靠（brain set 未重启 / 热切换窗口 / brain≠worker）
      brainMarkers: brec.markers ?? brainPidMarkers(ag.bin, ag.args),
      brainAgent: brec.agent,
      // daemon 启动/热切换后写入的「实际生效大脑」；只在 daemon 活着时采信（下面按 dpid 判）
      brainRuntime: readBrainState(dir),
      // 多 task worker：`workers.pid.json` 是记录数组（每条一个 agent/任务），逐条按自己的身份校验
      workers: readPidRecords(path.join(dir, "workers.pid.json")).map((w) => ({
        pid: w.pid,
        agent: w.agent,
        state: w.state,
        taskId: w.taskId,
        markers: recordMarkers(w),
      })),
    };
  });
  const lines = commandLines(
    entries.flatMap((e) => [e.dpid, e.bpid, ...e.workers.map((w) => w.pid)]),
  );
  const aliveOursIn = (pid: number | null, markers: string[][]): boolean =>
    !!pid && matchesMarkers(lines.get(pid), markers);
  return entries
    .map((e) => {
      const runningNow = aliveOursIn(e.dpid, CLI_PID_MARKERS);
      const running = runningNow ? `运行中(pid ${e.dpid})` : "已停止";
      const brainPid = aliveOursIn(e.bpid, e.brainMarkers)
        ? `  brain(pid ${e.bpid}${e.brainAgent ? ` ${e.brainAgent}` : ""})`
        : "";
      const live = e.workers.filter((w) => aliveOursIn(w.pid, w.markers));
      const pool = live.length
        ? `  pool[${live.map((w) => `${w.agent}${w.taskId ? `#${w.taskId}` : ""}:${w.state}`).join(", ")}]`
        : "";
      return `- ${e.a.key}${e.a.key === def ? " [默认]" : ""}  label=${e.a.label}  botId=${e.a.botId}  agent=${agentLabel(e.dir, runningNow ? e.brainRuntime : null)}  ${running}${brainPid}${pool}`;
    })
    .join("\n");
}

function cmdAdopt(key: string, label?: string): string {
  if (!key) throw new Error("用法: adopt <key> [--label 名]");
  const acc = readAccount(accountDir(key));
  if (!acc?.botId) throw new Error(`${accountDir(key)} 无有效 account.json`);
  const meta = registerAccount({
    key,
    botId: acc.botId,
    userId: acc.userId,
    baseUrl: acc.baseUrl,
    label: label || key,
  });
  if (acc.userId) addAllowFrom(acc.userId, accountDir(key)); // 接管时把登录者种入白名单
  return `已登记：key=${key}  label=${meta.label}  botId=${acc.botId}`;
}

async function cmdLogout(sel: string): Promise<string> {
  const key = resolveKey(sel);
  const dir = accountDir(key);
  const acc = readAccount(dir);
  const stop = stopDaemon(key);
  if (acc?.botToken) {
    try {
      await notifyStop({ baseUrl: acc.baseUrl, token: acc.botToken });
    } catch {
      /* ignore */
    }
  }
  for (const f of ["account.json", "state.json", "qr_login.json", "qrcode.png", "qrcode.txt"]) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* ignore */
    }
  }
  return `账号 ${key} 已登出（${stop.msg}）。目录与会话保留，可重新登录。`;
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

function cmdDelete(sel: string): string {
  const key = resolveKey(sel);
  const stop = stopDaemon(key);
  // 用 stop 的实际结果判定，而不是再看 daemonAlive：旧实现先删 pid 文件再查，永远得到「已停止」。
  const blocked = deleteGuard(key, !stop.ok || daemonAlive(key));
  if (blocked) throw new Error(blocked);
  try {
    fs.rmSync(accountDir(key), { recursive: true, force: true });
  } catch (e) {
    throw new Error(`删除目录失败: ${String(e)}`);
  }
  unregisterAccount(key);
  return `账号 ${key} 已删除（${stop.msg}，已移除目录与注册）。`;
}

function cmdStart(sel?: string, runner?: string): string {
  const key = pickKey(sel); // 省略账号 = 默认账号
  startDaemon(key, runner);
  return `已启动 daemon（账号 ${key}）。用 list 查看运行状态。`;
}

export async function runManage(argv: string[]): Promise<void> {
  const cmd = argv.shift();
  const rest = [...argv];
  // 取开关值：缺值（`--cwd` 后面没东西，或紧跟另一个开关）直接报错——以前会静默当成「没写」，用默认值继续跑。
  const takeValue = (flag: string): string | undefined => {
    const i = rest.indexOf(flag);
    if (i < 0) return undefined;
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} 缺少参数值`);
    rest.splice(i, 2);
    return v;
  };
  const label = takeValue("--label");
  const si = rest.indexOf("--start");
  const autoStart = si >= 0;
  if (autoStart) rest.splice(si, 1);
  const cwd = takeValue("--cwd");
  const runner = takeValue("--runner");
  if (runner && !["builtin", "pm2"].includes(runner.toLowerCase()))
    throw new Error(`未知 runner「${runner}」（可用：builtin / pm2）`);
  const agentKey = takeValue("--agent");

  switch (cmd) {
    case "version":
    case "--version":
    case "-v":
      console.log(versionLine());
      break;
    case "login":
      await cmdLogin(label, autoStart, runner, { startDaemon });
      break;
    case "list":
      console.log(cmdList());
      break;
    case "brain":
      console.log(await cmdBrain(rest, { startDaemon }));
      break;
    case "session": {
      const sub = (rest[0] ?? "").toLowerCase();
      if (sub === "current") console.log(cmdSessionCurrent(pickKey(rest[1])));
      else console.log(await cmdSession(rest));
      break;
    }
    case "adopt":
      console.log(cmdAdopt(rest[0], label));
      break;
    case "start":
      console.log(cmdStart(rest[0], runner));
      break;
    case "stop": {
      const k = pickKey(rest[0]); // 省略账号 = 默认账号（答复带上解析到的账号，避免「静默换目标」）
      console.log(`账号 ${k}：${stopDaemon(k).msg}`);
      break;
    }
    case "task":
      console.log(await cmdTask(rest[0], cwd, rest[1], agentKey));
      break;
    case "task-reply": {
      // 兼容两种写法：`task-reply "#3 内容"` 与 `task-reply 3 "内容"`
      const first = rest[0] ?? "";
      const m = first.match(/^[#＃](\d+)\s*([\s\S]*)$/);
      if (m) console.log(await cmdTaskReply(m[2], rest[1], parseTaskId(m[1])));
      else if (rest.length >= 2 && /^\d+$/.test(first))
        console.log(await cmdTaskReply(rest[1], rest[2], parseTaskId(first)));
      else console.log(await cmdTaskReply(first, rest[1]));
      break;
    }
    case "task-list":
      console.log(cmdTaskList(rest[0]));
      break;
    case "task-status":
      console.log(cmdTaskStatus(rest[0]));
      break;
    case "task-stop": {
      const a = rest[0];
      const id: number | "all" | undefined =
        a === "all" || a === "全部" ? "all" : a && /^\d+$/.test(a) ? parseTaskId(a) : undefined;
      console.log(await cmdTaskStop(id === undefined ? a : rest[1], id));
      break;
    }
    case "label": {
      const k = resolveKey(rest[0]);
      setLabel(k, rest.slice(1).join(" "));
      console.log(`已设置 ${k} 的别名为「${rest.slice(1).join(" ")}」`);
      break;
    }
    case "set-default": {
      const k = resolveKey(rest[0]);
      setDefaultKey(k);
      console.log(`默认账号 = ${k}`);
      break;
    }
    case "logout":
      console.log(await cmdLogout(rest[0]));
      break;
    case "delete":
      console.log(cmdDelete(rest[0]));
      break;
    case "finalize": {
      const { msg } = finalizeStaging(LEGACY_STAGING, label);
      console.log(msg);
      break;
    } // 兼容旧流程（staging 已有登录时直接收进账号目录）
    case "allow": {
      const k = resolveKey(rest[0]);
      const uid = rest[1];
      if (!uid) throw new Error("用法: allow <key|label> <userId>");
      const list = addAllowFrom(uid, accountDir(k));
      console.log(`已加入白名单 ${uid} → ${k}\n当前清单(${list.length})：${list.join(", ")}`);
      break;
    }
    case "revoke": {
      const k = resolveKey(rest[0]);
      const uid = rest[1];
      if (!uid) throw new Error("用法: revoke <key|label> <userId>");
      const list = removeAllowFrom(uid, accountDir(k));
      console.log(
        `已从白名单移除 ${uid} → ${k}\n当前清单(${list.length})：${list.join(", ") || "（空）"}`,
      );
      break;
    }
    case "allowlist": {
      const k = resolveKey(rest[0]);
      const list = readAllowFrom(accountDir(k));
      console.log(
        `${k} 登录者白名单(${list.length})：\n${list.map((u) => "  - " + u).join("\n") || "  （空）"}`,
      );
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(helpText());
      break;
    default:
      // 拼错命令不能静默成功：脚本里 `wemind strat x` 以前 exit 0，看起来像成功。
      // 提示与帮助都走 stderr（stdout 保持为空），并以 2 退出（2 = 用法错误，与「运行出错」的 1 区分）。
      console.error(`未知命令：${cmd}`);
      console.error(helpText());
      process.exitCode = 2;
  }
}

export function helpText(): string {
  return `WeMind 多账号管理（wemind v${CLI_VERSION}）
用法: wemind <command>            其余：wemind version | help

  login [--label 名] [--start]   一条命令完成扫码登录：自刷新二维码 + 自动登记（--start 顺带启动 daemon）
  list                           列出账号、别名、运行状态（含 brain 进程与 worker 池）
  start [key|label]              启动某账号的 daemon（省略 = 默认账号）
  stop [key|label]               停止某账号的 daemon（连带 brain 与全部 worker 进程树；省略 = 默认账号）
  brain set <agent 名|auto> [--bin X] [--args "…"] [--extra-args "…"] [--shell|--no-shell] [--model X|auto] [--restart] [<key|label>]
                                 改账号大脑**配置**（写 brain.json；只给 agent 名且 daemon 认桥时当场应用；带 --bin/--args/--extra-args/--shell/--model 只写盘——除 --shell 外可用同名 brain switch 当场应用；--extra-args 追加在预设参数后，不会漏掉 ACP 子命令）
  brain unset|check|show [<key|label>]   清除配置 / 真机 ACP 自检 / 查看配置与生效情况
  logout <key|label>             停 daemon + 通知下线 + 清凭证（保留目录，可重登）
  delete <key|label>             停 daemon + 删除目录 + 移除注册
  label <key|label> <新别名>     改别名
  set-default <key|label>        设默认账号
  adopt <key> [--label 名]       把已存在的账号目录登记进注册表
  allowlist <key|label>          查看该账号的登录者白名单(allowFrom)
  allow <key|label> <userId>     （兜底）把某 userId 加进白名单（正常只会有登录者本人）
  revoke <key|label> <userId>    （兜底）从白名单里移除某 userId

【与微信等价的操作指令】以下都能带 [<key|label>]（省略则用默认账号）。
运行中的命令经**控制桥**交给 daemon 执行（CLI 与微信走同一段代码，行为一致）；daemon 没跑时，
读命令照常可用，部分写命令会只改文件或提示先启动。

${renderHelp("owner", "cli", { sections: ["brain", "session", "task", "misc"] })}

说明：key = 由微信 botId 派生的唯一标识（目录名）；label = 人类可读别名。多数命令可用 key 或 label。
省略账号的命令（start/stop 与会话/任务类）用**默认账号**：首个登记的账号自动成为默认，可用 set-default 改、list 里看 [默认]。
logout/delete 等破坏性命令仍必须显式指定账号。`;
}
// 入口由 cli.ts 调用 runManage(argv)；此处不再顶层自启。
