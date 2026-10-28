import { DATA_DIR } from "@wemind/wechat-ilink-core";

import { getAgent } from "./agent-slot.js";
import { agentConfigFor, loadBrainConfig } from "./brain-config.js";
import { resolvePresetByName, type ResolvedAgent } from "./brain-agents.js";
import { acquire, drop, release, killAll, poolSummary } from "./worker-pool.js";
import type { WorkerConn, WorkerProgressEvent } from "./worker-acp.js";
import {
  emptyTaskStore,
  loadTaskStore,
  markInterrupted,
  removeTask as removeStoredTask,
  saveTaskStore,
  takeNextId,
  type StoredTask,
  type TaskStore,
  type StoredTaskStatus,
} from "./task-store.js";

/**
 * 任务表：**一条任务一条 worker 连接**，多条任务并行；编号按用户单调递增、永不复用（避免「任务2」在对话里指代漂移）。
 *
 * 与改造前的差别（单任务单例 → 任务表）：
 *  - 派发时决定 agent（默认任务大脑，或 `任务 <预设>：正文` 指定）；每条任务一个 session key `task-<编号>@<userId>`；
 *  - 任务结束（`结束任务`）把连接**还回进程池**（同 agent 的下个任务直接复用），而不是杀掉；
 *  - 任务表落盘（tasks.json）：daemon 重启后未完成的标「已中断」并在「任务列表」可见，回「继续」/`#n 继续` 才拉进程续跑；
 *  - 编号跨重启不归零（nextId 存在表里，只增不减）。
 *
 * 依赖注入（push/typing/stateSink）保持不变：task-manager 不直接依赖发送层与 account，保持可测。
 */

const log = (...a: unknown[]) => console.error("[wemind/wechat-daemon/task]", ...a);

export type TaskStatus = StoredTaskStatus;

export type Task = {
  id: number;
  userId: string;
  /** 预设名（落盘这个；恢复时按名字重新解析，可能已经换了二进制或不可用）。 */
  agent: string;
  /** 会话键：`task-<编号>@<userId>`（worker-sessions.json 里 `<agent>:<key>`）。 */
  key: string;
  status: TaskStatus;
  turns: number;
  startedAt: number;
  lastOutput?: string;
  cwd?: string;
  /** 本次运行解析出的 agent（interrupted 任务在恢复前没有）。 */
  ag?: ResolvedAgent;
  conn?: WorkerConn;
  /** 本地命令（`wemind task`）等着的回执 id：起进程有结果了才回，见 `setTaskAckSink`。 */
  ackId?: string;
  /** 回执里要不要带编号（带 `--agent`/`--cwd` 或已有别的任务时带）。 */
  numbered?: boolean;
  /** 下一轮是「从中断处续跑」：会话恢复失败要诚实报错，不能静默换空会话。 */
  strictResume?: boolean;
  pendingInjects?: string[];
  injectResolver?: (text: string | null) => void;
};

/** 依赖注入：把「推送文本给用户」交给 index 提供（内部走 sendOrdered + 最新 token）。 */
type PushFn = (to: string, text: string) => void;
let push: PushFn = () => {};
export function setTaskPush(fn: PushFn): void {
  push = fn;
}

/** 依赖注入：发「正在输入中」（typing 不占连续发送上限），让用户知道任务在干活。 */
let typing: (to: string) => void = () => {};
export function setTaskTyping(fn: (to: string) => void): void {
  typing = fn;
}

/**
 * 依赖注入：回执出口（CLI 写 `task-out/<id>.json`）。
 *
 * 只在「本地命令问结果」时用到：`wemind task` 这类命令丢完命令就只能猜，
 * 猜出来的「已派发」在池满被拒时会变成假消息。派发的回执**必须等起进程有结果**再回——
 * 池满/agent 起不来都是 acquire 阶段才知道的（dispatchTask 当场返回时还不知道）。
 */
let ack: (id: string, text: string) => void = () => {};
export function setTaskAckSink(fn: (id: string, text: string) => void): void {
  ack = fn;
}
/**
 * 发一条回执（没有 id / 没有出口就当没这回事）。
 *
 * **空文案也照发**：它是「命令已送达、没有额外要说的」这个信号——CLI 收到它就能立刻用自己那句话，
 * 而不是干等到超时才敢打印（超时是留给「老版 daemon 不认这条腿」的）。
 */
