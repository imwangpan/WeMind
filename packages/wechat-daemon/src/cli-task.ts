import fs from "node:fs";
import path from "node:path";

import { accountDir } from "@wemind/wechat-ilink-core";
import { awaitTaskAck, type TaskAck, writeTaskCmd as writeTaskCommand } from "./task-inbox.js";
import { daemonAlive, pickKey, requireDaemonAlive } from "./cli-context.js";

// ===== 本地任务命令（文件桥）：写 task-inbox/*.json，由 daemon 扫描执行；状态读 task-state.json，结果读 task-out/*.json =====

/** 原子写一个命令文件到收件箱（临时文件 + rename，避免 daemon 读到半截）；返回本次命令的答复编号。 */
function writeTaskCmd(key: string, obj: Record<string, unknown>): string {
  return writeTaskCommand(accountDir(key), obj);
}

/**
 * 把任务答复翻成 CLI 文案与成败（导出仅供单测）。
 * `ok=false` = daemon 明确拒绝/失败（达上限、「没有 #9 号任务」），文案照打，但调用方要把退出码置 1；
 * 等不到答复不算失败（老版 daemon / 刚启动），只多一句说明。
 */
export function taskAckOutcome(
  a: Pick<TaskAck, "ok" | "text"> | null,
  fallback: string,
): { text: string; failed: boolean } {
  if (!a)
    return {
      text: `${fallback}\n（没等到 daemon 答复：它可能还在跑旧版本，或刚启动。用 task-list / task-status 核对实际状态。）`,
      failed: false,
    };
  return { text: a.text || fallback, failed: !a.ok };
}

/**
 * 等这次命令的答复（daemon 把真实结果写进 `task-out/<id>.json`）。
 * 三种情形分得很清楚：
 *  - 有答复、有文案 → 打印 daemon 的那句话（失败原因、「没有 #9 号任务」这类只有它知道的事）；
 *  - 有答复、文案为空 → 命令成功但没有额外要说的，用调用方自己那句话（**立刻**，不干等）；
 *  - 没有答复 → 老版 daemon 不认这条通道（或它正在退出）：回退到「已发送」措辞并说明一句，
 *    不把「没等到」当成「成功了」——达上限被拒与「派发成功」在旧措辞里长得一模一样。
 */
async function taskOutcome(
  key: string,
  ackId: string,
  fallback: string,
  timeoutMs = 5000,
): Promise<string> {
  const o = taskAckOutcome(await awaitTaskAck(accountDir(key), ackId, timeoutMs), fallback);
  if (o.failed) process.exitCode = 1; // daemon 明确拒绝/失败（达上限、没有 #9 号任务）：文案照打，退出码非 0
  return o.text;
}

export function resolveTaskCwd(cwd: string | undefined, base: string = process.cwd()): string {
  const p = path.resolve(base, cwd || ".");
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    throw new Error(`工作目录不存在：${p}`);
  }
  if (!st.isDirectory()) throw new Error(`--cwd 不是目录：${p}`);
  return p;
}

export async function cmdTask(
  text: string,
  cwd: string | undefined,
  sel?: string,
  agentKey?: string,
): Promise<string> {
  if (!text) throw new Error('用法: task "<任务描述>" [--cwd 目录] [--agent <名字>] [<key|label>]');
  const key = pickKey(sel);
  requireDaemonAlive(key);
  const useCwd = resolveTaskCwd(cwd);
  // 答复等 daemon：**起进程有结果之后**它才发（达上限/agent 起不来是那时才知道的），
  // 所以这里不能自己编「已派发」——旧写法轮询 task-state.json 的 active，会把「达上限被拒」和
  // 甚至上一条任务的编号报成成功。
  const ackId = writeTaskCmd(key, {
    kind: "dispatch",
    text,
    cwd: useCwd,
    ...(agentKey ? { agent: agentKey } : {}),
  });
  return await taskOutcome(
    key,
    ackId,
    `已发送任务（cwd=${useCwd}）。看进展用 task-list。`,
    // 派发的答复要等「起进程有结果」：冷启动一个 agent 可能要几十秒，等得久一点好过说假话
    30_000,
  );
}

/** 任务编号必须是正整数：0/负数以前被当成「没给编号」，会落到唯一那条任务上（发错目标）。 */
export function parseTaskId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`任务编号必须是正整数：${raw}`);
  return n;
}

