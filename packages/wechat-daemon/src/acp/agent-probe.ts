import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AGENT_DEFINITION_SCHEMA_VERSION,
  type AgentDefinition,
} from "../agents/agent-definition.js";
import { normalizeAcpMcpServers } from "../agents/managed/agent-mcp.js";
import { LineDecoder } from "../shared/io/line-decoder.js";
import { spawnAgent } from "../shared/process/spawn-agent.js";
import { isShellScriptPath, locateExecutable } from "../shared/process/executable.js";
import { disposeAgentProcess } from "../shared/process/dispose-agent.js";
import { handleReverseRequest } from "./protocol/acp-reverse.js";
import { writeAcpFrame } from "./protocol/write-frame.js";

/**
 * ACP 能力探针。
 *
 * 这是 `scripts/acp-probe.mjs` 搬家后的唯一实现：默认只做 `initialize` + `session/new`
 * （以及可选的 load/resume），不发真实 prompt。真实 prompt、图片与工具调用只在显式
 * `--deep` / `--image` / `--tool` 时执行，因为它们会花钱，并可能写进 agent 自己的会话历史。
 *
 * 探针只回答协议层问题；realHome、mcpFormat、凭据/继承清单这些「它是谁、东西放哪」的
 * 领域知识仍要人工补——`wemind agent spec` 会把两组字段分开说明。
 */

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+YF9sAAAAASUVORK5CYII=";

const DEFAULT_PROMPT = "Remember the secret word: PINEAPPLE. Reply with exactly: STORED";
const DEFAULT_SECOND_PROMPT = "What was the secret word? Reply with just the word.";
const DEFAULT_TOOL_PROMPT =
  "Create a file named drift-check.txt in the current directory containing exactly the text OK. Use your file/shell tools, do not ask me first. When done reply with exactly: WROTE";

export type ProbePromptResult = {
  ok: boolean;
  error?: string;
  elapsedMs: number;
  firstFrameMs: number | null;
  firstTextMs: number | null;
  answer: string;
  updateTypes: string[];
  toolCalls: number;
  stopReason?: string;
};

export type AgentProbeOptions = {
  bin: string;
  args: string[];
  shell?: boolean;
  cwd?: string;
  home?: string;
  homeEnv?: string;
  deep?: boolean;
  image?: boolean;
  tool?: boolean;
  prompt?: string;
  secondPrompt?: string;
  toolPrompt?: string;
  testMcp?: boolean;
  mcpServers?: unknown[];
  sessionMeta?: unknown;
  model?: string;
  reasoning?: string;
  timeoutMs?: number;
  keep?: boolean;
  hardKill?: boolean;
  rejectPermissions?: boolean;
  onLog?: (line: string) => void;
};

export type AgentProbeResult = {
  ok: boolean;
  fatal?: string;
  at: string;
  bin: string;
  args: string[];
  shell: boolean;
  cwd: string;
  homeEnv?: string;
  agentVersion?: string;
  initialize?: any;
  sessionNew?: any;
  sessionId?: string;
  configOptions: unknown[];
  sessionModes: string[];
  declared: { loadSession: boolean; resume: boolean; images: boolean };
  mcpServers: { tested: boolean; accepted?: boolean; error?: string };
  restore: {
    used?: "load" | "resume";
    load?: { ok: boolean; error?: string };
    resume?: { ok: boolean; error?: string };
    replayFrames?: number;
  };
  deep?: {
    prompt1?: ProbePromptResult;
    image?: ProbePromptResult;
    tool?: {
      ok: boolean;
      permissionRequests: number;
      fileWritten: boolean;
      answer: string;
    };
    prompt2?: ProbePromptResult;
    contextKept?: boolean;
  };
  setModel?: unknown;
  setReasoning?: unknown;
  reverseRequests: string[];
  logs: string[];
};

type Frame = Record<string, any>;

