import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

/**
 * CLI ↔ daemon 的控制桥（文件式）：CLI 写 `control-inbox/<ts>-<id>.json` 请求，daemon 扫描执行后写
 * `control-out/<id>.json` 应答；CLI 短轮询应答并打印。
 *
 * 为什么要有它：切换大脑/开新会话/恢复会话都必须**在 daemon 进程里**发生（进程内的 ACP 连接、
 * 会话指针、任务表都是 daemon 的活状态）。CLI 另起一个进程去改文件只能改「下次启动才读」的配置，
 * 那就回到「切脑要重启 daemon、打断在途任务」的老问题。桥让 CLI 与微信指令走同一段代码。
 *
 * 与既有 task-inbox 的分工：task-inbox 是**单向**（CLI 派活，结果从微信回）；控制桥要**回话**（CLI 要打印成功/失败），
 * 所以多了 out 目录与轮询。
 *
 * **安全边界**：桥只接受**预设名与纯数据**（target/ref/name/text/id/page），**绝不接受 bin/args/shell**——
 * 就算被伪造（进程能写账号目录，task-inbox 本来也是这个性质），最坏也只是「选一个已装的 agent 或清掉自己的会话」，
 * 不能借此让 daemon 执行任意程序。`parseControlRequest` 是唯一的入口校验。
 */

export type ControlKind =
  /** 热切换对话大脑（落盘 + 预热 + 失败回滚）。 */
  | "brain.switch"
  /** 设默认任务大脑（本次运行内一直生效，不落盘）。 */
  | "brain.worker"
  /** 生成交接摘要（落盘，返回摘要正文）。 */
  | "brain.handoff"
  | "session.new"
  | "session.list"
  | "session.resume"
  | "session.rename"
  | "session.delete"
  | "task.list"
  | "task.reply"
  | "task.stop";

const KINDS: ReadonlySet<string> = new Set<ControlKind>([
  "brain.switch",
  "brain.worker",
  "brain.handoff",
  "session.new",
  "session.list",
  "session.resume",
  "session.rename",
  "session.delete",
  "task.list",
  "task.reply",
  "task.stop",
]);

export type ControlRequest = {
  id: string;
  kind: ControlKind;
  at: number;
  /** 预设名（brain.switch / brain.worker）。 */
  target?: string;
  /** 会话引用：序号 / 名字 / id 前缀（session.resume / rename / delete）。 */
  ref?: string;
  /** 会话名字（session.new / session.rename）。 */
  name?: string;
  /** 任务正文（task.reply）。 */
  text?: string;
  /** 任务编号（task.reply / task.stop；"all" = 全部）。 */
  taskId?: number | "all";
  /** 会话列表页码。 */
  page?: number;
};

export type ControlResponse = {
  id: string;
  at: number;
  /** 命令是否成功（决定 CLI 的退出码展示）。 */
  ok: boolean;
  /** 打印给用户的那段话（就是微信里会看到的那句）。 */
  text: string;
};

export function controlInboxDir(dir: string = DATA_DIR): string {
  return path.join(dir, "control-inbox");
}
export function controlOutDir(dir: string = DATA_DIR): string {
  return path.join(dir, "control-out");
}

/** 请求 id：带时间戳（文件名排序即时间序）+ 随机后缀（同一毫秒内不发重）。 */
export function newRequestId(now: number = Date.now()): string {
  return `${now}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 写请求（原子：tmp + rename，避免 daemon 读到半截 JSON）。 */
export function writeControlRequest(req: ControlRequest, dir: string = DATA_DIR): void {
  const d = controlInboxDir(dir);
  fs.mkdirSync(d, { recursive: true });
  const tmp = path.join(d, `${req.at}-${req.id}.json.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(req, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, path.join(d, `${req.at}-${req.id}.json`));
}

/** 读收件箱（按文件名升序 = 时间序）；`req` 为 null 表示坏文件/非法 kind（调用方直接丢弃）。 */
export function readControlInbox(
  dir: string = DATA_DIR,
): { file: string; req: ControlRequest | null }[] {
  let files: string[];
  try {
    files = fs.readdirSync(controlInboxDir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  files.sort();
  return files.map((file) => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(controlInboxDir(dir), file), "utf-8"));
      return { file, req: parseControlRequest(raw) };
    } catch {
      return { file, req: null };
    }
  });
}