function ackIf(id: string | undefined, text: string): void {
  if (!id) return;
  try {
    ack(id, text);
  } catch {
    /* ignore */
  }
}

/** 任务状态快照（落盘 task-state.json 供本地 `task-status` 读；顶层字段镜像「最近一条」，旧版 CLI 仍能显示）。 */
export type TaskStateSnapshot = {
  active: boolean;
  status: TaskStatus | "idle";
  to?: string;
  startedAt?: number;
  updatedAt: number;
  turns: number;
  lastOutput?: string;
  tasks: Array<{
    id: number;
    userId: string;
    agent: string;
    status: TaskStatus;
    turns: number;
    startedAt: number;
    lastOutput?: string;
  }>;
};
let stateSink: (s: TaskStateSnapshot) => void = () => {};
export function setTaskStateSink(fn: (s: TaskStateSnapshot) => void): void {
  stateSink = fn;
}

const tasks = new Map<number, Task>();
let store: TaskStore = emptyTaskStore();
let storeDir = DATA_DIR;

/** 写盘时机：派发/每轮结束/waiting/停止（表很小，写多了也没关系；丢了才会真的影响续跑）。 */
function persist(): void {
  store.tasks = [...tasks.values()].map((t) => {
    const s: StoredTask = {
      id: t.id,
      userId: t.userId,
      agent: t.agent,
      key: t.key,
      status: t.status,
      turns: t.turns,
      startedAt: t.startedAt,
    };
    if (t.lastOutput !== undefined) s.lastOutput = t.lastOutput;
    if (t.cwd) s.cwd = t.cwd;
    return s;
  });
  saveTaskStore(store, storeDir);
}

function emitState(): void {
  const live = [...tasks.values()].filter((t) => t.status !== "interrupted");
  const primary = live.sort((a, b) => b.startedAt - a.startedAt)[0];
  const snap: TaskStateSnapshot = {
    active: !!primary,
    status: primary?.status ?? "idle",
    updatedAt: Date.now(),
    turns: primary?.turns ?? 0,
    tasks: [...tasks.values()]
      .sort((a, b) => a.id - b.id)
      .map((t) => {
        const e: TaskStateSnapshot["tasks"][number] = {
          id: t.id,
          userId: t.userId,
          agent: t.agent,
          status: t.status,
          turns: t.turns,
          startedAt: t.startedAt,
        };
        if (t.lastOutput !== undefined) e.lastOutput = t.lastOutput;
        return e;
      }),
  };
  if (primary) {
    snap.to = primary.userId;
    snap.startedAt = primary.startedAt;
    if (primary.lastOutput !== undefined) snap.lastOutput = primary.lastOutput;
  }
  try {
    stateSink(snap);
  } catch {
    /* best-effort */
  }
}

const PROGRESS = (process.env.WEMIND_WORKER_PROGRESS ?? "0") === "1"; // 默认安静：只在轮次结束/中断推送

/** 启动时读回任务表：未完成的标「已中断」（**不自动恢复**），编号接着排。 */
export function initTasks(dir: string = DATA_DIR): { interrupted: number[] } {
  storeDir = dir;
  store = loadTaskStore(dir);
  const hit = markInterrupted(store);
  saveTaskStore(store, dir);
  tasks.clear();
  for (const t of store.tasks) tasks.set(t.id, { ...t });
  if (hit.length)
    log(
      `重启：${hit.length} 条未完成任务标记为「已中断」（编号 ${hit.map((t) => t.id).join("、")}；回「继续」可续跑）`,
    );
  emitState();
  return { interrupted: hit.map((t) => t.id) };
}

// ---- 查询 ----
const isLive = (t: Task): boolean => t.status === "running" || t.status === "waiting";
export const liveTasks = (userId: string): Task[] =>
  [...tasks.values()].filter((t) => t.userId === userId && isLive(t)).sort((a, b) => a.id - b.id);
export const awaitingTasks = (userId: string): Task[] =>
  liveTasks(userId).filter((t) => t.status === "waiting");
export const interruptedTasks = (userId: string): Task[] =>
  [...tasks.values()]
    .filter((t) => t.userId === userId && t.status === "interrupted")
    .sort((a, b) => a.id - b.id);
export const listTasks = (userId: string): Task[] =>
  [...tasks.values()].filter((t) => t.userId === userId).sort((a, b) => a.id - b.id);