/** Windows 的 `.cmd`/`.bat` 无 shell 直接 spawn 会 EINVAL；仅在未显式指定时自动兜底。 */
export function probeUsesShell(
  bin: string,
  explicit: boolean | undefined,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (explicit !== undefined) return explicit;
  if (platform !== "win32") return false;
  const resolved = locateExecutable(bin, { platform, env }) ?? bin;
  return isShellScriptPath(resolved, platform);
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : JSON.stringify(e);
}

function frameError(frame: Frame): string {
  const e = frame.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") return String(e.message ?? JSON.stringify(e));
  return JSON.stringify(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等第一个探针进程真正退出，再起第二个。
 *
 * disposeAgentProcess 已经 taskkill / SIGKILL 并 destroy 三路 stdio，正常情况下 exit 几毫秒内就到。
 * 原来固定 sleep(500) 是为了「别和还活着的进程抢同一份会话库」，但它每次都白等 0.5 秒（probeAgent 一个
 * 用例要探两轮，13 个用例就是约 7 秒）。这里改成等 exit（最多 2 秒兜底）：进程没了，锁自然就放开了。
 */
async function waitForExit(
  child: Pick<ChildProcessWithoutNullStreams, "exitCode" | "signalCode" | "once">,
  timeoutMs = 2000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(timeoutMs),
  ]);
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map((v) => String(v ?? "")).filter(Boolean))];
}

/** 从 `modes.availableModes` 与 `configOptions[mode]` 里收集模式 id；不同 agent 两处都可能报。 */
function extractSessionModes(res: any): string[] {
  const modes: string[] = [];
  const available = res?.modes?.availableModes;
  if (Array.isArray(available))
    for (const mode of available) modes.push(String(mode?.id ?? mode ?? ""));
  const options = Array.isArray(res?.configOptions) ? res.configOptions : [];
  const modeOption = options.find((o: any) => String(o?.id ?? o?.category ?? "") === "mode");
  if (Array.isArray(modeOption?.options))
    for (const option of modeOption.options)
      modes.push(String(option?.value ?? option?.id ?? option ?? ""));
  return uniqueStrings(modes);
}

function extractAgentVersion(initialize: any): string | undefined {
  const info = initialize?.agentInfo;
  if (typeof info === "string" && info) return info;
  if (info && typeof info === "object") {
    const version = info.version ?? info.name;
    if (typeof version === "string" && version) return version;
  }
  return undefined;
}

function createFakeMcp(root: string): string {
  const file = path.join(root, "fake-mcp.cjs");
  fs.writeFileSync(
    file,
    `const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") {
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "wemind-probe", version: "1" } } });
    return;
  }
  if (m.method === "tools/list") {
    send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "probe_ping", description: "probe", inputSchema: { type: "object", properties: {} } }] } });
    return;
  }
  if (m.method === "tools/call") {
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "probe-ok" }] } });
    return;
  }
  if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "probe does not implement" } });
});
`,
    "utf-8",
  );
  return file;
}

class ProbeClient {
  readonly child;
  private readonly decoder = new LineDecoder();
  private readonly pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private seq = 0;
  private promptStart = 0;
  private firstAnyFrameMs: number | null = null;
  private firstTextMs: number | null = null;
  private answer: string[] = [];
  private updateTypes = new Set<string>();
  private toolCallCount = 0;
  private stderrTail: string[] = [];
  private mcpServers: unknown[] = [];
  private disposed = false;
  readonly reverse: string[] = [];
  frameSeq = 0;
  messageFrameSeq = 0;
  sid?: string;

