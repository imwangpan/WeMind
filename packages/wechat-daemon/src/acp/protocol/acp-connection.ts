import { handleReverseRequest } from "./acp-reverse.js";
import { waitForFrameQuiet } from "./acp-quiet.js";
import type { ResolvedAgent } from "../../agents/brain-agents.js";
import { LineDecoder } from "../../shared/io/line-decoder.js";

/**
 * ACP 连接的公共层（brain / worker 共用）：JSON-RPC 帧处理、请求超时、回合超时、模型与模式设置、回放静默。
 *
 * 进程生命周期与会话持久化**不在这里**：brain 是常驻单例 + 按用户 `brain-sessions.json`；worker 是每任务一条连接 + `worker-sessions.json`。
 * 两边真正会「各写一份然后漂移」的是协议细节（帧分类、空闲/首帧/硬上限、`session/set_config_mode` 等），所以只抽这一层。
 * 进程退出/重建时由调用方清自己的状态；这里只清 transport 与当前回合的拼接缓冲（`clearAcpTurn`）。
 */

export type AcpProgressEvent =
  | {
      type: "tool";
      /** start = 工具开始；end = 收到终态 tool_call_update（completed/failed/blocked）。 */
      phase?: "start" | "end";
      toolCallId?: string;
      status?: string;
      kind?: string;
      purpose?: string;
      title?: string;
      detail?: string;
    }
  | { type: "answer" }
  | { type: "thinking" }
  | { type: "activity" };

/** 工具调用里能直接读懂的短参数：不同 agent 的 rawInput 形状不统一，按常见键取第一个。 */
const TOOL_DETAIL_KEYS = [
  "command",
  "cmd",
  "path",
  "file_path",
  "filePath",
  "query",
  "pattern",
  "url",
  "description",
] as const;

/** 进度里的工具描述要短：折行压成空格，超过 60 字截断，避免把整段命令/JSON 塞进微信。 */
function clipDetail(s: string): string | undefined {
  const text = s.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

function toolDetail(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const rec = rawInput as Record<string, unknown>;
  for (const key of TOOL_DETAIL_KEYS) {
    const v = rec[key];
    if (typeof v === "string") {
      const detail = clipDetail(v);
      if (detail) return detail;
    }
  }
  return undefined;
}

export type AcpPending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  clear: () => void;
  method: string;
};

/** 一条连接的帧流状态：最近收帧时间 + 累计收帧序号（首帧/回放判定用）。 */
export type AcpTransportState = { lastFrameAt: number; frameSeq: number };

/** 当前回合的拼接缓冲与进度状态。 */
export type AcpTurnState = {
  assembling: Map<string, string[]>;
  currentOnProgress: ((ev: AcpProgressEvent) => void) | null;
  answerStarted: boolean;
  thoughtStarted: boolean;
  seenUpdateTypes: Set<string>;
  seenTools: Set<string>;
  endedTools: Set<string>;
  /** 本回合开始时间（beginAcpTurn 写入）；首帧/首字耗时都以它为基准。 */
  startedAt: number;
  /** 本回合收到第一帧的时间；0 = 还没收到（诊断用，不参与超时判定）。 */
  firstFrameAt: number;
  /** 本回合绑定的 sessionId；只统计这个会话的帧，避免并发会话互相污染。 */
  sessionId: string | null;
};

export type AcpHost = {
  pending: Map<number, AcpPending>;
  turn: AcpTurnState;
  state: AcpTransportState;
  hasProcess(): boolean;
  /** 没有进程时 request/prompt 的拒绝文案（brain: no acp process；worker: no worker process）。 */
  noProcessMessage: string;
  nextId(): number;
  write(payload: Record<string, unknown>): void;
  /** 帧级诊断默认 INFO；协议错误/降级（ERROR 帧、模型或模式设置失败）显式传 WARN。 */
  log(message: string, level?: "info" | "warn" | "error"): void;
};

export function newTurnState(): AcpTurnState {
  return {
    assembling: new Map(),
    currentOnProgress: null,
    answerStarted: false,
    thoughtStarted: false,
    seenUpdateTypes: new Set(),
    seenTools: new Set(),
    endedTools: new Set(),
    startedAt: 0,
    firstFrameAt: 0,
    sessionId: null,
  };
}

