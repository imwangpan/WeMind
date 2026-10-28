import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

/**
 * 任务表落盘（`tasks.json`）：只为「daemon 重启后能续跑」这一件事，不做历史归档
 * （微信聊天记录本身就是每条任务输出的归档，另存历史收益低、维护面大）。
 *
 * 三条设计约束：
 *  - **编号跨重启不归零**：`nextId` 按用户单调递增、只增不减，重启后接着排（否则「任务2」在对话里会指代漂移）；
 *  - **不自动恢复**：重启后未完成的任务一律标 `interrupted`，只在 `任务列表` 可见；用户回「继续」/`#n 继续` 才拉进程续跑
 *    （3 个 agent 一起冷启动既重、也可能正好复现刚崩的原因）；
 *  - **损坏不阻塞启动**：读失败降级为空表（只记日志）——任务表坏了顶多「列表空」，绝不能让 daemon 起不来。
 */

export const TASK_STORE_VERSION = 1;

export type StoredTaskStatus = "running" | "waiting" | "interrupted";

export type StoredTask = {
  id: number;
  userId: string;
  agent: string;
  /** 会话键（`task-<id>@<userId>`）：worker-sessions.json 里 `<agent>:<key>` 指向的 sessionId。 */
  key: string;
  status: StoredTaskStatus;
  turns: number;
  startedAt: number;
  lastOutput?: string;
  /** 任务工作目录（本地派发可指定；续跑要还原成同一个 cwd）。 */
  cwd?: string;
};

export type TaskStore = {
  version: number;
  tasks: StoredTask[];
  /** 按用户的「下一个编号」：只增，永不复用，跨重启连续。 */
  nextId: Record<string, number>;
};

export function taskStorePath(dir: string = DATA_DIR): string {
  return path.join(dir, "tasks.json");
}

export function emptyTaskStore(): TaskStore {
  return { version: TASK_STORE_VERSION, tasks: [], nextId: {} };
}

/** 读任务表：缺文件/坏 JSON/字段离谱 → 空表（降级，不抛）。 */
export function loadTaskStore(dir: string = DATA_DIR): TaskStore {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(taskStorePath(dir), "utf-8"));
  } catch {
    return emptyTaskStore();
  }
  const j = raw as Record<string, unknown> | null;
  if (!j || typeof j !== "object" || Array.isArray(j)) return emptyTaskStore();
  const tasks: StoredTask[] = [];
  if (Array.isArray(j.tasks)) {
    for (const e of j.tasks as Array<Record<string, unknown>>) {
      const id = Number(e?.id);
      const userId = typeof e?.userId === "string" ? e.userId : "";
      if (!Number.isInteger(id) || id <= 0 || !userId) continue;
      const status: StoredTaskStatus =
        e.status === "running" || e.status === "waiting" ? e.status : "interrupted";
      const t: StoredTask = {
        id,
        userId,
        agent: typeof e.agent === "string" ? e.agent : "",
        key: typeof e.key === "string" ? e.key : `task-${id}@${userId}`,
        status,
        turns: Number(e.turns) || 0,
        startedAt: Number(e.startedAt) || 0,
      };
      if (typeof e.lastOutput === "string") t.lastOutput = e.lastOutput;
      if (typeof e.cwd === "string" && e.cwd) t.cwd = e.cwd;
      tasks.push(t);
    }
  }
  const nextId: Record<string, number> = {};
  const rawNext = (j.nextId ?? {}) as Record<string, unknown>;
  if (rawNext && typeof rawNext === "object" && !Array.isArray(rawNext)) {
    for (const [k, v] of Object.entries(rawNext)) {
      const n = Number(v);
      if (Number.isInteger(n) && n > 0) nextId[k] = n;
    }
  }
  // 表里的编号也要算进 nextId：手改过/半截文件时不会发号撞车
  for (const t of tasks) nextId[t.userId] = Math.max(nextId[t.userId] ?? 1, t.id + 1);
  return { version: TASK_STORE_VERSION, tasks, nextId };
}

/** 原子写（临时文件 + rename）：daemon 可能随时被杀，别留半截表。 */
export function saveTaskStore(store: TaskStore, dir: string = DATA_DIR): void {
  const file = taskStorePath(dir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort：任务表写失败不该影响任务本身 */
  }
}

/** 重启后：未完成的任务一律标「已中断」（返回被标的那些，调用方据此记日志/展示）。 */
export function markInterrupted(store: TaskStore): StoredTask[] {
  const hit: StoredTask[] = [];
  for (const t of store.tasks) {
    if (t.status === "running" || t.status === "waiting") {
      t.status = "interrupted";
      hit.push(t);
    }
  }
  return hit;
}

/** 发号：按用户单调递增，不复用（返回新编号并推进 nextId）。 */
export function takeNextId(store: TaskStore, userId: string): number {
  const n = store.nextId[userId] ?? 1;
  store.nextId[userId] = n + 1;
  return n;
}

export function upsertTask(store: TaskStore, task: StoredTask): void {
  const i = store.tasks.findIndex((t) => t.id === task.id);
  if (i >= 0) store.tasks[i] = task;
  else store.tasks.push(task);
}

export function removeTask(store: TaskStore, id: number): boolean {
  const i = store.tasks.findIndex((t) => t.id === id);
  if (i < 0) return false;
  store.tasks.splice(i, 1);
  return true;
}