/**
 * 像不像「继续跑」这句话。
 *
 * 只在一处用到：daemon 重启后留下的「已中断」任务，在没有活跃任务时要把无前缀消息放行进任务表（`injectTask` → `resumeTask`）。
 * 关键字这层闸不能省：中断任务会一直躺在表里，若见了任何消息都放行，一句「帮我查一下 X」会把陈旧的它唤醒。
 * 单条任务时 `#n 继续` 也走这条路（显式编号那条分支在解析层就分流了）。
 */
export function looksLikeResume(text: string | undefined): boolean {
  return /^(?:继续|接着|接着跑|继续跑|续跑|继续吧|continue|go\s*on)[。.!！]?$/i.test(
    (text ?? "").trim(),
  );
}
/** 是否存在活跃任务（可选限定某用户）。 */
export function hasActiveTask(to?: string): boolean {
  return to === undefined ? [...tasks.values()].some(isLive) : liveTasks(to).length > 0;
}
/** 池状态摘要（`AI`/`wemind list` 展示用）。 */
export const taskPoolSummary = poolSummary;

function since(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  running: "运行中",
  waiting: "等你回复",
  interrupted: "已中断",
};

/** 任务标签：多条任务时带编号（单任务免编号，延续改造前的顺手）。 */
function labelOf(task: Task): string {
  return listTasks(task.userId).length > 1 || liveTasks(task.userId).length > 1
    ? `任务${task.id}`
    : "任务";
}

/** `任务列表`：编号 / agent / 状态 / 轮次 / 已运行 / 最近输出摘要。 */
export function renderTaskList(userId: string): string {
  const all = listTasks(userId);
  if (!all.length) return "📋 当前没有任务。派发：直接发「任务：正文」或「任务 <预设>：正文」。";
  const lines = [`📋 任务（${all.length} 条）`];
  for (const t of all) {
    const age = t.startedAt ? since(Date.now() - t.startedAt) : "?";
    lines.push(
      `#${t.id} [${t.agent}] ${STATUS_LABEL[t.status]} · ${t.turns} 轮 · ${age}${t.cwd ? ` · cwd=${t.cwd}` : ""}`,
    );
    if (t.lastOutput) lines.push(`   最近输出：${t.lastOutput.replace(/\n/g, " ").slice(0, 120)}`);
  }
  const live = all.filter(isLive);
  if (live.length > 1)
    lines.push(`多条任务并行：回话用「#<编号> 正文」，结束用「结束任务 <编号>」。`);
  const intr = all.filter((t) => t.status === "interrupted");
  if (intr.length)
    lines.push(
      `已中断的任务回「继续」（或「#${intr[0].id} 继续」）可续跑——注意上一步可能已经改过文件，核对后再继续。`,
    );
  return lines.join("\n");
}

// ---- 派发与续跑 ----
/**
 * 回执文案：单任务（且没指定 agent、没指定 cwd）沿用改造前那句话——最常见路径不该变得啰嗦；
 * 其余情况（指定了 agent / 已经有多条任务 / 本地派发）带上编号，因为这时编号才有用。
 */
function ackFor(task: Task, numbered: boolean): string {
  if (!numbered)
    return "✅ 已派给工作机执行（任务运行中）。需要你决策或中断时我会主动找你；随时可回复「结束任务」终止。";
  return `✅ 已派发任务 #${task.id}（${task.agent} 执行）。看进展发「任务列表」，回话发「#${task.id} 正文」，收掉发「结束任务 ${task.id}」。`;
}

/** 解析「本任务用哪个 agent」：显式预设名优先，否则默认任务大脑。 */
function resolveTaskAgent(
  agentKey?: string,
): { ok: true; ag: ResolvedAgent } | { ok: false; problem: string } {
  if (!agentKey) return { ok: true, ag: getAgent("worker") };
  const cfg = loadBrainConfig(storeDir);
  const r = resolvePresetByName(agentKey, agentConfigFor(cfg, "worker") ?? cfg);
  return r.ok ? { ok: true, ag: r.agent } : { ok: false, problem: r.problem };
}

/**
 * 派发新任务（后台异步执行，立即返回回执文案，不阻塞调用方）。
 * `agentKey`：`任务 <预设>：正文` 指定的 agent；`cwd`：本地派发指定的任务工作目录。
 * `ackId` 给了就等起进程有结果再回执（成功＝真回执文案，池满/起不来＝那句警告）。
 */