/** 进程重建：丢掉当前回合的拼接缓冲与进度回调（不碰磁盘 session 映射）。 */
export function clearAcpTurn(turn: AcpTurnState): void {
  turn.assembling.clear();
  turn.currentOnProgress = null;
  turn.firstFrameAt = 0;
  turn.sessionId = null;
}

export function beginAcpTurn(
  turn: AcpTurnState,
  sessionId: string,
  onProgress?: (ev: AcpProgressEvent) => void,
): void {
  turn.assembling.set(sessionId, []);
  turn.currentOnProgress = onProgress ?? null;
  turn.answerStarted = false;
  turn.thoughtStarted = false;
  turn.seenUpdateTypes.clear();
  turn.seenTools.clear();
  turn.endedTools.clear();
  turn.startedAt = Date.now();
  turn.firstFrameAt = 0;
  turn.sessionId = sessionId;
}

/** 首帧耗时（毫秒）；还没收到任何帧时返回 -1。 */
export function acpTurnFirstFrameMs(turn: AcpTurnState): number {
  return turn.firstFrameAt ? turn.firstFrameAt - turn.startedAt : -1;
}

export function acpTurnText(turn: AcpTurnState, sessionId: string): string {
  return (turn.assembling.get(sessionId) ?? []).join("").trim();
}

export function acpTurnChunks(turn: AcpTurnState, sessionId: string): number {
  return (turn.assembling.get(sessionId) ?? []).length;
}

export function endAcpTurn(turn: AcpTurnState, sessionId: string): void {
  turn.currentOnProgress = null;
  turn.assembling.delete(sessionId);
}

/** 喂一段 stdout：按行解析 JSON，非 JSON 日志行跳过；解析出的帧交给 `onFrame`。 */
export function feedAcpStdout(
  decoder: LineDecoder,
  chunk: Buffer,
  onFrame: (f: Record<string, any>) => void,
): void {
  for (const line of decoder.push(chunk)) {
    let f: Record<string, any>;
    try {
      f = JSON.parse(line);
    } catch {
      continue; // 有的 agent 会往 stdout 混日志行（DSH 实测），非 JSON 直接跳过
    }
    onFrame(f);
  }
}

/**
 * 处理一帧：响应 → 兑现 pending；反向请求 → 走共用应答器；`session/update` → 进度与文本拼接。
 * 调用方负责把本函数挂到 stdout 解析后的每一帧上。
 */
