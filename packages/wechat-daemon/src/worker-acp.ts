import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import { DATA_DIR } from "@wemind/wechat-ilink-core";
import { WORKER_HOME, workerMcpServers } from "./worker-sandbox.js";
import { spawnAgent } from "./spawn-agent.js";
import {
  backupCorruptSessionMap,
  normalizeSessionMap,
  readSessionMapStrict,
  sessionKey,
} from "./session-map.js";
import { acpArgsHint, agentEnv, type ResolvedAgent } from "./brain-agents.js";
import {
  applyAcpModel,
  applyAcpSessionMode,
  availableAcpModes,
  acpTurnChunks,
  acpTurnText,
  beginAcpTurn,
  clearAcpTurn,
  drainAcpReplay,
  endAcpTurn,
  feedAcpStdout,
  handleAcpFrame,
  newTurnState,
  promptAcp,
  requestAcp,
  type AcpHost,
  type AcpPending,
  type AcpProgressEvent,
} from "./acp-connection.js";
import { LineDecoder } from "./line-decoder.js";

/**
 * worker ACP 连接：**一条连接＝一个 ACP agent 进程**；协议细节（帧处理/请求与回合超时/模型与模式设置/回放静默）与 brain 共用 `acp-connection.ts`，本模块只保留任务侧差异：
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

/** 实际生效的任务工作目录：显式 cwd 优先，否则 `WEMIND_WORKER_CWD` / 用户主目录。 */
export function effectiveWorkerCwd(cwd?: string): string {
  return cwd?.trim() || WORKER_CWD;
}
const REQ_TIMEOUT = 30_000; // initialize / session/new / session/load
const PROMPT_IDLE_MS = Number(process.env.WEMIND_WORKER_IDLE_MS) || 180_000; // 无任何帧多久算"卡死"（比 brain 宽松：3min）
const PROMPT_CAP_MS = Number(process.env.WEMIND_WORKER_CAP_MS) || 1_800_000; // 单轮硬上限 30min（漫长任务）
const FIRST_FRAME_DEFAULT_MS = 30_000;
const SESSION_MAP_FILE = path.join(DATA_DIR, "worker-sessions.json");

/** 首帧超时（配置可覆盖；每轮现算，热切换/指定 agent 后随之改变）。 */
function firstFrameMs(a: ResolvedAgent): number {
  return (
    Number(process.env.WEMIND_WORKER_FIRST_FRAME_MS) || a.firstFrameMs || FIRST_FRAME_DEFAULT_MS
  );
}

export type WorkerProgressEvent = AcpProgressEvent;

let connSeq = 0;