export function dispatchTask(
  to: string,
  instruction: string,
  opts: { cwd?: string; agentKey?: string; ackId?: string } = {},
): string {
  const text = (instruction ?? "").trim();
  if (!text) {
    const r = "要派发的任务正文是空的。";
    ackIf(opts.ackId, r);
    return r;
  }
  const got = resolveTaskAgent(opts.agentKey);
  if (!got.ok) {
    const r = `❌ 不能用「${opts.agentKey}」跑任务：${got.problem}`;
    ackIf(opts.ackId, r);
    return r;
  }
  const numbered = !!opts.agentKey || !!opts.cwd || listTasks(to).length > 0;
  const id = takeNextId(store, to);
  const task: Task = {
    id,
    userId: to,
    agent: got.ag.name,
    key: taskKeyOf(id, to),
    status: "running",
    turns: 0,
    startedAt: 0, // 真正起进程时再定（起进程可能失败）
    ag: got.ag,
    numbered,
  };
  if (opts.cwd) task.cwd = opts.cwd;
  if (opts.ackId) task.ackId = opts.ackId;
  tasks.set(id, task);
  persist();
  emitState();
  void runTask(task, text);
  return ackFor(task, numbered);
}

/** 会话键：带用户，避免多用户的编号相撞。 */
export function taskKeyOf(id: number, userId: string): string {
  return `task-${id}@${userId}`;
}

function waitForInject(task: Task): Promise<string | null> {
  if (task.pendingInjects?.length) {
    const t = task.pendingInjects.join("\n"); // 多条暂存按序合并喂下一轮，一条不丢
    task.pendingInjects = undefined;
    return Promise.resolve(t);
  }
  return new Promise((resolve) => {
    task.injectResolver = resolve;
  });
}

/** 任务循环：每轮 ask → 推送本轮输出 → 等注入 → 续跑。绝不在 workerLoop 里 await 它。 */
async function runTask(task: Task, firstInstruction: string): Promise<void> {
  const ag = task.ag;
  if (!ag) {
    log(`task ${task.id} 没有 agent（内部错误）`);
    return;
  }
  task.status = "running";
  emitState();
  const got = await acquire(ag, task.id);
  if (!got.ok) {
    tasks.delete(task.id);
    persist();
    emitState();
    const msg = `⚠️ 任务 #${task.id} 没起得来：${got.problem}`;
    push(task.userId, msg);
    ackIf(task.ackId, msg); // 本地命令要的是「到底派上了没有」——这里才是答案
    return;
  }
  const conn = got.conn;
  task.conn = conn;
  conn.setCwd(task.cwd);
  if (!task.startedAt) task.startedAt = Date.now();
  persist();
  emitState();
  ackIf(task.ackId, ackFor(task, task.numbered === true)); // 起进程成功：这时才敢说「已派发」
  task.ackId = undefined;
  log(`task ${task.id} start agent=${ag.name} conn=${conn.id} cwd=${conn.effectiveCwd()}`);

  let instruction: string | null = firstInstruction;
  while (tasks.get(task.id) === task && instruction !== null) {
    typing(task.userId); // 立即一次「正在输入」
    const ti = setInterval(() => typing(task.userId), 5000); // 每 5s 续命（小于客户端 typing 自动过期，防闪烁；不占连发上限）
    let wasResume = false;
    try {
      const onProgress = PROGRESS
        ? (ev: WorkerProgressEvent) => {
            if (ev.type === "tool") push(task.userId, `🔧 ${labelOf(task)} 正在调用工具…`);
          }
        : undefined;
      wasResume = task.strictResume === true;
      task.strictResume = false;
      const out = await conn.ask(instruction, task.key, onProgress, { strictResume: wasResume });
      if (tasks.get(task.id) !== task) break; // 期间被 stop
      const label = labelOf(task);
      const body = out || "（本轮无输出，可回复「继续」推进或「结束任务」终止）";
      task.turns += 1;
      task.lastOutput = `🤖【${label}】${body}`;
      push(task.userId, task.lastOutput);
    } catch (e) {
      if (tasks.get(task.id) !== task) break; // 被 stop 导致的 reject，不算中断
      const why = String(e instanceof Error ? e.message : e);
      if (wasResume && why.includes("接不上")) {
        // 续跑失败（原会话接不上）：回到「已中断」并把话说清楚，而不是静默换一个空会话假装续上了。
        // 会话指针**保留**（收尾处按「任务是否还在表里」决定要不要清），用户重述进展后还能再试。
        task.status = "interrupted";
        persist();
        emitState();
        log(`task ${task.id} resume failed:`, why);
        push(task.userId, `⚠️ #${task.id} 号任务这次接不上：${why}`);
        break;
      }
      const label = labelOf(task);
      const resumeHint = label === "任务" ? "回复「继续」" : `回复「#${task.id} 继续」`;
      log(`task ${task.id} turn failed:`, why);
      task.lastOutput = `⚠️【${label}】中断了（${reason(e)}）。${resumeHint}我从中断处恢复，或「结束任务${label === "任务" ? "" : ` ${task.id}`}」终止。`;
      push(task.userId, task.lastOutput);
    } finally {
      clearInterval(ti); // 本轮结束停 typing
    }
    if (tasks.get(task.id) !== task) break;
    task.status = "waiting";
    persist();
    emitState(); // → waiting（task-list 可见「等你回复」）
    instruction = await waitForInject(task); // null = stop
    if (tasks.get(task.id) === task) {
      task.status = "running";
      persist();
      emitState();
    }
  }
  // 收尾：连接还回池（活着才有复用价值；被 stop 时可能已经死了，release 会就地清掉空壳）。
  // 会话指针只在「任务真的结束」（已被 stop、不在表里）时清掉：回到「已中断」的任务要留着它，用户重述进展后还能再试。
  if (task.conn === conn) {
    if (tasks.get(task.id) !== task) conn.dropSession(task.key);
    release(conn);
    task.conn = undefined;
  }
  emitState();
  log(`task ${task.id} loop ended`);
}