export function handleAcpFrame(f: Record<string, any>, host: AcpHost): void {
  host.state.lastFrameAt = Date.now();
  host.state.frameSeq += 1;
  if (typeof f.id === "number" && (f.result !== undefined || f.error !== undefined)) {
    const p = host.pending.get(f.id);
    if (!p) return;
    p.clear();
    host.pending.delete(f.id);
    if (f.error) {
      host.log(`← ${p.method}#${f.id} ERROR ${JSON.stringify(f.error).slice(0, 200)}`, "warn");
      p.reject(new Error(JSON.stringify(f.error)));
    } else p.resolve(f.result);
    return;
  }
  // agent -> client 的反向请求（带 method + id）；必须应答，否则会挂到超时
  if (f.method && f.id !== undefined) {
    handleReverseRequest(
      f,
      (payload) => host.write(payload as Record<string, unknown>),
      (message) => host.log(message),
    );
    return;
  }
  const turn = host.turn;
  // 只记本回合自己的会话；并发 worker/控制桥的帧不能算进首帧。
  if (turn.sessionId && f.params?.sessionId === turn.sessionId && !turn.firstFrameAt) {
    turn.firstFrameAt = Date.now();
  }
  if (f.method === "session/update") {
    const u = f.params?.update;
    if (u?.sessionUpdate) turn.seenUpdateTypes.add(String(u.sessionUpdate)); // 诊断
    // 任意 session/update 帧都视为“活动” → 让 daemon 静默刷新心跳基线（流式期间不误报“仍在处理”）
    if (turn.currentOnProgress) {
      try {
        turn.currentOnProgress({ type: "activity" });
      } catch {
        /* ignore */
      }
    }
    if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      const arr = turn.assembling.get(f.params.sessionId);
      if (arr) arr.push(String(u.content.text ?? ""));
      if (!turn.answerStarted && turn.currentOnProgress) {
        turn.answerStarted = true;
        try {
          turn.currentOnProgress({ type: "answer" });
        } catch {
          /* ignore */
        }
      }
    } else if (u?.sessionUpdate === "agent_thought_chunk") {
      if (!turn.thoughtStarted && turn.currentOnProgress) {
        turn.thoughtStarted = true;
        try {
          turn.currentOnProgress({ type: "thinking" });
        } catch {
          /* ignore */
        }
      }
    } else if (
      (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") &&
      turn.currentOnProgress
    ) {
      const tid = String(u.toolCallId ?? u.title ?? ""); // 每个工具调用只上报一次 start
      const status = typeof u.status === "string" ? u.status : undefined;
      const purpose =
        typeof u.rawInput?.__tool_use_purpose === "string"
          ? clipDetail(u.rawInput.__tool_use_purpose)
          : undefined;
      const emit = (ev: AcpProgressEvent) => {
        try {
          turn.currentOnProgress?.(ev);
        } catch {
          /* ignore */
        }
      };
      if (tid && !turn.seenTools.has(tid)) {
        turn.seenTools.add(tid);
        emit({
          type: "tool",
          phase: "start",
          toolCallId: tid,
          kind: u.kind,
          purpose,
          title: u.title,
          detail: toolDetail(u.rawInput),
        });
        // 少数 agent 第一帧就带终态：补一个 end，保证结果 item 不丢。
        if (status && ["completed", "failed", "blocked"].includes(status)) {
          turn.endedTools.add(tid);
          emit({ type: "tool", phase: "end", toolCallId: tid, status, title: u.title });
        }
      } else if (
        tid &&
        status &&
        ["completed", "failed", "blocked"].includes(status) &&
        !turn.endedTools.has(tid)
      ) {
        turn.endedTools.add(tid);
        emit({ type: "tool", phase: "end", toolCallId: tid, status, title: u.title });
      }
    }
  }
}

/** 普通请求（initialize / session/new / load / resume / set_*）。 */
export function requestAcp(
  host: AcpHost,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!host.hasProcess()) {
      reject(new Error(host.noProcessMessage));
      return;
    }
    const id = host.nextId();
    host.log(`→ ${method}#${id}`);
    const t = setTimeout(() => {
      host.pending.delete(id);
      reject(new Error(`${method} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    host.pending.set(id, { resolve, reject, clear: () => clearTimeout(t), method });
    host.write({ jsonrpc: "2.0", id, method, params });
  });
}

export type PromptTimeouts = { idleMs: number; capMs: number; firstFrameMs: number };

/**
 * `session/prompt` 专用：空闲超时（`idleMs` 内无任何帧才判卡死）+ 首帧超时 + 硬上限（`capMs`）。
 * 只要 agent 还在出帧（工具进度/正文），就不打断——避免误杀“慢但在干活”的长回合。
 */
export function promptAcp(host: AcpHost, params: unknown, timeouts: PromptTimeouts): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!host.hasProcess()) {
      reject(new Error(host.noProcessMessage));
      return;
    }
    const id = host.nextId();
    const startedAt = Date.now();
    host.state.lastFrameAt = Date.now(); // 重置空闲基线：从本次 prompt 发出算起，避免用上一回合的旧时间戳误判
    const startSeq = host.state.frameSeq; // 记录起点，用于判定本回合是否出过帧
    host.log(
      `→ session/prompt#${id} (idle=${timeouts.idleMs}ms cap=${timeouts.capMs}ms firstFrame=${timeouts.firstFrameMs}ms)`,
    );
    const iv = setInterval(() => {
      const idle = Date.now() - host.state.lastFrameAt;
      const total = Date.now() - startedAt;
      const noFrameYet = host.state.frameSeq === startSeq; // 本回合从未出过帧
      const firstFrameTimeout = noFrameYet && total > timeouts.firstFrameMs;
      if (firstFrameTimeout || idle > timeouts.idleMs || total > timeouts.capMs) {
        if (host.pending.delete(id)) {
          clearInterval(iv);
          const why = firstFrameTimeout
            ? "no-first-frame"
            : idle > timeouts.idleMs
              ? "idle"
              : "cap";
          reject(new Error(`session/prompt ${why} timeout (idle=${idle}ms total=${total}ms)`));
        }
      }
    }, 5000);
    host.pending.set(id, {
      resolve,
      reject,
      clear: () => clearInterval(iv),
      method: "session/prompt",
    });
    host.write({ jsonrpc: "2.0", id, method: "session/prompt", params });
  });
}