// ---- 磁盘 session 映射（`<agent>:<sessionKey>` -> sessionId），与 brain 同样按 agent 分开存 ----
function loadSessionMap(a: ResolvedAgent): Record<string, string> {
  let raw: Record<string, string>;
  try {
    raw = readSessionMapStrict(SESSION_MAP_FILE);
  } catch (e) {
    const backup = backupCorruptSessionMap(SESSION_MAP_FILE);
    dlog(
      `session map unreadable (${String(e)}) → ${backup ? `backed up to ${backup}` : "backup failed"}；按空表继续`,
    );
    return {};
  }
  const { map, migrated } = normalizeSessionMap(raw, a.name);
  if (migrated) saveSessionMap(map); // 立即写入磁盘，避免下次换 agent 时旧条目再被“继承”一次
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
  private pending = new Map<number, AcpPending>();
  private sessions = new Map<string, string>(); // sessionKey -> sessionId
  private turn = newTurnState(); // 当前回合的拼接缓冲与进度状态
  private rpcState = { lastFrameAt: 0, frameSeq: 0 }; // 最近收帧时间 + 累计序号
  private stdoutLines = new LineDecoder();
  private host: AcpHost;
  private cwd?: string; // 本任务的工作目录（spawn 时生效；子进程 cwd 不可中途改）
  private spawnError?: Error; // spawn 失败的真实原因（cwd 不存在/权限），kill() 用它答复而不是笼统的 killed
  /** spawn 后立刻回调：池据此把 pid 身份记录写入磁盘（`wemind stop` 靠它精确找到本进程）。 */
  onSpawn?: (conn: WorkerConn) => void;

  constructor(agent: ResolvedAgent) {
    this.agent = agent;
    this.id = `w${++connSeq}`;
    this.host = {
      pending: this.pending,
      turn: this.turn,
      state: this.rpcState,
      hasProcess: () => !!this.child,
      noProcessMessage: "no worker process",
      nextId: () => ++this.idCounter,
      write: (payload) => this.write(JSON.stringify(payload)),
      log: (message) => dlog(`${this.id}(${this.agent.name}) ${message}`),
    };
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
    return effectiveWorkerCwd(this.cwd);
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
    const reason = this.spawnError
      ? `进程启动失败：${this.spawnError.message}`
      : "worker conn killed";
    for (const p of this.pending.values()) {
      p.clear();
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.sessions.clear();
    clearAcpTurn(this.turn);
    this.stdoutLines.reset();
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
    beginAcpTurn(this.turn, sid, onProgress);
    const t0 = Date.now();
    const prompt: unknown[] = [{ type: "text", text: instruction || "（继续）" }];
    try {
      await promptAcp(
        this.host,
        { sessionId: sid, prompt },
        {
          idleMs: PROMPT_IDLE_MS,
          capMs: PROMPT_CAP_MS,
          firstFrameMs: firstFrameMs(this.agent),
        },
      );
      const txt = acpTurnText(this.turn, sid);
      dlog(
        `${this.id}(${this.agent.name}) prompt ok ${Date.now() - t0}ms chunks=${acpTurnChunks(this.turn, sid)} updateTypes=[${[...this.turn.seenUpdateTypes].join(",")}]`,
      );
      return txt;
    } catch (e) {
      const chunks = acpTurnChunks(this.turn, sid);
      const sinceFrame = this.rpcState.lastFrameAt ? Date.now() - this.rpcState.lastFrameAt : -1;
      dlog(
        `${this.id}(${this.agent.name}) prompt FAIL ${Date.now() - t0}ms chunks=${chunks} lastFrameAgo=${sinceFrame}ms err=${String(e)} -> rebuild`,
      );
      this.kill();
      throw e;
    } finally {
      endAcpTurn(this.turn, sid);
    }
  }

  private write(line: string): void {
    this.child?.stdin.write(line + "\n");
  }

  private async ensureProcess(): Promise<void> {
    if (this.isAlive() && this.initialized) return;
    this.kill();
    this.spawnError = undefined; // 上一次的 spawn 失败不能污染这一次
    const kept: string[] = [];
    const env = agentEnv(this.agent, WORKER_HOME, kept); // 父进程 env → 沙箱目录 → 预设 env → 预设 envDefaults（父进程已设的不覆盖）
    if (kept.length) dlog(`${this.id} env defaults kept from parent: ${kept.join(",")}`);
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
    proc.stdout.on("data", (d) =>
      feedAcpStdout(this.stdoutLines, d, (f) => handleAcpFrame(f, this.host)),
    );
    proc.stderr.on("data", () => {
      /* ignore */
    });
    proc.on("exit", (code) => {
      // A：握手前就退出时附上 args 诊断（与 brain 侧同一提示，见 brain-agents.ts 的 acpArgsHint）
      const hint = this.child === proc && !this.initialized ? acpArgsHint(this.agent) : "";
      dlog(`${this.id}(${this.agent.name}) exited code=${code}${hint}`);
      if (this.child === proc) this.kill();
    });
    proc.on("error", (e) => {
      this.spawnError = e instanceof Error ? e : new Error(String(e));
      dlog(`${this.id}(${this.agent.name}) error ${String(e)}`);
      if (this.child === proc) this.kill();
    });
    try {
      await requestAcp(
        this.host,
        "initialize",
        { protocolVersion: 1, clientCapabilities: {} },
        REQ_TIMEOUT,
      );
    } catch (e) {
      // spawn 失败（cwd 不存在/权限）不是「args 漏了 acp」，别贴那条误导性提示
      const hint = this.spawnError ? "" : acpArgsHint(this.agent);
      dlog(`${this.id}(${this.agent.name}) initialize failed: ${String(e)}${hint}`);
      throw e;
    }
    this.initialized = true;
    dlog(`${this.id} initialized`);
  }

  /** 取会话：内存 → 磁盘（load/resume 恢复） → 新建。key 由调用方给（每任务一个）。
   *  `strictResume`：有旧会话但恢复失败 → 抛「接不上」，绝不静默新建空会话。 */
  private async ensureSession(key: string, strictResume = false): Promise<string> {
    const existing = this.sessions.get(key);
    if (existing) return existing;
    // 配了 mcpViaAcp 的 agent（DSH）：worker 继承全量 MCP（除排除集），随 session 下发；其余 agent 传空
    const mcpServers = this.agent.mcpViaAcp ? workerMcpServers(this.agent) : [];
    const mapKey = sessionKey(this.agent.name, key);
    const map = loadSessionMap(this.agent);
    const saved = map[mapKey];
    if (saved) {
      const methods: Array<"load" | "resume"> =
        this.agent.restore === "resume" ? ["resume"] : ["load", "resume"];
      for (const method of methods) {
        try {
          const restored = await requestAcp(
            this.host,
            `session/${method}`,
            { sessionId: saved, cwd: this.effectiveCwd(), mcpServers },
            REQ_TIMEOUT,
          );
          await drainAcpReplay(this.host, this.agent);
          await applyAcpModel(this.host, this.agent, saved, REQ_TIMEOUT);
          await applyAcpSessionMode(
            this.host,
            this.agent,
            saved,
            availableAcpModes(restored),
            REQ_TIMEOUT,
          );
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
          `接不上原会话 ${saved}（该 agent 不支持恢复、或这条会话已被它自己清理）。重试还是同一个结果——想重来请结束这条任务后重新派一条（把进展写进新任务里）。`,
        );
    }
    const res = (await requestAcp(
      this.host,
      "session/new",
      { cwd: this.effectiveCwd(), mcpServers },
      REQ_TIMEOUT,
    )) as { sessionId?: string };
    if (!res?.sessionId) throw new Error("session/new returned no sessionId");
    await applyAcpModel(this.host, this.agent, res.sessionId, REQ_TIMEOUT);
    await applyAcpSessionMode(
      this.host,
      this.agent,
      res.sessionId,
      availableAcpModes(res),
      REQ_TIMEOUT,
    );
    this.sessions.set(key, res.sessionId);
    // 重新读改写：多个连接并存时，别用陈旧的记录整张覆盖（会抹掉别的任务刚写的 key）
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
