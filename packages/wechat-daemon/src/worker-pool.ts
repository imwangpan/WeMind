import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";
import { createConn, type WorkerConn } from "./worker-acp.js";
import { pidRecordOf, writePidRecords, type PidRecord, type PidState } from "./pid-record.js";
import type { ResolvedAgent } from "./brain-agents.js";

/**
 * worker 进程池：**一条任务一条 ACP 连接**，按 agent 复用常驻进程。
 *
 * 为什么需要池：多任务并行要求「a 大脑做任务1、b 大脑做任务2」，而一个 agent 进程同一时刻只跑一条会话；
 * 同时每个 agent 进程都是一个完整的 agent（内存/冷启动都不便宜），任务一结束就杀掉会让「紧接着派下一个任务」反复付冷启动。
 * 于是任务结束只是把连接**还给进程池**：同 agent 的下一个任务直接复用，空闲久了才回收。
 *
 * 策略（`planAcquire`/`planReap` 是纯函数，可单独测——IO 与判定分离）：
 *  - 同 agent 的空闲连接优先复用（**最旧的先用**：它本来就最接近被回收，先让它干活正好续命）；
 *  - 没有可复用的就 spawn；
 *  - 同时运行的**任务**数上限 `WEMIND_MAX_WORKERS`（默认 3）：超了**直接拒绝派发**（用户当场知道），不排队（排队会让任务悄悄等着）；
 *  - 空闲连接数上限 `WEMIND_IDLE_MAX`（默认 2）、空闲超 `WEMIND_WORKER_REAP_MS`（默认 5min）回收，都从最旧的开始；
 *  - busy 连接永不回收（正在跑任务的进程，杀了就是丢任务）。
 *
 * 与 `WEMIND_WORKER_IDLE_MS` 的区别：那个是「单轮 prompt 多久没有帧算卡死」（既有语义，见 worker-acp.ts），
 * 这里是「空闲**连接**留多久」，两个时间尺度不同，故不复用同一个变量名。
 *
 * 同一 agent 并发 = 两个进程共用一个配置目录（等价「同一个 agent 开两个终端」）：不同 agent 各有自己的子目录天然隔离，
 * 同 agent 的会话/缓存文件是否互踩是**待实测**项（见方案「待实测」5/6），文档如实写明。
 */

export const WORKERS_PID_FILE = path.join(DATA_DIR, "workers.pid.json");

export type PoolLimits = {
  /** 同时运行的任务数上限（每个运行中的任务占一个连接/进程）。 */
  maxConcurrent: number;
  /** 空闲连接数上限。 */
  idleMax: number;
  /** 空闲多久回收。 */
  idleMs: number;
};

export function poolLimits(env: NodeJS.ProcessEnv = process.env): PoolLimits {
  const n = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d);
  return {
    maxConcurrent: n(env.WEMIND_MAX_WORKERS, 3),
    idleMax: n(env.WEMIND_IDLE_MAX, 2),
    idleMs: n(env.WEMIND_WORKER_REAP_MS, 300_000),
  };
}

/** 连接的取用判定只需这些字段（纯函数入参，与真实 conn 解耦）。 */
export type ConnInfo = {
  id: string;
  agent: string;
  /** agent 身份键（名字+bin+args）：不同的启动参数 = 不同的进程，不能互相复用。 */
  key: string;
  state: PidState;
  lastUsedAt: number;
  taskId?: number;
};

export type AcquirePlan =
  | { kind: "reuse"; connId: string; reap: string[] }
  | { kind: "spawn"; reap: string[] }
  | { kind: "reject"; problem: string };

/** agent 身份键：同一个预设但启动参数不同（如 `--bin` 改过）必须算两个进程。 */
export function agentKey(ag: ResolvedAgent): string {
  return `${ag.name}|${ag.bin}|${ag.args.join(" ")}`;
}

/**
 * 决定「这条任务用哪条连接」。`reap` 里的是顺带该回收的空闲连接（调用方先复用/起新进程，再按它杀）。
 * 被复用的那条不会出现在 `reap` 里——哪怕它是过期的（复用比「先杀再起」便宜）。
 */