function reason(e: unknown): string {
  const s = String(e instanceof Error ? e.message : e);
  if (/no-first-frame|idle|cap|timeout/i.test(s)) return "超时/卡住";
  return "执行出错";
}

/** 续跑一条「已中断」的任务：按原 agent 拉进程 + session/load 恢复上下文，然后照常跑循环。 */
function resumeTask(task: Task, instruction: string): string {
  const got = resolveTaskAgent(task.agent);
  if (!got.ok) {
    // 返回而不是 push：微信侧一样会看到（injectTask 的返回值由调用方当回执发出去），CLI 侧则能拿到真话，
    // 否则「接不上」只进 daemon 日志、CLI 却报「已发送」。
    return `⚠️ 接不上 #${task.id} 号任务（原 agent「${task.agent}」现在用不了）：${got.problem}`;
  }
  task.ag = got.ag;
  task.strictResume = true; // 续跑要求「上下文真的接上」：恢复失败要报错，不能静默换空会话
  void runTask(
    task,
    `（这条任务在 daemon 重启时中断了，现在续跑；上下文按会话恢复。动手前先核对上一步是否已经产生副作用，避免重复。）\n${instruction}`,
  );
  return `⏳ 正在按 #${task.id} 号任务续跑（${got.ag.name}）。上一步可能已经改过文件或发过请求，核对时注意别重复动作。`;
}

/**
 * 注入用户消息。`id` 给定时只作用于那条任务；不给时：唯一一条 → 它；多条 → 回消歧提示（不猜）。
 * 返回要额外回复的文案（空字符串＝只推给了任务，不需要额外回执）。
 * `ackId`（本地命令）：非空返回文案也回一份给 CLI——「没有 #9 号任务」这种话不能只进 daemon 日志。
 */
