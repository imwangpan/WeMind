import fs from "node:fs";
import path from "node:path";

import { brainPidMarkers } from "./proc-identity.js";
import type { ResolvedAgent } from "./brain-agents.js";

/**
 * ACP 进程的「身份记录」文件（`brain.pid` / `workers.pid.json`）。
 *
 * 为什么从裸 pid 改成 JSON 记录：裸 pid 只说明「有个进程活着」，说明不了「它是不是我们起的、用的是哪个 agent」。
 * `manage.ts` 过去用**配置里**的 agent 算进程特征串（bin+args）来判定/杀进程，这在三种情况下会失效：
 *  ① `wemind brain set X` 之后（配置已变、还跑着旧 agent 的进程）；
 *  ② 热切换大脑的窗口内；
 *  ③ **多任务/多 agent 并存**时，live worker 永远不等于单个配置值（多 worker 之后这是常态）。
 * 于是把「起进程时**真实用的** bin/args」写进记录，`manage.ts` 直接按记录算特征串，不再猜。
 *
 * 兼容：旧文件是裸整数（`12345`）→ 读成一条 `legacy: true` 的记录（无 bin/args），
 * 调用方回退到「按配置算特征串」的旧行为；旧版 CLI 读新文件会拿到 NaN → 显示「已停止」且**不杀**（安全侧，记 CHANGELOG）。
 */

export type PidState = "busy" | "idle";

export type PidRecord = {
  pid: number;
  /** 预设名。 */
  agent: string;
  /** 起进程时真实用的二进制与参数（算特征串用）。 */
  bin: string;
  args: string[];
  shell: boolean;
  /** 任务 worker 专有：当前执行的任务编号。 */
  taskId?: number;
  /** 池中状态（worker）；brain 恒为 busy。 */
  state: PidState;
  startedAt: number;
  /** 最近一次写盘时间（状态变化时刷新）。 */
  writtenAt: number;
  /** 来自旧版「裸 pid」文件：没有 bin/args，判定需回退到配置。 */
  legacy?: boolean;
};

/** 读 pid 记录文件：兼容「裸整数」「单个 JSON 对象」「JSON 数组」三种形态；读不到/损坏 → 空数组。 */
export function readPidRecords(file: string): PidRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8").trim();
  } catch {
    return [];
  }
  if (!raw) return [];
  if (/^\d+$/.test(raw)) {
    const pid = Number(raw);
    return pid > 0
      ? [
          {
            pid,
            agent: "",
            bin: "",
            args: [],
            shell: false,
            state: "busy",
            startedAt: 0,
            writtenAt: 0,
            legacy: true,
          },
        ]
      : [];
  }
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray(j) ? j : [j];
  const out: PidRecord[] = [];
  for (const e of arr as Array<Record<string, unknown>>) {
    const pid = Number(e?.pid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const rec: PidRecord = {
      pid,
      agent: typeof e.agent === "string" ? e.agent : "",
      bin: typeof e.bin === "string" ? e.bin : "",
      args: Array.isArray(e.args)
        ? (e.args as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
      shell: e.shell === true,
      state: e.state === "idle" ? "idle" : "busy",
      startedAt: Number(e.startedAt) || 0,
      writtenAt: Number(e.writtenAt) || 0,
    };
    const tid = Number(e.taskId);
    if (Number.isInteger(tid) && tid > 0) rec.taskId = tid;
    out.push(rec);
  }
  return out;
}

/** 原子写记录文件；空数组 = 没有进程 = 删除文件。单条写对象、多条写数组（读侧都认）。 */
export function writePidRecords(file: string, recs: PidRecord[]): void {
  try {
    if (!recs.length) {
      fs.unlinkSync(file);
      return;
    }
  } catch {
    /* 文件不存在 → 继续写 */
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const body = recs.length === 1 ? recs[0] : recs;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort：记录写失败不该影响起进程 */
  }
}

/** 由「刚 spawn 出来的 agent」构造一条记录。 */
export function pidRecordOf(
  pid: number,
  ag: Pick<ResolvedAgent, "name" | "bin" | "args" | "shell">,
  extra: { taskId?: number; state?: PidState } = {},
): PidRecord {
  const now = Date.now();
  const rec: PidRecord = {
    pid,
    agent: ag.name,
    bin: ag.bin,
    args: ag.args,
    shell: ag.shell,
    state: extra.state ?? "busy",
    startedAt: now,
    writtenAt: now,
  };
  if (extra.taskId !== undefined) rec.taskId = extra.taskId;
  return rec;
}

/** 记录对应的进程特征串；`legacy`（无 bin）→ 空数组，调用方回退配置。 */
export function recordMarkers(rec: PidRecord): string[][] {
  return rec.bin ? brainPidMarkers(rec.bin, rec.args) : [];
}