  constructor(
    private readonly opts: AgentProbeOptions,
    private readonly cwd: string,
    env: NodeJS.ProcessEnv,
    private readonly log: (line: string) => void,
  ) {
    this.child = spawnAgent(
      { bin: opts.bin, args: opts.args, shell: opts.shell === true },
      { cwd, env },
    );
    this.child.stdout.on("data", (d) => {
      for (const line of this.decoder.push(d)) {
        let frame: Frame;
        try {
          frame = JSON.parse(line);
        } catch {
          this.log(`[stdout 非 JSON] ${line.slice(0, 200)}`);
          continue;
        }
        this.handle(frame);
      }
    });
    this.child.stderr.on("data", (d) => {
      const text = d.toString().trim();
      if (!text) return;
      this.stderrTail.push(text.slice(0, 2000));
      if (this.stderrTail.length > 20) this.stderrTail.shift();
      this.log(`[stderr] ${text.slice(0, 500)}`);
    });
    this.child.stdin.on("error", (e) => {
      const message = `stdin 写入失败：${errText(e)}`;
      this.log(message);
      this.failPending(message);
    });
    this.child.on("error", (e) => {
      const message = `进程启动或运行失败：${errText(e)}`;
      this.log(message);
      this.failPending(message);
    });
    this.child.on("exit", (code) => {
      const msg = `进程已退出（code=${code}）`;
      this.failPending(msg);
    });
  }

  stderrText(): string {
    return this.stderrTail.join("\n").slice(-500);
  }

  private failPending(message: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
  }

  private handle(frame: Frame): void {
    if (typeof frame.id === "number" && frame.method === undefined) {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error !== undefined) pending.reject(new Error(frameError(frame)));
      else pending.resolve(frame.result);
      return;
    }
    if (frame.method && frame.id !== undefined) {
      this.reverse.push(String(frame.method));
      handleReverseRequest(
        frame,
        (payload) =>
          writeAcpFrame(this.child.stdin, payload, (error) =>
            this.log(`反向请求写回失败：${error.message}`),
          ),
        this.log,
        { autoAllow: this.opts.rejectPermissions === true ? false : undefined },
      );
      return;
    }
    if (frame.method !== "session/update") return;
    this.frameSeq++;
    const update = frame.params?.update;
    const type = String(update?.sessionUpdate ?? "");
    if (type) this.updateTypes.add(type);
    const now = Date.now();
    if (this.promptStart && this.firstAnyFrameMs === null && now >= this.promptStart)
      this.firstAnyFrameMs = now - this.promptStart;
    if (
      type === "agent_message_chunk" &&
      update?.content?.type === "text" &&
      typeof update.content.text === "string"
    ) {
      if (this.promptStart && this.firstTextMs === null && now >= this.promptStart)
        this.firstTextMs = now - this.promptStart;
      this.answer.push(update.content.text);
      this.messageFrameSeq++;
    }
    if (type === "tool_call" || type === "tool_call_update") this.toolCallCount++;
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child.stdin.writable) {
        reject(new Error("stdin 不可写"));
        return;
      }
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const written = writeAcpFrame(
        this.child.stdin,
        { jsonrpc: "2.0", id, method, params },
        (error) => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(new Error(`${method} 写入失败：${error.message}`));
        },
      );
      if (!written) {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error(`${method} 写入失败：stdin 不可写`));
      }
    });
  }

  async initialize(): Promise<any> {
    return this.request(
      "initialize",
      { protocolVersion: 1, clientCapabilities: {} },
      this.timeout(),
    );
  }

  async newSession(mcpServers: unknown[]): Promise<any> {
    const params: Record<string, unknown> = { cwd: this.cwd, mcpServers };
    this.mcpServers = mcpServers;
    if (this.opts.sessionMeta !== undefined) params._meta = this.opts.sessionMeta;
    const result = await this.request("session/new", params, this.timeout());
    this.sid = result?.sessionId;
    return result;
  }

  /** 恢复发生在第二个进程；沿用它实际测试过的 MCP 声明，不能退化成空数组。 */
  useMcpServers(mcpServers: unknown[]): void {
    this.mcpServers = mcpServers;
  }

  async load(sessionId: string): Promise<any> {
    const params: Record<string, unknown> = {
      sessionId,
      cwd: this.cwd,
      mcpServers: this.mcpServers,
    };
    if (this.opts.sessionMeta !== undefined) params._meta = this.opts.sessionMeta;
    const result = await this.request("session/load", params, this.timeout());
    this.sid = sessionId;
    return result;
  }

  async resume(sessionId: string): Promise<any> {
    const params: Record<string, unknown> = {
      sessionId,
      cwd: this.cwd,
      mcpServers: this.mcpServers,
    };
    if (this.opts.sessionMeta !== undefined) params._meta = this.opts.sessionMeta;
    const result = await this.request("session/resume", params, this.timeout());
    this.sid = sessionId;
    return result;
  }

  async setConfig(configId: string, value: unknown): Promise<any> {
    if (!this.sid) return { skipped: "no session" };
    return this.request(
      "session/set_config_option",
      { sessionId: this.sid, configId, value },
      this.timeout(),
    );
  }

  async prompt(blocks: unknown[]): Promise<ProbePromptResult> {
    this.answer = [];
    this.updateTypes = new Set();
    this.toolCallCount = 0;
    this.firstAnyFrameMs = null;
    this.firstTextMs = null;
    this.promptStart = Date.now();
    const started = Date.now();
    let result: any;
    let error: string | undefined;
    try {
      result = await this.request(
        "session/prompt",
        { sessionId: this.sid, prompt: blocks },
        this.timeout(),
      );
    } catch (e) {
      error = errText(e);
    }
    const elapsedMs = Date.now() - started;
    const firstFrameMs = this.firstAnyFrameMs ?? (error ? null : elapsedMs);
    this.promptStart = 0;
    return {
      ok: !error,
      ...(error ? { error } : {}),
      elapsedMs,
      firstFrameMs,
      firstTextMs: this.firstTextMs,
      answer: this.answer.join(""),
      updateTypes: [...this.updateTypes],
      toolCalls: this.toolCallCount,
      ...(result?.stopReason ? { stopReason: String(result.stopReason) } : {}),
    };
  }

  async close(): Promise<void> {
    if (!this.sid) return;
    try {
      await this.request("session/close", { sessionId: this.sid }, 30_000);
    } catch {
      /* session/close 不是所有 agent 都实现；best-effort */
    }
  }

  kill(): void {
    if (this.disposed) return;
    this.disposed = true;
    disposeAgentProcess(this.child);
  }

  private timeout(): number {
    return Number(this.opts.timeoutMs) > 0 ? Number(this.opts.timeoutMs) : 180_000;
  }
}