export async function cmdTaskReply(text: string, sel?: string, id?: number): Promise<string> {
  if (!text) throw new Error('用法: task-reply ["#编号"] "<内容>" [<key|label>]');
  const key = pickKey(sel);
  requireDaemonAlive(key);
  const ackId = writeTaskCmd(key, { kind: "reply", text, ...(id ? { id } : {}) });
  return await taskOutcome(key, ackId, `已发送给任务${id ? ` #${id}` : ""}：${text.slice(0, 40)}`);
}

export async function cmdTaskStop(sel?: string, id?: number | "all"): Promise<string> {
  const key = pickKey(sel);
  requireDaemonAlive(key);
  const ackId = writeTaskCmd(key, { kind: "stop", ...(id ? { id } : {}) });
  const fallback =
    id === "all" ? "已发送「结束全部任务」指令。" : `已发送「结束任务${id ? ` ${id}` : ""}」指令。`;
  return await taskOutcome(key, ackId, fallback);
}

type WmTaskRow = {
  id: number;
  userId: string;
  agent: string;
  status: string;
  turns: number;
  startedAt: number;
  lastOutput?: string;
  cwd?: string;
};
const STATUS_ZH: Record<string, string> = {
  running: "运行中",
  waiting: "等回复",
  interrupted: "已中断",
};

/**
 * 读任务表（daemon 没跑也能读：文件就是唯一真相）。
 * 先看 `tasks.json`——那是任务表的**持久**副本（重启后也在，编号跨重启不归零）；
 * 老版本只写过 `task-state.json`（状态记录），仍兼容读它。
 */
function readTaskRows(key: string): WmTaskRow[] | null {
  const dir = accountDir(key);
  for (const name of ["tasks.json", "task-state.json"]) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")) as {
        tasks?: WmTaskRow[];
      };
      if (Array.isArray(s.tasks)) return s.tasks;
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

export function cmdTaskList(sel?: string): string {
  const key = pickKey(sel);
  const rows = readTaskRows(key);
  if (!rows)
    return `账号 ${key}：无任务表（tasks.json / task-state.json 都不存在，daemon 未跑过多任务）。`;
  // 任务表是 daemon 的活状态：它没在跑（或还在跑旧版）时，表里的「运行中」只是上次留下的，别当成现在时。
  const stale = daemonAlive(key)
    ? ""
    : "\n（daemon 未运行：以下状态是它上次留下的记录；未完成的任务会在下次启动时标为「已中断」，回「继续」可续跑。）";
  if (!rows.length) return `账号 ${key}：当前没有任务。${stale}`;
  const lines = [`账号 ${key} 任务（${rows.length} 条）：`];
  for (const t of rows) {
    const age = t.startedAt ? `${Math.round((Date.now() - t.startedAt) / 1000)}s` : "?";
    lines.push(
      `  #${t.id} [${t.agent}] ${STATUS_ZH[t.status] ?? t.status} · ${t.turns} 轮 · ${age}${t.cwd ? ` · cwd=${t.cwd}` : ""}`,
    );
    if (t.lastOutput) lines.push(`      ${t.lastOutput.replace(/\n/g, " ").slice(0, 140)}`);
  }
  return lines.join("\n") + stale;
}

export function cmdTaskStatus(sel?: string): string {
  const key = pickKey(sel);
  const rows = readTaskRows(key);
  if (rows && rows.length) return cmdTaskList(sel);
  const stateFile = path.join(accountDir(key), "task-state.json");
  let s: {
    active?: boolean;
    status?: string;
    turns?: number;
    startedAt?: number;
    lastOutput?: string;
  };
  try {
    s = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  } catch {
    return `账号 ${key}：无任务状态（task-state.json 不存在，daemon 可能未跑过任务）。`;
  }
  if (!s.active) return `账号 ${key}：当前无活跃任务（idle）。`;
  const since = s.startedAt ? `${Math.round((Date.now() - s.startedAt) / 1000)}s` : "?";
  return [
    `账号 ${key} 任务状态：`,
    `  状态：${s.status}  轮次：${s.turns ?? 0}  已运行：${since}`,
    `  最近输出：${s.lastOutput ? s.lastOutput.slice(0, 300) : "（无）"}`,
  ].join("\n");
}