/** 入口校验：只有已知 kind + 字符串/数字字段能通过（**没有** bin/args/shell 这类字段的位置）。 */
export function parseControlRequest(raw: unknown): ControlRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const kind = typeof o.kind === "string" ? o.kind : "";
  if (!KINDS.has(kind)) return null;
  const id = typeof o.id === "string" && o.id ? o.id : "";
  if (!id) return null;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, 2000) : undefined;
  const req: ControlRequest = {
    id,
    kind: kind as ControlKind,
    at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : Date.now(),
  };
  const target = str(o.target);
  if (target) req.target = target;
  const ref = str(o.ref);
  if (ref) req.ref = ref;
  const name = str(o.name);
  if (name) req.name = name;
  const text = str(o.text);
  if (text) req.text = text;
  if (o.taskId === "all") req.taskId = "all";
  else if (typeof o.taskId === "number" && Number.isInteger(o.taskId) && o.taskId > 0)
    req.taskId = o.taskId;
  if (typeof o.page === "number" && Number.isInteger(o.page) && o.page > 0) req.page = o.page;
  return req;
}

/** 写应答（原子）。 */
export function writeControlResponse(res: ControlResponse, dir: string = DATA_DIR): void {
  const d = controlOutDir(dir);
  fs.mkdirSync(d, { recursive: true });
  const tmp = path.join(d, `${res.id}.json.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(res, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, path.join(d, `${res.id}.json`));
}

export function readControlResponse(id: string, dir: string = DATA_DIR): ControlResponse | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(controlOutDir(dir), `${id}.json`), "utf-8"));
    if (!j || typeof j !== "object") return null;
    return {
      id: String(j.id ?? id),
      at: Number(j.at) || 0,
      ok: j.ok === true,
      text: typeof j.text === "string" ? j.text : "",
    };
  } catch {
    return null;
  }
}

/** 普通命令的等待上限（30s；`WEMIND_CONTROL_TIMEOUT_MS` 可调）。 */
export const CONTROL_TIMEOUT_DEFAULT_MS = Number(process.env.WEMIND_CONTROL_TIMEOUT_MS) || 30_000;

/** 短轮询等应答；超时返回 null（CLI 据此如实说「没等到回复」而不是假装成功）。 */
export async function awaitControlResponse(
  id: string,
  dir: string = DATA_DIR,
  timeoutMs: number = CONTROL_TIMEOUT_DEFAULT_MS,
  pollMs = 100,
): Promise<ControlResponse | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = readControlResponse(id, dir);
    if (r) return r;
    if (Date.now() >= deadline) return null;
    await new Promise((r2) => setTimeout(r2, pollMs));
  }
}

/** daemon 启动时清空桥目录（作废重启前的残留命令，防重放）。 */
export function clearControlDirs(dir: string = DATA_DIR): void {
  for (const d of [controlInboxDir(dir), controlOutDir(dir)]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * 「这个 daemon 认识控制桥」的凭据：`control-out/.bridge`，内容是**它自己的 pid**。
 *
 * 为什么需要：升级 CLI 后 daemon 往往还在跑旧版本（它没有桥的扫描器）。CLI 若径直把请求写进收件箱，
 * 只会干等到超时（默认 30s，切换 165s），用户看到的是「莫名其妙失败」。有了凭据，CLI 能在**发出前**就说清
 * 「daemon 是旧版，重启一次再用」，把三分钟的静默等待换成一句能照做的话。
 */
export function bridgeMarkerPath(dir: string = DATA_DIR): string {
  return path.join(controlOutDir(dir), ".bridge");
}

export function markBridgeReady(dir: string = DATA_DIR, pid: number = process.pid): void {
  try {
    fs.mkdirSync(controlOutDir(dir), { recursive: true });
    fs.writeFileSync(bridgeMarkerPath(dir), JSON.stringify({ pid, at: Date.now() }), "utf-8");
  } catch {
    /* ignore */
  }
}

/** 凭据里的 pid；没有/坏了 → null（CLI 视为「daemon 不是认识桥的版本」）。 */
export function bridgePidOf(dir: string = DATA_DIR): number | null {
  try {
    const j = JSON.parse(fs.readFileSync(bridgeMarkerPath(dir), "utf-8"));
    return typeof j?.pid === "number" && j.pid > 0 ? j.pid : null;
  } catch {
    return null;
  }
}

/**
 * 按 kind 给等待上限：`brain.switch` 要跑「drain + 预热」（预热本身就有 120s 硬上限），
 * 用普通上限会让 CLI 在正确的长切换上误报超时。
 */
export function controlTimeoutMs(kind: ControlKind, env: NodeJS.ProcessEnv = process.env): number {
  const base = Number(env.WEMIND_CONTROL_TIMEOUT_MS) || CONTROL_TIMEOUT_DEFAULT_MS;
  if (kind !== "brain.switch") return base;
  const warm = Number(env.WEMIND_SWITCH_TIMEOUT_MS) || 120_000;
  const drain = Number(env.WEMIND_SWITCH_DRAIN_MS) || 30_000;
  return Math.max(base, warm + drain + 15_000);
}