export function planAcquire(
  conns: ConnInfo[],
  key: string,
  limits: PoolLimits,
  now: number,
): AcquirePlan {
  const busy = conns.filter((c) => c.state === "busy").length;
  if (busy >= limits.maxConcurrent)
    return {
      kind: "reject",
      problem: `同时运行的任务数已达上限（${limits.maxConcurrent} 个）。等一个跑完，或先「结束任务 <编号>」收掉不再需要的。`,
    };
  const reusable = conns
    .filter((c) => c.state === "idle" && c.key === key)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.id.localeCompare(b.id))[0];
  if (reusable)
    return { kind: "reuse", connId: reusable.id, reap: planReap(conns, limits, now, reusable.id) };
  return { kind: "spawn", reap: planReap(conns, limits, now) };
}

/**
 * 该回收哪些空闲连接：① 空闲超时；② 回收后仍超过 idleMax 的部分（从最旧的开始）。
 * `keep` 是「刚用上的那条」——哪怕它最旧也不回收（收掉正在干活的东西是纯亏）。
 */
export function planReap(
  conns: ConnInfo[],
  limits: PoolLimits,
  now: number,
  keep?: string,
): string[] {
  const idle = conns
    .filter((c) => c.state === "idle")
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.id.localeCompare(b.id));
  const reaped = new Set<string>();
  for (const c of idle) {
    if (c.id !== keep && now - c.lastUsedAt > limits.idleMs) reaped.add(c.id);
  }
  let excess = idle.filter((c) => !reaped.has(c.id)).length - limits.idleMax;
  for (const c of idle) {
    if (excess <= 0) break;
    if (c.id === keep || reaped.has(c.id)) continue;
    reaped.add(c.id);
    excess -= 1;
  }
  return [...reaped];
}

type Entry = {
  conn: WorkerConn;
  key: string;
  state: PidState;
  taskId?: number;
  lastUsedAt: number;
  spawnedAt: number;
};

const entries = new Map<string, Entry>(); // conn.id -> entry（Task 侧只拿 conn 引用，映射留在这里）

function info(e: Entry): ConnInfo {
  const i: ConnInfo = {
    id: e.conn.id,
    agent: e.conn.agent.name,
    key: e.key,
    state: e.state,
    lastUsedAt: e.lastUsedAt,
  };
  if (e.taskId !== undefined) i.taskId = e.taskId;
  return i;
}

/** 池内快照（只读；判定一律走这个 + 纯函数）。 */
export function poolInfo(): ConnInfo[] {
  return [...entries.values()].filter((e) => e.conn.isAlive()).map(info);
}

/** 落盘 pid 身份记录：`wemind stop` 据此精确找到全部 worker（多 agent 并存时新记录显得必要）。 */
function writeRecords(): void {
  const recs: PidRecord[] = [];
  for (const e of entries.values()) {
    const pid = e.conn.pid();
    if (pid === null || !e.conn.isAlive()) continue;
    const extra: { taskId?: number; state: PidState } = { state: e.state };
    if (e.taskId !== undefined) extra.taskId = e.taskId;
    const rec = pidRecordOf(pid, e.conn.agent, extra);
    rec.startedAt = e.spawnedAt;
    recs.push(rec);
  }
  writePidRecords(WORKERS_PID_FILE, recs);
}

function reapByIds(ids: string[]): void {
  let changed = false;
  for (const id of ids) {
    const e = entries.get(id);
    if (!e || e.state === "busy") continue; // 复核：判定之后可能已被别的任务取用
    e.conn.kill();
    entries.delete(id);
    changed = true;
  }
  if (changed) writeRecords();
}

/**
 * 取一条连接跑任务：命中空闲就复用，否则起新进程（spawn + initialize 成功才算拿到）。
 * 同步登记（busy）**在** await spawn 之前——否则两个任务会同时规划到「空闲」的同一状态、各起一个进程。
 */
export async function acquire(
  ag: ResolvedAgent,
  taskId?: number,
): Promise<{ ok: true; conn: WorkerConn } | { ok: false; problem: string }> {
  const key = agentKey(ag);
  const plan = planAcquire(poolInfo(), key, poolLimits(), Date.now());
  if (plan.kind === "reject") return { ok: false, problem: plan.problem };
  reapByIds(plan.reap);

  if (plan.kind === "reuse") {
    const e = entries.get(plan.connId);
    if (e) {
      e.state = "busy";
      e.taskId = taskId;
      e.lastUsedAt = Date.now();
      writeRecords();
      return { ok: true, conn: e.conn };
    }
    // 理论上到不了（plan 与 entries 之间没有 await）；真到了就当真·spawn 处理，宁可多起一个也不假装拿到了
  }

  const conn = createConn(ag, () => {
    const e = entries.get(conn.id);
    if (e) {
      e.spawnedAt = Date.now();
      writeRecords(); // 进程刚起来就落记录（握手之前），`wemind stop` 才来得及抓到它
    }
  });
  const entry: Entry = {
    conn,
    key,
    state: "busy",
    lastUsedAt: Date.now(),
    spawnedAt: Date.now(),
    ...(taskId !== undefined ? { taskId } : {}),
  };
  entries.set(conn.id, entry); // 先登记：并发的第二个 acquire 立刻能看到它（busy）
  try {
    await conn.warm();
    writeRecords();
    return { ok: true, conn };
  } catch (e) {
    entries.delete(conn.id);
    conn.kill();
    writeRecords();
    const why = e instanceof Error ? e.message : String(e);
    return { ok: false, problem: `起 worker 进程失败（${ag.name}）：${why}` };
  }
}