function probeEnv(opts: AgentProbeOptions, home: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (home && opts.homeEnv) env[opts.homeEnv] = home;
  else if (home) {
    env.HOME = home;
    if (process.platform === "win32") env.USERPROFILE = home;
  }
  return env;
}

function isTempPath(value: string | undefined): boolean {
  if (!value) return false;
  return path.resolve(value).startsWith(path.resolve(os.tmpdir()) + path.sep);
}

function inferRestore(
  initialize: any,
  actual: AgentProbeResult["restore"],
): { loadSession: boolean; resume: boolean } {
  const caps = initialize?.agentCapabilities ?? {};
  const sessionCaps = caps?.sessionCapabilities ?? {};
  return {
    loadSession: actual.load?.ok === true || caps?.loadSession === true,
    resume: actual.resume?.ok === true || sessionCaps?.resume === true || caps?.resume === true,
  };
}

export async function probeAgent(rawOpts: AgentProbeOptions): Promise<AgentProbeResult> {
  const resolvedBin = locateExecutable(rawOpts.bin) ?? rawOpts.bin;
  const opts: AgentProbeOptions = {
    ...rawOpts,
    bin: resolvedBin,
    shell: probeUsesShell(rawOpts.bin, rawOpts.shell),
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-agent-probe-"));
  const cwd = opts.cwd ? path.resolve(opts.cwd) : path.join(root, "cwd");
  const home = opts.home ? path.resolve(opts.home) : opts.homeEnv ? path.join(root, "home") : null;
  fs.mkdirSync(cwd, { recursive: true });
  if (home) fs.mkdirSync(home, { recursive: true });
  const logLines: string[] = [];
  let logBytes = 0;
  const log = (line: string): void => {
    const text = line.length > 4000 ? `${line.slice(0, 4000)}…（已截断）` : line;
    logBytes += Buffer.byteLength(text, "utf8");
    if (logLines.length < 500 && logBytes <= 64 * 1024) logLines.push(text);
    opts.onLog?.(text);
  };
  const env = probeEnv(opts, home);
  const result: AgentProbeResult = {
    ok: false,
    at: new Date().toISOString(),
    bin: rawOpts.bin,
    args: opts.args,
    shell: opts.shell === true,
    cwd,
    ...(opts.homeEnv ? { homeEnv: `${opts.homeEnv}=${home ?? ""}` } : {}),
    configOptions: [],
    sessionModes: [],
    declared: { loadSession: false, resume: false, images: false },
    mcpServers: { tested: false },
    restore: {},
    reverseRequests: [],
    logs: logLines,
  };
  let first: ProbeClient | null = null;
  let second: ProbeClient | null = null;
  const cleanup = (): void => {
    try {
      first?.kill();
    } catch {
      /* ignore */
    }
    try {
      second?.kill();
    } catch {
      /* ignore */
    }
    if (!opts.keep && isTempPath(root)) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    const resolvedHome = home ? path.resolve(home) : "";
    const resolvedRoot = path.resolve(root);
    if (
      !opts.keep &&
      opts.home &&
      resolvedHome &&
      isTempPath(resolvedHome) &&
      resolvedHome !== resolvedRoot &&
      !resolvedHome.startsWith(resolvedRoot + path.sep)
    ) {
      try {
        fs.rmSync(resolvedHome, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  };
  try {
    first = new ProbeClient(opts, cwd, env, log);
    result.initialize = await first.initialize();
    result.agentVersion = extractAgentVersion(result.initialize);

    let mcpServers: unknown[] = [];
    if (opts.mcpServers !== undefined) {
      mcpServers = normalizeAcpMcpServers(opts.mcpServers);
      result.mcpServers.tested = mcpServers.length > 0;
    } else if (opts.testMcp !== false) {
      const fake = createFakeMcp(root);
      mcpServers = [
        {
          name: "wemind_probe",
          command: process.execPath,
          args: [fake],
          env: [],
        },
      ];
      result.mcpServers.tested = true;
    }
    if (mcpServers.length) {
      try {
        result.sessionNew = await first.newSession(mcpServers);
        result.mcpServers.accepted = true;
      } catch (e) {
        result.mcpServers.accepted = false;
        result.mcpServers.error = errText(e);
        log(`session/new 带非空 mcpServers 失败：${result.mcpServers.error}`);
        // 回退后的空列表才是实际建立的会话参数；第二个进程恢复时必须沿用它，
        // 否则会把刚才被拒绝的非空列表再发一遍，导致 load/resume 失败。
        mcpServers = [];
        result.sessionNew = await first.newSession([]);
      }
    } else {
      result.sessionNew = await first.newSession([]);
    }
    result.sessionId = first.sid;
    if (!result.sessionId)
      throw new Error("session/new 没有返回 sessionId——这个 agent 的 ACP 实现不完整");
    result.configOptions = Array.isArray(result.sessionNew?.configOptions)
      ? result.sessionNew.configOptions
      : [];
    result.sessionModes = extractSessionModes(result.sessionNew);
    const caps = result.initialize?.agentCapabilities ?? {};
    result.declared = {
      loadSession: caps?.loadSession === true,
      resume: caps?.sessionCapabilities?.resume === true || caps?.resume === true,
      images: caps?.promptCapabilities?.image === true,
    };
    log(
      `initialize ok；loadSession=${result.declared.loadSession} resume=${result.declared.resume} image声明=${result.declared.images}`,
    );
    log(`session/new ok；sessionId=${result.sessionId}`);

    if (opts.model) {
      try {
        result.setModel = await first.setConfig("model", opts.model);
      } catch (e) {
        result.setModel = { error: errText(e) };
      }
    }
    if (opts.reasoning) {
      try {
        result.setReasoning = await first.setConfig("reasoning_effort", opts.reasoning);
      } catch (e) {
        result.setReasoning = { error: errText(e) };
      }
    }

    if (opts.deep) {
      result.deep = {};
      result.deep.prompt1 = await first.prompt([
        { type: "text", text: opts.prompt || DEFAULT_PROMPT },
      ]);
      log(`prompt1 ok=${result.deep.prompt1.ok} firstFrame=${result.deep.prompt1.firstFrameMs}ms`);
      if (opts.image) {
        result.deep.image = await first.prompt([
          { type: "image", mimeType: "image/png", data: PNG_1X1 },
          { type: "text", text: "Describe this image in one word." },
        ]);
        log(`image prompt ok=${result.deep.image.ok}`);
      }
      if (opts.tool) {
        const reverseBefore = first.reverse.length;
        const marker = path.join(cwd, "drift-check.txt");
        try {
          fs.rmSync(marker, { force: true });
        } catch {
          /* ignore */
        }
        const toolPrompt = await first.prompt([
          { type: "text", text: opts.toolPrompt || DEFAULT_TOOL_PROMPT },
        ]);
        const permissionRequests = first.reverse
          .slice(reverseBefore)
          .filter((m) => m === "session/request_permission").length;
        result.deep.tool = {
          ok: toolPrompt.ok && fs.existsSync(marker) && permissionRequests === 0,
          permissionRequests,
          fileWritten: fs.existsSync(marker),
          answer: toolPrompt.answer.slice(0, 120),
        };
        log(
          `tool test ok=${result.deep.tool.ok} permission=${permissionRequests} fileWritten=${result.deep.tool.fileWritten}`,
        );
      }
    }

    const originalSession = result.sessionId;
    if (!opts.hardKill) await first.close();
    first.kill();
    await waitForExit(first.child);

    second = new ProbeClient(opts, cwd, env, log);
    second.useMcpServers(mcpServers);
    await second.initialize();
    const replayBefore = second.messageFrameSeq;
    try {
      await second.load(originalSession);
      result.restore.used = "load";
      result.restore.load = { ok: true };
    } catch (e) {
      result.restore.load = { ok: false, error: errText(e) };
      try {
        await second.resume(originalSession);
        result.restore.used = "resume";
        result.restore.resume = { ok: true };
      } catch (resumeError) {
        result.restore.resume = { ok: false, error: errText(resumeError) };
      }
    }
    log(`restore=${result.restore.used ?? "失败"}`);

    if (opts.deep && second.sid) {
      const deep = result.deep ?? (result.deep = {});
      await sleep(400);
      result.restore.replayFrames = second.messageFrameSeq - replayBefore;
      deep.prompt2 = await second.prompt([
        { type: "text", text: opts.secondPrompt || DEFAULT_SECOND_PROMPT },
      ]);
      deep.contextKept = /PINEAPPLE/i.test(deep.prompt2.answer);
      log(
        `prompt2 ok=${deep.prompt2.ok} contextKept=${deep.contextKept} replayFrames=${result.restore.replayFrames}`,
      );
    }

    const actual = inferRestore(result.initialize, result.restore);
    result.declared = { ...result.declared, ...actual };
    result.reverseRequests = first.reverse.concat(second.reverse);
    const deepOk =
      !opts.deep ||
      (result.deep?.prompt1?.ok === true &&
        result.restore.used !== undefined &&
        result.deep?.prompt2?.ok === true &&
        result.deep?.contextKept === true &&
        (!opts.image || result.deep?.image?.ok === true) &&
        (!opts.tool || result.deep?.tool?.ok === true));
    result.ok = deepOk;
  } catch (e) {
    result.fatal = errText(e);
    result.ok = false;
    log(`fatal: ${result.fatal}`);
  } finally {
    cleanup();
  }
  return result;
}

/** 从二进制名推断一个合法的定义名；用户可用 --name 覆盖。 */
export function inferAgentName(bin: string): string {
  const base = path
    .basename(bin)
    .replace(/\.(exe|cmd|bat|ps1)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  if (/^[a-z0-9]/.test(base)) return base || "new-agent";
  return `agent-${base || "new"}`;
}

/**
 * 把探针结论落成草稿。只填协议层能确认的字段；未知的领域字段留空，并在 notes 里列出待补项。
 * 这样 `agent check --schema` 一次就能通过，但不会让模型误以为整份定义已经完整。
 */
export function draftFromProbe(
  probe: AgentProbeResult,
  opts: { name?: string } = {},
): AgentDefinition {
  const name = opts.name?.trim() || inferAgentName(probe.bin);
  const notes: string[] = [
    "探针只填了协议层结论；请补 realHome、configSubdir、mcpConfigFile、catalogFile、mcpFormat、credentialFiles、identityFiles、settingsBase、inheritDirs、requiresBins 等实际需要的人工字段（见 wemind agent spec）。",
  ];
  if (probe.mcpServers.tested && probe.mcpServers.accepted !== undefined) {
    notes.push(
      probe.mcpServers.accepted
        ? "session/new 接受了非空 mcpServers，但这只代表协议层接受，不代表 agent 真的加载了工具；MCP 仍需真机验证。"
        : "session/new 拒绝非空 mcpServers，草稿按写配置文件处理；mcpConfigFile 仍需人工补。",
    );
  } else {
    notes.push("未测试 ACP mcpServers；acpMcpServers / mcpDelivery 未填写。");
  }
  if (probe.sessionModes.length) {
    notes.push(
      `session/new 报告的模式：${probe.sessionModes.join("、")}；sessionMode 没有自动选择，免审批模式要人工确认。`,
    );
  }
  if (probe.restore.used) {
    notes.push(`实际恢复方式：${probe.restore.used}。`);
    if ((probe.restore.replayFrames ?? 0) > 0) {
      notes.push(
        `恢复后仍收到 ${probe.restore.replayFrames} 个历史回放帧；已填写 replayOnLoad=true，恢复后先等帧流安静。`,
      );
    }
  } else if (probe.declared.loadSession || probe.declared.resume) {
    notes.push(
      `initialize 声明了 load/resume（loadSession=${probe.declared.loadSession}，resume=${probe.declared.resume}），但实际恢复未成功；restore 字段未填写。`,
    );
  }
  if (!probe.deep) {
    notes.push("未发真实 prompt；images、replayOnLoad、firstFrameMs 仍需 --deep 验证。");
  } else if (probe.deep.image) {
    notes.push(
      `图片 prompt ${probe.deep.image.ok ? "被接受" : "被拒绝或失败"}（images 已按实测填写）。`,
    );
  }
  if (
    probe.deep?.prompt1?.firstFrameMs !== null &&
    probe.deep?.prompt1?.firstFrameMs !== undefined
  ) {
    notes.push(
      `首帧实测 ${probe.deep.prompt1.firstFrameMs}ms；firstFrameMs 是超时上限，不自动照抄，慢启动时再按实测留余量填写。`,
    );
  }
  if (probe.deep?.contextKept === false) {
    notes.push("恢复后上下文未保留（contextKept=false）；不要把会话恢复当成已适配。");
  }
  const draft: AgentDefinition = {
    schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
    name,
    bin: probe.bin,
    args: probe.args,
    ...(probe.shell ? { shell: true } : {}),
    ...(probe.mcpServers.accepted === true
      ? { acpMcpServers: true, mcpDelivery: "acp" as const }
      : probe.mcpServers.accepted === false
        ? { acpMcpServers: false, mcpDelivery: "config" as const }
        : {}),
    ...(probe.restore.used ? { restore: probe.restore.used } : {}),
    ...((probe.restore.replayFrames ?? 0) > 0 ? { replayOnLoad: true } : {}),
    ...(probe.deep?.image ? { images: probe.deep.image.ok } : {}),
    probe: {
      at: probe.at,
      ...(probe.agentVersion ? { agentVersion: probe.agentVersion } : {}),
    },
    notes,
  };
  return draft;
}
