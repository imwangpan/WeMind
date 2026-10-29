import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import { DATA_DIR } from "@wemind/wechat-ilink-core";
import { WORKER_HOME, workerMcpServers } from "./worker-sandbox.js";
import { spawnAgent } from "./spawn-agent.js";
import { normalizeSessionMap, sessionKey } from "./session-map.js";
import type { ResolvedAgent } from "./brain-agents.js";

/**
 * worker ACP 连接：**一条连接＝一个 ACP agent 进程**，约 70% 复制自 acp-brain.ts，差异：
 * - **每连接一实例**（child/pending/session/进度全在实例里，不再是模块级全局）——多任务并行要有多个进程；
 *   进程池（worker-pool.ts）持有它们、按 agent 复用，任务结束把连接**还给进程池**而不是杀掉；
 * - **每任务一个 session key**（`task-<编号>@<userId>`），持久化到 worker-sessions.json，重建后 session/load 续上下文；
 * - **cwd = 任务工作目录**（本地派发可指定，默认用户主目录），而沙箱走 WORKER_HOME（继承全量 MCP 除 wechat + 记忆）；
 * - **更宽松超时**（漫长任务，env 可调）；去掉 brain 的「可发图」首轮提示（任务执行不是聊天发图场景）。
 * 自愈：session/prompt 超时/失败 → 只杀**这一条**连接的进程；下次 ask 重建并 session/load 恢复（→ 用户回「继续」即可续跑）。
 */

function dlog(...a: unknown[]): void {
  console.error("[wemind/wechat-daemon/worker]", ...a);
}

const WORKER_CWD = process.env.WEMIND_WORKER_CWD?.trim() || os.homedir(); // 任务工作目录默认值
const REQ_TIMEOUT = 30_000; // initialize / session/new / session/load
const PROMPT_IDLE_MS = Number(process.env.WEMIND_WORKER_IDLE_MS) || 180_000; // 无任何帧多久算"卡死"（比 brain 宽松：3min）
const PROMPT_CAP_MS = Number(process.env.WEMIND_WORKER_CAP_MS) || 1_800_000; // 单轮硬上限 30min（漫长任务）
const FIRST_FRAME_DEFAULT_MS = 30_000;
const SESSION_MAP_FILE = path.join(DATA_DIR, "worker-sessions.json");

/** 首帧超时（预设可覆盖；每轮现算，热切换/指定 agent 后随之改变）。 */
function firstFrameMs(a: ResolvedAgent): number {
  return (
    Number(process.env.WEMIND_WORKER_FIRST_FRAME_MS) || a.firstFrameMs || FIRST_FRAME_DEFAULT_MS
  );
}

export type WorkerProgressEvent =
  | { type: "tool"; kind?: string; purpose?: string; title?: string }
  | { type: "answer" }
  | { type: "thinking" }
  | { type: "activity" };

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  clear: () => void;
  method: string;
};

let connSeq = 0;

// ---- 磁盘 session 映射（`<agent>:<sessionKey>` -> sessionId），与 brain 同样按 agent 分开存 ----
function loadSessionMap(a: ResolvedAgent): Record<string, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(SESSION_MAP_FILE, "utf-8"));
  } catch {
    return {};
  }
  const { map, migrated } = normalizeSessionMap(raw, a.name);
  if (migrated) saveSessionMap(map); // 立即落盘，避免下次换 agent 时旧条目再被“继承”一次
  return map;
}
function saveSessionMap(m: Record<string, string>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${SESSION_MAP_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2), "utf-8");
  fs.renameSync(tmp, SESSION_MAP_FILE); // 原子写：多连接并发时会各自读改写这张表，半截文件会让读方整张丢
}

/** 一条连接：一个 ACP agent 进程 + 它自己的握手/会话/进度状态。 */
export class WorkerConn {
  readonly id: string;
  readonly agent: ResolvedAgent;
  /** 池用来标注「这条连接现在跑的是哪个任务」（空闲时为 undefined）。 */
  taskId?: number;

  private child: ChildProcessWithoutNullStreams | null = null;
  private initialized = false;
  private idCounter = 0;
  private pending = new Map<number, Pending>();
  private sessions = new Map<string, string>(); // sessionKey -> sessionId
  private assembling = new Map<string, string[]>(); // sessionId -> 当前轮文本块
  private stdoutBuf = "";
  private lastFrameAt = 0;
  private frameSeq = 0;
  private currentOnProgress: ((ev: WorkerProgressEvent) => void) | null = null;
  private answerStarted = false;
  private thoughtStarted = false;
  private seenUpdateTypes = new Set<string>();
  private seenTools = new Set<string>();
  private cwd?: string; // 本任务的工作目录（spawn 时生效；子进程 cwd 不可中途改）
  /** spawn 后立刻回调：池据此把 pid 身份记录落盘（`wemind stop` 靠它精确找到本进程）。 */
  onSpawn?: (conn: WorkerConn) => void;

