import fs from "node:fs";
import path from "node:path";

/**
 * 任务收件箱的文件协议（CLI ↔ daemon）：**收命令通道**（`task-inbox/`）与**回结果通道**（`task-out/`）。
 *
 * 为什么要有回结果通道：`wemind task` / `task-reply` / `task-stop` 原先只是把命令丢进收件箱就返回，
 * 于是它们只能靠轮询 `task-state.json` 猜结果——「达上限被拒绝派发」会被报成「已派发」，
 * 甚至报成**上一条**任务的编号（`active` 本来就是 true），「回复不存在的编号」也会被报成「已发送」。
 * 回结果通道让 daemon 把**真实结果**写回来，CLI 打印的就是 daemon 的那句话。
 *
 * 兼容：老 daemon 不认这条通道（不会写答复），CLI 等不到就退回原来的「已发送」措辞并说明一句，
 * 而不是把「没等到」当成「成功了」。
 */

export const TASK_INBOX_DIRNAME = "task-inbox";
export const TASK_OUT_DIRNAME = "task-out";

export type TaskAck = { id: string; at: number; ok: boolean; text: string };

export const taskInboxDir = (base: string): string => path.join(base, TASK_INBOX_DIRNAME);
export const taskOutDir = (base: string): string => path.join(base, TASK_OUT_DIRNAME);

/** 原子写（临时文件 + rename）：daemon 扫目录时不会读到半截 JSON。 */
function atomicWriteJson(fp: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
  fs.renameSync(tmp, fp);
}

/**
 * 写一条命令进收件箱，返回它的答复编号（同时写进 `ack` 字段；老 daemon 忽略这个字段）。
 * 文件名用同一个 id：带时间戳前缀，daemon 按名字排序即按时间排序。
 */
export function writeTaskCmd(base: string, obj: Record<string, unknown>): string {
  // id 与 ts 取同一次 Date.now()：分两次取时一旦跨毫秒边界，id 的时间戳前缀就与 ts 对不上（「按名排序即按时间排序」依赖它）。
  const ts = Date.now();
  const id = `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  atomicWriteJson(path.join(taskInboxDir(base), `${id}.json`), { ...obj, ack: id, ts });
  return id;
}

/** daemon 侧：把一条命令的结果写回去（CLI 正在短轮询它）。写失败不影响命令本身。 */
export function writeTaskAck(base: string, id: string | undefined, text: string): void {
  if (!id) return;
  try {
    atomicWriteJson(path.join(taskOutDir(base), `${id}.json`), {
      id,
      at: Date.now(),
      ok: !text.startsWith("❌"),
      text,
    });
  } catch {
    /* 答复写不进去不该影响命令本身（CLI 会回退到「已发送」措辞） */
  }
}

/** CLI 侧：等这次命令的答复（读到即删，目录不留垃圾）。超时返回 null。 */
export async function awaitTaskAck(
  base: string,
  id: string,
  timeoutMs = 8000,
  pollMs = 150,
): Promise<TaskAck | null> {
  const fp = path.join(taskOutDir(base), `${id}.json`);
  const t0 = Date.now();
  for (;;) {
    try {
      const a = JSON.parse(fs.readFileSync(fp, "utf-8")) as TaskAck;
      fs.unlinkSync(fp);
      if (a?.id === id && typeof a.text === "string") return a;
    } catch {
      /* 还没到 */
    }
    if (Date.now() - t0 >= timeoutMs) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** 启动 / 收尾清理：作废上一条命令的残留（防重放），两个通道一起清。 */
export function clearTaskDirs(base: string): void {
  for (const d of [taskInboxDir(base), taskOutDir(base)]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  try {
    fs.mkdirSync(taskInboxDir(base), { recursive: true });
  } catch {
    /* ignore */
  }
}