/** 任务结束：把连接还给进程池（置空闲）并按策略回收多余/过期的空闲连接；连接已经死了就地清掉。 */
export function release(conn: WorkerConn, limits: PoolLimits = poolLimits()): void {
  const e = entries.get(conn.id);
  if (!e) return;
  if (!conn.isAlive()) {
    entries.delete(conn.id); // 进程已死（任务中途被停/崩溃）：没有可复用的东西，别在池里留空壳
    writeRecords();
    return;
  }
  e.state = "idle";
  delete e.taskId;
  e.lastUsedAt = Date.now();
  reapByIds(planReap(poolInfo(), limits, Date.now(), conn.id));
  writeRecords();
}

/** 定时清扫（index.ts 起 interval）：清掉已死的空壳 + 处理「空闲过期/超编」，不动 busy。 */
export function sweep(limits: PoolLimits = poolLimits()): void {
  let changed = false;
  for (const [id, e] of entries) {
    if (e.conn.isAlive()) continue;
    entries.delete(id);
    changed = true;
  }
  const reap = planReap(poolInfo(), limits, Date.now());
  if (changed || reap.length) {
    reapByIds(reap);
    writeRecords();
  }
}

/**
 * 杀掉池里**全部**连接——只给「daemon 退出」用（`task-manager.ts` 的 `shutdownTasks()`，由 `wemind stop` / 进程退出触发）。
 * 结束单条任务**不经过这里**：那条路走 `task-manager.ts` 的「等回复的 `release()` 留着复用 / 正在跑的 `drop()` 杀一条」。
 */
export function killAll(): void {
  for (const e of entries.values()) e.conn.kill();
  entries.clear();
  writePidRecords(WORKERS_PID_FILE, []);
}

/** 弃用某条连接（任务被停时正在跑的那条）：杀进程 + 从池里摘掉。 */
export function drop(conn: WorkerConn): void {
  conn.kill();
  if (entries.delete(conn.id)) writeRecords();
}

/** 只回收空闲连接（有任务在跑时用）。 */
export function killIdle(): void {
  let changed = false;
  for (const [id, e] of entries) {
    if (e.state !== "idle") continue;
    e.conn.kill();
    entries.delete(id);
    changed = true;
  }
  if (changed) writeRecords();
}

/** 池状态摘要：给 `wemind list` / 微信 `AI` 展示「哪些 agent 有几条忙/闲」。 */
export function poolSummary(): Array<{
  agent: string;
  busy: number;
  idle: number;
  taskIds: number[];
}> {
  const byAgent = new Map<string, { busy: number; idle: number; taskIds: number[] }>();
  for (const e of entries.values()) {
    if (!e.conn.isAlive()) continue;
    let s = byAgent.get(e.conn.agent.name);
    if (!s) {
      s = { busy: 0, idle: 0, taskIds: [] };
      byAgent.set(e.conn.agent.name, s);
    }
    if (e.state === "busy") {
      s.busy += 1;
      if (e.taskId !== undefined) s.taskIds.push(e.taskId);
    } else s.idle += 1;
  }
  return [...byAgent.entries()].map(([agent, s]) => ({ agent, ...s }));
}

/** 某条任务当前用的连接（任务表与池的桥）。 */
export function connOfTask(taskId: number): WorkerConn | null {
  for (const e of entries.values()) if (e.taskId === taskId) return e.conn;
  return null;
}

/** 测试用：清空池（默认连进程一起杀）。 */
export function resetPoolForTest(kill = true): void {
  if (kill) for (const e of entries.values()) e.conn.kill();
  entries.clear();
  writePidRecords(WORKERS_PID_FILE, []);
}
