import fs from "node:fs";
import path from "node:path";
import {
  accountDir,
  listAccounts,
  registerAccount,
  unregisterAccount,
  getDefaultKey,
  loadAccount as readAccount,
  notifyStop,
  addAllowFrom,
} from "@wemind/wechat-ilink-core";
import {
  CLI_PID_MARKERS,
  brainPidMarkers,
  commandLines,
  identifyProcess,
  type ProcessIdentity,
} from "../shared/process/proc-identity.js";
import { resolveAgent } from "../agents/brain-agents.js";
import { loadBrainConfig } from "../agents/brain-config.js";
import { agentLabel } from "./subcommands/cli-brain.js";
import { daemonIdentity, pickKey, readPid, resolveKey } from "./cli-context.js";
import { readPidRecords, recordMarkers } from "../shared/process/pid-record.js";
import { readBrainState } from "../agents/brain-state.js";
import { brainRecord, deleteGuard, startDaemon, stopDaemon } from "./process-lifecycle.js";

/**
 * 账号维度的命令实现：list / adopt / logout / delete / start。
 * 从 manage.ts 拆出（2026-11-06）；进程启停细节在 process-lifecycle.ts，命令分派留在 manage.ts。
 */

export function cmdList(): string {
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
  const query = commandLines(
    entries.flatMap((e) => [e.dpid, e.bpid, ...e.workers.map((w) => w.pid)]),
  );
  const identityIn = (pid: number | null, markers: string[][]): ProcessIdentity =>
    identifyProcess(pid, markers, query);
  return entries
    .map((e) => {
      const dIdentity = identityIn(e.dpid, CLI_PID_MARKERS);
      const runningNow = dIdentity === "ours";
      const running =
        dIdentity === "ours"
          ? `运行中(pid ${e.dpid})`
          : dIdentity === "unknown"
            ? `无法确认(pid ${e.dpid})`
            : "已停止";
      const bIdentity = identityIn(e.bpid, e.brainMarkers);
      const brainPid =
        bIdentity === "ours"
          ? `  brain(pid ${e.bpid}${e.brainAgent ? ` ${e.brainAgent}` : ""})`
          : bIdentity === "unknown"
            ? `  brain(pid ${e.bpid} 无法确认)`
            : "";
      const live = e.workers.filter((w) => identityIn(w.pid, w.markers) === "ours");
      const unknownWorkers = e.workers.filter((w) => identityIn(w.pid, w.markers) === "unknown");
      const poolParts = [
        ...live.map((w) => `${w.agent}${w.taskId ? `#${w.taskId}` : ""}:${w.state}`),
        ...unknownWorkers.map((w) => `${w.agent}${w.taskId ? `#${w.taskId}` : ""}:无法确认`),
      ];
      const pool = poolParts.length ? `  pool[${poolParts.join(", ")}]` : "";
      return `- ${e.a.key}${e.a.key === def ? " [默认]" : ""}  label=${e.a.label}  botId=${e.a.botId}  agent=${agentLabel(e.dir, runningNow ? e.brainRuntime : null)}  ${running}${brainPid}${pool}`;
    })
    .join("\n");
}

export function cmdAdopt(key: string, label?: string): string {
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

export async function cmdLogout(sel: string): Promise<string> {
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

export function cmdDelete(sel: string): string {
  const key = resolveKey(sel);
  const stop = stopDaemon(key);
  // 用 stop 的实际结果判定，而不是再看 daemonAlive：旧实现先删 pid 文件再查，永远得到「已停止」。
  // 三态：查询失败（unknown）也不能删——进程可能还在写目录。
  const identity = daemonIdentity(key);
  const blocked = deleteGuard(
    key,
    !stop.ok || identity !== "other",
    identity === "unknown" || stop.unknown,
  );
  if (blocked) throw new Error(blocked);
  try {
    fs.rmSync(accountDir(key), { recursive: true, force: true });
  } catch (e) {
    throw new Error(`删除目录失败: ${String(e)}`);
  }
  unregisterAccount(key);
  return `账号 ${key} 已删除（${stop.msg}，已移除目录与注册）。`;
}

export function cmdStart(sel?: string, runner?: string): string {
  const key = pickKey(sel); // 省略账号 = 默认账号
  const r = startDaemon(key, runner);
  return r.ok
    ? `已启动 daemon（账号 ${key}）。用 list 查看运行状态。`
    : `启动 daemon 失败（账号 ${key}），原因见上方输出。`;
}

/** 逐个启动并汇总；单个失败不阻断其余（自启场景宁可部分可用）。 */
function startKeys(keys: string[], runner?: string): string {
  const started: string[] = [];
  const failed: string[] = [];
  for (const key of keys) {
    // startDaemon 内部逐个打印结果（成功/失败原因），这里只负责统计
    const r = startDaemon(key, runner);
    if (r.ok) started.push(key);
    else failed.push(key);
  }
  const parts = [`已启动 ${started.length}/${keys.length} 个账号的 daemon`];
  if (started.length) parts.push(`成功：${started.join(", ")}`);
  if (failed.length) {
    parts.push(`失败：${failed.join(", ")}`);
    process.exitCode = 1;
  }
  return `${parts.join("；")}。用 list 查看运行状态。`;
}

/**
 * 启动**所有已登记账号**（`wemind start --all`）。开机自启的原生触发器触发时执行的就是它。
 * 单个账号失败不影响其余账号，最后汇总并以退出码 1 反映失败。
 */
export function cmdStartAll(runner?: string): string {
  const accs = listAccounts();
  if (!accs.length) return "（无已登记账号）。用 `login` 添加。";
  return startKeys(
    accs.map((a) => a.key),
    runner,
  );
}

/**
 * 启动指定的多个账号（`wemind start <key1> <key2> …`；Windows 计划任务在只装部分账号时用）。
 * 先全部解析再启动：任一 key/label 无效就整条命令失败，避免「一半起来了」的半成品状态。
 */
export function cmdStartKeys(sels: string[], runner?: string): string {
  const keys = sels.map((s) => resolveKey(s));
  return startKeys([...new Set(keys)], runner);
}