  constructor(agent: ResolvedAgent) {
    this.agent = agent;
    this.id = `w${++connSeq}`;
  }

  isAlive(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** 设置本任务的工作目录（下次 spawn 生效）。 */
  setCwd(cwd?: string): void {
    this.cwd = cwd?.trim() || undefined;
  }

  effectiveCwd(): string {
    return this.cwd ?? WORKER_CWD;
  }

  hasSession(key: string): boolean {
    return this.sessions.has(key);
  }

  /** 杀掉本连接的进程（按 PID 进程树）并清空内存态；不清磁盘 session 映射（留给重建后 load）。 */
  kill(): void {
    const c = this.child;
    this.child = null;
    this.initialized = false;
    if (c?.pid) {
      try {
        if (process.platform === "win32")
          spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true, // 避免瞬时闪出控制台窗口
          });
        else c.kill();
      } catch {
        /* ignore */
      }
    }
    for (const p of this.pending.values()) {
      p.clear();
      p.reject(new Error("worker conn killed"));
    }
    this.pending.clear();
    this.sessions.clear();
    this.assembling.clear();
    this.stdoutBuf = "";
    dlog(`${this.id}(${this.agent.name}) killed`);
  }

  /** 丢弃某个会话（内存 + 磁盘上的当前会话记录）：任务结束用，下个任务全新开始。 */
  dropSession(key: string): void {
    this.sessions.delete(key);
    const map = loadSessionMap(this.agent);
    delete map[sessionKey(this.agent.name, key)];
    saveSessionMap(map);
  }

  /** 提前起进程：只做「起进程 + initialize」，不建会话（任务拿到连接时用；失败由调用方处理）。 */
  async warm(): Promise<void> {
    await this.ensureProcess();
  }

  /**
   * 发一轮 prompt（任务派发或回话续跑），等这一轮 ACP 响应结束，返回拼接文本。
   * 失败即杀本连接的进程（下一轮 ask 重建并 session/load 恢复上下文）→ 配合「继续」实现中断恢复。
   * `strictResume`：磁盘上有旧会话、但 load/resume 都失败时**不静默新建**，直接抛错（续跑场景要的是「上下文接上」，
   * 悄悄换一个空会话会让用户以为续上了、其实什么都不知道）。
   */
  async ask(
    instruction: string,
    key: string,
    onProgress?: (ev: WorkerProgressEvent) => void,
    opts: { strictResume?: boolean } = {},
  ): Promise<string> {
    await this.ensureProcess();
    const sid = await this.ensureSession(key, opts.strictResume === true);
    this.assembling.set(sid, []);
    this.currentOnProgress = onProgress ?? null;
    this.answerStarted = false;
    this.thoughtStarted = false;
    this.seenUpdateTypes.clear();
    this.seenTools.clear();
    const t0 = Date.now();
    const prompt: unknown[] = [{ type: "text", text: instruction || "（继续）" }];
    try {
      await this.promptRequest({ sessionId: sid, prompt });
      const txt = (this.assembling.get(sid) ?? []).join("").trim();
      dlog(
        `${this.id}(${this.agent.name}) prompt ok ${Date.now() - t0}ms chunks=${(this.assembling.get(sid) ?? []).length} updateTypes=[${[...this.seenUpdateTypes].join(",")}]`,
      );
      return txt;
    } catch (e) {
      const chunks = (this.assembling.get(sid) ?? []).length;
      const sinceFrame = this.lastFrameAt ? Date.now() - this.lastFrameAt : -1;
      dlog(
        `${this.id}(${this.agent.name}) prompt FAIL ${Date.now() - t0}ms chunks=${chunks} lastFrameAgo=${sinceFrame}ms err=${String(e)} -> rebuild`,
      );
      this.kill();
      throw e;
    } finally {
      this.currentOnProgress = null;
      this.assembling.delete(sid);
    }
  }

  private write(line: string): void {
    this.child?.stdin.write(line + "\n");
  }

  private handleReverseRequest(f: Record<string, any>): void {
    const method = String(f.method);
    dlog(`${this.id} ← reverse request ${method}#${f.id}`);
    if (method === "session/request_permission") {
      const options = Array.isArray(f.params?.options) ? f.params.options : [];
      const allow =
        process.env.WEMIND_ACP_AUTO_ALLOW === "1"
          ? options.find((o: any) => o?.kind === "allow_once" || o?.kind === "allow_always")
          : undefined;
      const result = allow
        ? { outcome: { outcome: "selected", optionId: allow.optionId } }
        : { outcome: { outcome: "cancelled" } };
      this.write(JSON.stringify({ jsonrpc: "2.0", id: f.id, result }));
      dlog(`permission ${allow ? "allowed" : "rejected"}`);
      return;
    }
    this.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: f.id,
        error: { code: -32601, message: "method not supported" },
      }),
    );
  }

  private handleFrame(f: Record<string, any>): void {
    this.lastFrameAt = Date.now();
    this.frameSeq += 1;
    if (typeof f.id === "number" && (f.result !== undefined || f.error !== undefined)) {
      const p = this.pending.get(f.id);
      if (!p) return;
      p.clear();
      this.pending.delete(f.id);
      if (f.error) {
        dlog(`${this.id} ← ${p.method}#${f.id} ERROR ${JSON.stringify(f.error).slice(0, 200)}`);
        p.reject(new Error(JSON.stringify(f.error)));
      } else p.resolve(f.result);
      return;
    }
    if (f.method && f.id !== undefined) {
      this.handleReverseRequest(f);
      return;
    }
    if (f.method === "session/update") {
      const u = f.params?.update;
      if (u?.sessionUpdate) this.seenUpdateTypes.add(String(u.sessionUpdate));
      if (this.currentOnProgress) {
        try {
          this.currentOnProgress({ type: "activity" });
        } catch {
          /* ignore */
        }
      }
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        const arr = this.assembling.get(f.params.sessionId);
        if (arr) arr.push(String(u.content.text ?? ""));
        if (!this.answerStarted && this.currentOnProgress) {
          this.answerStarted = true;
          try {
            this.currentOnProgress({ type: "answer" });
          } catch {
            /* ignore */
          }
        }
      } else if (u?.sessionUpdate === "agent_thought_chunk") {
        if (!this.thoughtStarted && this.currentOnProgress) {
          this.thoughtStarted = true;
          try {
            this.currentOnProgress({ type: "thinking" });
          } catch {
            /* ignore */
          }
        }
      } else if (
        (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") &&
        this.currentOnProgress
      ) {
        const tid = String(u.toolCallId ?? u.title ?? "");
        if (tid && !this.seenTools.has(tid)) {
          this.seenTools.add(tid);
          const purpose =
            typeof u.rawInput?.__tool_use_purpose === "string"
              ? u.rawInput.__tool_use_purpose
              : undefined;
          try {
            this.currentOnProgress({ type: "tool", kind: u.kind, purpose, title: u.title });
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  private onStdout(d: Buffer): void {
    this.stdoutBuf += d.toString();
    let i: number;
    while ((i = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, i).trim();
      this.stdoutBuf = this.stdoutBuf.slice(i + 1);
      if (!line) continue;
      let f: Record<string, any>;
      try {
        f = JSON.parse(line);
      } catch {
        continue; // 有的 agent 会往 stdout 混日志行（DSH 实测），非 JSON 直接跳过
      }
      this.handleFrame(f);
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new Error("no worker process"));
        return;
      }
      const id = ++this.idCounter;
      dlog(`${this.id} → ${method}#${id}`);
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, clear: () => clearTimeout(t), method });
      this.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** session/prompt 专用：空闲超时 + 首帧超时 + 硬上限（漫长任务，比 brain 宽松）。 */
  private promptRequest(params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new Error("no worker process"));
        return;
      }
      const id = ++this.idCounter;
      const startedAt = Date.now();
      this.lastFrameAt = Date.now();
      const startSeq = this.frameSeq;
      const firstMs = firstFrameMs(this.agent);
      dlog(
        `${this.id} → session/prompt#${id} (idle=${PROMPT_IDLE_MS}ms cap=${PROMPT_CAP_MS}ms firstFrame=${firstMs}ms)`,
      );
      const iv = setInterval(() => {
        const idle = Date.now() - this.lastFrameAt;
        const total = Date.now() - startedAt;
        const noFrameYet = this.frameSeq === startSeq;
        const firstFrameTimeout = noFrameYet && total > firstMs;
        if (firstFrameTimeout || idle > PROMPT_IDLE_MS || total > PROMPT_CAP_MS) {
          if (this.pending.delete(id)) {
            clearInterval(iv);
            const why = firstFrameTimeout
              ? "no-first-frame"
              : idle > PROMPT_IDLE_MS
                ? "idle"
                : "cap";
            reject(new Error(`session/prompt ${why} timeout (idle=${idle}ms total=${total}ms)`));
          }
        }
      }, 5000);
      this.pending.set(id, {
        resolve,
        reject,
        clear: () => clearInterval(iv),
        method: "session/prompt",
      });
      this.write(JSON.stringify({ jsonrpc: "2.0", id, method: "session/prompt", params }));
    });
  }

  private async ensureProcess(): Promise<void> {
    if (this.isAlive() && this.initialized) return;
    this.kill();
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.agent.homeEnvVar) env[this.agent.homeEnvVar] = WORKER_HOME; // 配置目录（MCP/记忆）走 WORKER_HOME 沙箱
    for (const [k, v] of Object.entries(this.agent.env ?? {}))
      env[k] = v.replaceAll("%HOME%", WORKER_HOME);
    const cwd = this.effectiveCwd();
    const proc = spawnAgent(this.agent, {
      cwd, // 任务工作目录（本地派发可指定，否则默认 WORKER_CWD），区别于沙箱
      env,
    });
    this.child = proc;
    dlog(
      `${this.id} spawn ${this.agent.name} worker pid=${proc.pid} cwd=${cwd} home=${WORKER_HOME} task=${this.taskId ?? "-"}`,
    );
    this.onSpawn?.(this); // 立刻落 pid 身份记录（在握手之前，`wemind stop` 才来得及找到它）
    proc.stdout.on("data", (d) => this.onStdout(d));
    proc.stderr.on("data", () => {
      /* ignore */
    });
    proc.on("exit", (code) => {
      dlog(`${this.id}(${this.agent.name}) exited code=${code}`);
      if (this.child === proc) this.kill();
    });
    proc.on("error", (e) => {
      dlog(`${this.id}(${this.agent.name}) error ${String(e)}`);
      if (this.child === proc) this.kill();
    });
    await this.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, REQ_TIMEOUT);
    this.initialized = true;
    dlog(`${this.id} initialized`);
  }

  private async applyModel(sid: string): Promise<void> {
    if (!this.agent.model) return;
    try {
      await this.request(
        "session/set_config_option",
        { sessionId: sid, configId: "model", value: this.agent.model },
        REQ_TIMEOUT,
      );
      dlog(`${this.id} model set ${this.agent.model}`);
    } catch (e) {
      dlog(`${this.id} model set failed (${String(e)})`);
      throw e;
    }
  }

  /** 取会话：内存 → 磁盘（load/resume 恢复） → 新建。key 由调用方给（每任务一个）。
   *  `strictResume`：有旧会话但恢复失败 → 抛「接不上」，绝不静默新建空会话。 */
  private async ensureSession(key: string, strictResume = false): Promise<string> {
    const existing = this.sessions.get(key);
    if (existing) return existing;
    // mcpViaAcp 预设（DSH）：worker 继承全量 MCP（除排除集），随 session 下发；其余 agent 传空
    const mcpServers = this.agent.mcpViaAcp ? workerMcpServers(this.agent) : [];
    const mapKey = sessionKey(this.agent.name, key);
    const map = loadSessionMap(this.agent);
    const saved = map[mapKey];
    if (saved) {
      const methods: Array<"load" | "resume"> =
        this.agent.restore === "resume" ? ["resume"] : ["load", "resume"];
      for (const method of methods) {
        try {
          await this.request(
            `session/${method}`,
            { sessionId: saved, cwd: this.effectiveCwd(), mcpServers },
            REQ_TIMEOUT,
          );
          await this.applyModel(saved);
          this.sessions.set(key, saved);
          dlog(
            `${this.id} session/${method} ok ${saved} mcp=[${mcpServers.map((s: any) => s.name).join(",")}]`,
          );
          return saved;
        } catch (e) {
          dlog(`${this.id} session/${method} failed (${String(e)})`);
        }
      }
      if (strictResume)
        throw new Error(
          `接不上原会话 ${saved}（该 agent 不支持恢复、或这条会话已被它自己清理）。请用文字把当前进展重述一遍再继续。`,
        );
    }
    const res = (await this.request(
      "session/new",
      { cwd: this.effectiveCwd(), mcpServers },
      REQ_TIMEOUT,
    )) as { sessionId?: string };
    if (!res?.sessionId) throw new Error("session/new returned no sessionId");
    await this.applyModel(res.sessionId);
    this.sessions.set(key, res.sessionId);
    // 重新读改写：多个连接并存时，别用陈旧的快照整张覆盖（会抹掉别的任务刚写的 key）
    const fresh = loadSessionMap(this.agent);
    fresh[mapKey] = res.sessionId;
    saveSessionMap(fresh);
    dlog(
      `${this.id} session/new ok ${res.sessionId} mcp=[${mcpServers.map((s: any) => s.name).join(",")}]`,
    );
    return res.sessionId;
  }
}

/** 建一条连接（不 spawn；第一次 `warm()`/`ask()` 才起进程）。 */
export function createConn(agent: ResolvedAgent, onSpawn?: (c: WorkerConn) => void): WorkerConn {
  const c = new WorkerConn(agent);
  c.onSpawn = onSpawn;
  return c;
}