/** 按配置选模型路由（如 DSH 的 deepseek-account）；没有 model 或模型已随启动参数传入的 agent 跳过。 */
export async function applyAcpModel(
  host: AcpHost,
  ag: ResolvedAgent,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  if (!ag.model || ag.modelArg) return;
  try {
    await requestAcp(
      host,
      "session/set_config_option",
      { sessionId, configId: "model", value: ag.model },
      timeoutMs,
    );
    host.log(`model set ${ag.model}`);
  } catch (e) {
    host.log(
      `model set failed (${String(e)}) → 继续用 agent 自己的默认模型；可用 wemind brain set <agent> --model 覆盖`,
      "warn",
    );
    // 不抛：模型是「跟随用户配置」的可选项，agent 升级后旧 model id 失效（如 DSH 0.2.1-rc.3）
    // 不应把整轮打成失败。继续用 session/new 的默认模型，日志留 WARN 供排查。
  }
}

/** 从 `session/new|load|resume` 的回包里取可用模式 id；agent 不报 `modes` 时返回 null（=不校验，照样尝试）。 */
export function availableAcpModes(res: any): string[] | null {
  const list = res?.modes?.availableModes;
  if (!Array.isArray(list)) return null;
  const ids = list.map((m: any) => String(m?.id ?? m)).filter(Boolean);
  return ids.length ? ids : null;
}

/** 会话建立/恢复后切到预设声明的模式（免审批：claude-code 的 bypassPermissions、codex 的 agent-full-access）。
 *  **失败只记日志、不抛**：模式不可用（如 claude-code 以 root 跑却没有 IS_SANDBOX）时进程仍可用，
 *  审批请求继续由应答器处理（默认拒绝，WEMIND_ACP_AUTO_ALLOW=1 放行）；抛错反而会把整轮打成失败。 */
export async function applyAcpSessionMode(
  host: AcpHost,
  ag: ResolvedAgent,
  sessionId: string,
  modes: string[] | null = null,
  timeoutMs: number,
): Promise<void> {
  if (!ag.sessionMode) return;
  if (modes && !modes.includes(ag.sessionMode)) {
    host.log(
      `session mode ${ag.sessionMode} 不在 agent 报告的可用模式 [${modes.join(",")}] 里——跳过；审批请求仍由应答器处理`,
    );
    return;
  }
  try {
    await requestAcp(host, "session/set_mode", { sessionId, modeId: ag.sessionMode }, timeoutMs);
    host.log(`session mode set ${ag.sessionMode}`);
  } catch (e) {
    host.log(`session mode set failed (${String(e)})——继续；审批请求仍由应答器处理`, "warn");
  }
}

/** 恢复会话后，agent 可能还在异步回放历史（gemini 的 loadSession 里 streamHistory 不 await）：
 *  先等帧流安静下来再开始本轮提问，否则回放的历史会被拼进答复。 */
export async function drainAcpReplay(host: AcpHost, ag: ResolvedAgent): Promise<void> {
  if (!ag.replayOnLoad) return;
  const before = host.state.frameSeq;
  const r = await waitForFrameQuiet({ seq: () => host.state.frameSeq });
  const drained = host.state.frameSeq - before;
  if (drained > 0) host.log(`drained ${drained} replay frame(s)${r.timedOut ? " (cap)" : ""}`);
}