export function injectTask(to: string, text: string, id?: number, ackId?: string): string {
  const done = (r: string): string => {
    ackIf(ackId, r);
    return r;
  };
  const live = liveTasks(to);
  const intr = interruptedTasks(to);
  const body = (text ?? "").trim();
  if (!body) return done("要回给任务的内容是空的。");

  let target: Task | undefined;
  if (id !== undefined) {
    target = tasks.get(id);
    if (!target || target.userId !== to)
      return done(`没有 #${id} 号任务。发「任务列表」看现有编号。`);
  } else {
    const awaiting = live.filter((t) => t.status === "waiting");
    // 「谁在等就喂谁」优先于「只有一条就喂它」：一条 running + 一条 waiting 时，无前缀消息显然是回给在等的那条
    if (awaiting.length === 1) target = awaiting[0];
    else if (live.length === 1) target = live[0];
    else if (live.length === 0) {
      if (intr.length === 1) return done(resumeTask(intr[0], body));
      if (intr.length > 1)
        return done(
          `有 ${intr.length} 条已中断的任务，请指明编号续跑：${intr.map((t) => `#${t.id}`).join("、")}（写法：\`#${intr[0].id} 继续\`）。`,
        );
      return done("");
    } else {
      const rows = live.map((t) => `#${t.id} [${t.agent}] ${STATUS_LABEL[t.status]}`).join("  ");
      return done(`有 ${live.length} 条任务在跑，请指明要回给哪条：「#<编号> 正文」。\n${rows}`);
    }
  }

  if (target.status === "interrupted") return done(resumeTask(target, body));
  if (target.status === "waiting" && target.injectResolver) {
    const r = target.injectResolver;
    target.injectResolver = undefined;
    r(body);
    return done("");
  }
  (target.pendingInjects ??= []).push(body); // running 期间：按序累积，等这一步跑完一并处理（不覆盖前一条）
  push(to, `📝 已记下给 #${target.id} 的补充，等当前这步跑完就处理。`);
  return done("");
}

/** 结束任务：停 worker、清状态、唤醒退出循环。`id` 缺省＝唯一那条；`"all"`＝全部。 */
export function stopTask(to: string, id?: number | "all", ackId?: string): string {
  const done = (r: string): string => {
    ackIf(ackId, r);
    return r;
  };
  const live = liveTasks(to);
  const intr = interruptedTasks(to);
  if (id === undefined && live.length === 0) {
    // daemon 重启后内存无任务，但 task-state.json 可能残留 active/waiting（幽灵任务）→ 仍要落盘 idle
    persist();
    emitState();
    const hint = intr.length
      ? `有 ${intr.length} 条已中断的任务记录（回「继续」可续跑，或「结束任务 <编号>」清掉记录）。`
      : "";
    return done(`当前没有正在运行的任务。${hint}`);
  }
  if (id === undefined && live.length > 1) {
    const rows = live.map((t) => `#${t.id} [${t.agent}] ${STATUS_LABEL[t.status]}`).join("  ");
    return done(
      `有 ${live.length} 条任务在跑，请指明编号（「结束任务 <编号>」），或「结束全部任务」。\n${rows}`,
    );
  }

  const targets =
    id === "all" ? live : id === undefined ? live.slice(0, 1) : live.filter((t) => t.id === id);
  if (!targets.length) {
    if (id === undefined) return done("当前没有正在运行的任务。");
    if (id === "all") return done("当前没有正在运行的任务。");
    const t = tasks.get(id);
    if (t && t.userId === to && t.status === "interrupted") {
      tasks.delete(id);
      removeStoredTask(store, id);
      persist();
      emitState();
      return done(`已清掉 #${id} 号已中断任务的记录。`);
    }
    return done(`没有 #${id} 号在跑的任务。发「任务列表」看现有编号。`);
  }

  for (const t of targets) {
    const wasWaiting = t.status === "waiting";
    tasks.delete(t.id); // 先删：循环里的 `tasks.get(id) !== task` 据此感知被停
    if (t.injectResolver) {
      const r = t.injectResolver;
      t.injectResolver = undefined;
      r(null);
    }
    const conn = t.conn;
    if (conn) {
      conn.dropSession(t.key);
      if (wasWaiting)
        release(conn); // 等回复的任务进程是干净的 → 回池复用
      else drop(conn); // 正在跑的那条：回合没法「优雅取消」，只能杀掉（正在做的动作就此作罢）
      t.conn = undefined;
    }
  }
  persist();
  emitState();
  if (id === "all") return done(`🛑 已结束全部任务（${targets.length} 条）。`);
  const one = targets[0];
  return done(targets.length === 1 ? `🛑 任务 #${one.id} 已结束。` : "🛑 任务已结束。");
}

/** daemon 退出 / `wemind stop`：停掉一切（任务与池）。 */
export function shutdownTasks(): void {
  for (const t of tasks.values()) {
    t.injectResolver?.(null);
    t.injectResolver = undefined;
  }
  killAll();
  persist(); // 表留着（下次启动会标「已中断」），进程全清
  emitState();
}

/** 测试用：清空内存任务表与落盘路径（不落盘、不杀进程由调用方决定）。 */
export function resetTasksForTest(dir?: string): void {
  tasks.clear();
  store = emptyTaskStore();
  if (dir) storeDir = dir;
}
