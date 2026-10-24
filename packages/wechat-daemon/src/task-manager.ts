import { askWorker, stopWorker, setWorkerCwd, type WorkerProgressEvent } from "./worker-acp.js";

const log = (...a: unknown[]) => console.error("[wemind/wechat-daemon/task]", ...a);

type TaskStatus = "running" | "waiting";
type ActiveTask = {
  to: string;
  status: TaskStatus;
  injectResolver?: (text: string | null) => void; // waiting 态等待注入；stop 时 resolve(null) 退出
  pendingInjects?: string[]; // running 期间暂存的注入（下次 waiting 一并消费，按序累积不覆盖）
  startedAt: number; // 派发时间
  turns: number; // 已完成轮次
  lastOutput?: string; // 最近一轮推送内容（供本地 task-status 查看）
};

let activeTask: ActiveTask | null = null;

// 依赖注入：把「推送文本给用户」交给 index 提供（内部走 sendOrdered + 最新 token），避免 task-manager 直接依赖发送层/account。
type PushFn = (to: string, text: string) => void;
let push: PushFn = () => {};
export function setTaskPush(fn: PushFn): void {
  push = fn;
}

// 依赖注入：发「正在输入中」（typing 不占连续发送上限），让 worker 跑一轮期间用户知道在干活。
let typing: (to: string) => void = () => {};
export function setTaskTyping(fn: (to: string) => void): void {
  typing = fn;
}

/** 任务状态快照（落盘供本地 `task-status` 读）。 */
export type TaskStateSnapshot = {
  active: boolean;
  status: TaskStatus | "idle";
  to?: string;
  startedAt?: number;
  updatedAt: number;
  turns: number;
  lastOutput?: string;
};
// 依赖注入：把状态快照落盘交给 index（写 task-state.json），task-manager 不直接碰文件、保持可测。
let stateSink: (s: TaskStateSnapshot) => void = () => {};
export function setTaskStateSink(fn: (s: TaskStateSnapshot) => void): void {
  stateSink = fn;
}
/** 用当前 activeTask 构造快照并落盘（在派发/每轮/waiting/停止等关键节点调用）。 */
function emitState(): void {
  const t = activeTask;
  const snap: TaskStateSnapshot = t
    ? {
        active: true,
        status: t.status,
        to: t.to,
        startedAt: t.startedAt,
        updatedAt: Date.now(),
        turns: t.turns,
        lastOutput: t.lastOutput,
      }
    : { active: false, status: "idle", updatedAt: Date.now(), turns: 0 };
  try {
    stateSink(snap);
  } catch {
    /* best-effort */
  }
}

const PROGRESS = (process.env.WEMIND_WORKER_PROGRESS ?? "0") === "1"; // 默认安静：只在轮次结束/中断推送

/** 是否存在活跃任务（可选限定某用户）。 */
export function hasActiveTask(to?: string): boolean {
  return !!activeTask && (to === undefined || activeTask.to === to);
}

/** worker 是否正等该用户回复（waiting 态）。路由用：仅此时「无前缀」消息才默认注入 worker。 */
export function isAwaiting(to: string): boolean {
  return !!activeTask && activeTask.to === to && activeTask.status === "waiting";
}

/** 派发新任务（后台异步执行，立即返回回执文案，不阻塞调用方）。 */
export function dispatchTask(to: string, instruction: string, cwd?: string): string {
  if (activeTask) return "已有任务在跑，先回复「结束任务」再派发新任务。";
  setWorkerCwd(cwd); // 本地派发可指定 cwd（终端当前目录）；微信派发 cwd=undefined → 用默认 WORKER_CWD
  void runTask(to, instruction);
  return "✅ 已派给工作机执行（任务运行中）。需要你决策或中断时我会主动找你；随时可回复「结束任务」终止。";
}

/** 注入用户消息：waiting → 直接喂下一轮；running → 暂存为 pendingInject。 */
export function injectTask(to: string, text: string): void {
  if (!activeTask || activeTask.to !== to) return;
  if (activeTask.status === "waiting" && activeTask.injectResolver) {
    const r = activeTask.injectResolver;
    activeTask.injectResolver = undefined;
    r(text);
  } else {
    (activeTask.pendingInjects ??= []).push(text); // running 期间：按序累积，等这一步跑完一并处理（不覆盖前一条）
    push(to, "📝 已记下，等当前这步跑完就处理。");
  }
}

/** 结束任务：停 worker、清状态、唤醒退出循环。 */
export function stopTask(to: string): string {
  if (!activeTask || activeTask.to !== to) return "当前没有正在运行的任务。";
  const task = activeTask;
  activeTask = null; // 先清，runTask 循环靠它感知被 stop
  if (task.injectResolver) {
    const r = task.injectResolver;
    task.injectResolver = undefined;
    r(null);
  }
  stopWorker();
  emitState(); // → idle
  return "🛑 任务已结束。";
}

/** 等待用户注入（waiting 态）；若有暂存的 pendingInject 直接消费。 */
function waitForInject(task: ActiveTask): Promise<string | null> {
  if (task.pendingInjects?.length) {
    const t = task.pendingInjects.join("\n"); // 多条暂存按序合并喂下一轮，一条不丢
    task.pendingInjects = undefined;
    return Promise.resolve(t);
  }
  return new Promise((resolve) => {
    task.injectResolver = resolve;
  });
}

function reason(e: unknown): string {
  const s = String(e instanceof Error ? e.message : e);
  if (/no-first-frame|idle|cap|timeout/i.test(s)) return "超时/卡住";
  return "执行出错";
}

/** 后台任务循环：每轮 askWorker → 推送本轮输出 → 等注入 → 续跑。绝不在 workerLoop 里 await 它。 */
async function runTask(to: string, firstInstruction: string): Promise<void> {
  activeTask = { to, status: "running", startedAt: Date.now(), turns: 0 };
  emitState();
  let instruction: string | null = firstInstruction;
  while (activeTask && instruction !== null) {
    typing(to); // 立即一次「正在输入」
    const ti = setInterval(() => typing(to), 5000); // 每 5s 续命（小于客户端 typing 自动过期，防闪烁；不占连续发送上限），表明 worker 在干活
    try {
      const onProgress = PROGRESS
        ? (ev: WorkerProgressEvent) => {
            if (ev.type === "tool") push(to, "🔧 worker 正在调用工具…");
          }
        : undefined;
      const out = await askWorker(instruction, onProgress);
      if (!activeTask) break; // 期间被 stop
      const text = `🤖【任务】${out || "（本轮无输出，可回复「继续」推进或「结束任务」终止）"}`;
      activeTask.turns += 1;
      activeTask.lastOutput = text;
      push(to, text);
    } catch (e) {
      if (!activeTask) break; // 被 stop 导致的 reject，不算中断
      log("worker turn failed:", String(e));
      const text = `⚠️ 任务中断了（${reason(e)}）。回复「继续」我从中断处恢复，或「结束任务」终止。`;
      activeTask.lastOutput = text;
      push(to, text);
    } finally {
      clearInterval(ti); // 本轮结束停 typing
    }
    if (!activeTask) break;
    activeTask.status = "waiting";
    emitState(); // → waiting（task-status 可见「等你回复」）
    instruction = await waitForInject(activeTask); // null = stop
    if (activeTask) {
      activeTask.status = "running";
      emitState();
    }
  }
  emitState(); // 循环结束（多为 idle）
  log("runTask loop ended");
}
