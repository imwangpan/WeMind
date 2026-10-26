// ACP capability probe: initialize → session/new → prompt → close → kill → load/resume → prompt.
// Mirrors WeMind's acp-brain.ts (newline-delimited JSON-RPC, clientCapabilities: {}),
// records capabilities, first-frame latency, update types, reverse requests, and
// whether the agent preserves context across a restart.
//
// Usage (PowerShell):
//   $env:ACP_BIN = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
//   $env:ACP_ARGS = '["--profile","acp"]'
//   $env:ACP_SHELL = "1"
//   $env:ACP_HOME_ENV = "DSH_HOME"
//   $env:ACP_HOME = "$env:TEMP\dsh-probe-home"   # optional; keep credentials isolated
//   $env:ACP_MODEL = '["deepseek-account","deepseek-flash"]'  # optional; session/set_config_option
//   $env:ACP_REASONING = "high"                  # optional; session/set_config_option
//   $env:ACP_PROMPT = "Remember the secret word: PINEAPPLE. Reply with exactly: STORED"
//   $env:ACP_SECOND = "What was the secret word? Reply with just the word."
//   node scripts/acp-probe.mjs
//
// Optional:
//   ACP_TEST_IMAGE=1     send a 1x1 PNG prompt and record accept/reject
//   ACP_TEST_MCP='[{"name":"fake","command":"...","args":[]}]'  pass mcpServers to session/new
//   ACP_KEEP=1           keep ACP_HOME (contains sessions) after the run
//   ACP_HARD_KILL=1      skip session/close; kill the process (simulates WeMind self-heal)
//   ACP_TIMEOUT_MS=180000
//
// Output: human-readable log on stderr, one JSON summary on stdout.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = process.env.ACP_BIN || "opencode";
const ARGS = JSON.parse(process.env.ACP_ARGS || '["acp"]');
const SHELL = process.env.ACP_SHELL === "1";
const CWD = process.env.ACP_CWD || path.join(os.tmpdir(), "wemind-acp-probe");
const HOME_ENV = process.env.ACP_HOME_ENV || "";
const HOME = process.env.ACP_HOME || "";
const FIRST_PROMPT =
  process.env.ACP_PROMPT || "Remember the secret word: PINEAPPLE. Reply with exactly: STORED";
const SECOND_PROMPT =
  process.env.ACP_SECOND || "What was the secret word? Reply with just the word.";
const TEST_IMAGE = process.env.ACP_TEST_IMAGE === "1";
const TEST_MCP = process.env.ACP_TEST_MCP ? JSON.parse(process.env.ACP_TEST_MCP) : [];
const MODEL = process.env.ACP_MODEL || "";
const REASONING = process.env.ACP_REASONING || "";
const KEEP = process.env.ACP_KEEP === "1";
const HARD_KILL = process.env.ACP_HARD_KILL === "1";
const TIMEOUT_MS = Number(process.env.ACP_TIMEOUT_MS || 180_000);

const log = (...a) => console.error("[acp-probe]", ...a);
const short = (v, n = 500) => JSON.stringify(v)?.slice(0, n);

fs.mkdirSync(CWD, { recursive: true });
if (HOME) fs.mkdirSync(HOME, { recursive: true });

/** Node's shell:true + args[] is DEP0190; build one quoted command line instead. */
function quoteCmd(arg) {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}
function quoteSh(arg) {
  if (arg === "") return "''";
  if (!/[^\w@%+=:,./-]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
function commandLine() {
  const quote = process.platform === "win32" ? quoteCmd : quoteSh;
  return [BIN, ...ARGS].map(quote).join(" ");
}

class Client {
  constructor(label) {
    this.label = label;
    this.buf = "";
    this.frames = [];
    this.pending = new Map();
    this.idc = 0;
    this.updateTypes = new Set();
    this.reverse = [];
    this.answer = [];
    this.promptStart = 0;
    this.firstAnyFrameMs = null;
    this.firstTextMs = null;
    this.toolCalls = [];
    const env = { ...process.env };
    if (HOME_ENV && HOME) env[HOME_ENV] = HOME;
    this.child = SHELL
      ? spawn(commandLine(), { cwd: CWD, env, stdio: ["pipe", "pipe", "pipe"], shell: true, windowsHide: true })
      : spawn(BIN, ARGS, { cwd: CWD, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stdout.on("data", (d) => this.onData(d));
    this.child.stderr.on("data", (d) => log(`${label} stderr:`, d.toString().trim().slice(0, 400)));
    this.child.on("exit", (code) => log(`${label} exited code=${code}`));
  }

  onData(d) {
    this.buf += d.toString();
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let f;
      try {
        f = JSON.parse(line);
      } catch {
        log(`${this.label} non-JSON stdout:`, line.slice(0, 200));
        continue;
      }
      this.frames.push(f);
      this.handle(f);
    }
  }

  handle(f) {
    if (typeof f.id === "number" && (f.result !== undefined || f.error !== undefined)) {
      const p = this.pending.get(f.id);
      if (!p) return;
      this.pending.delete(f.id);
      clearTimeout(p.timer);
      if (f.error) p.reject(new Error(short(f.error, 800)));
      else p.resolve(f.result);
      return;
    }
    // Server -> client request (reverse request): must answer or the agent waits.
    if (f.method && f.id !== undefined) {
      this.reverse.push({ method: f.method, params: f.params });
      log(`${this.label} >>> REVERSE:`, f.method, short(f.params, 300));
      let result;
      if (f.method === "session/request_permission") {
        result = { outcome: { outcome: "cancelled" } };
      }
      const msg = result
        ? { jsonrpc: "2.0", id: f.id, result }
        : { jsonrpc: "2.0", id: f.id, error: { code: -32601, message: "probe does not support" } };
      this.child.stdin.write(JSON.stringify(msg) + "\n");
      return;
    }
    if (f.method === "session/update") {
      const u = f.params?.update;
      const now = Date.now();
      if (u?.sessionUpdate) this.updateTypes.add(String(u.sessionUpdate));
      if (this.promptStart && this.firstAnyFrameMs === null && now >= this.promptStart) {
        this.firstAnyFrameMs = now - this.promptStart;
      }
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        if (this.promptStart && this.firstTextMs === null && now >= this.promptStart) {
          this.firstTextMs = now - this.promptStart;
        }
        this.answer.push(String(u.content.text ?? ""));
      }
      if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") {
        this.toolCalls.push({ kind: u.kind, title: u.title, status: u.status });
      }
    }
  }

  request(method, params, timeoutMs = TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.child.stdin.writable) {
        reject(new Error("stdin not writable"));
        return;
      }
      const id = ++this.idc;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async prompt(text) {
    this.answer = [];
    this.updateTypes = new Set();
    this.toolCalls = [];
    this.firstAnyFrameMs = null;
    this.firstTextMs = null;
    this.promptStart = Date.now();
    const started = Date.now();
    let result;
    let error;
    try {
      result = await this.request("session/prompt", {
        sessionId: this.sid,
        prompt: [{ type: "text", text }],
      });
    } catch (e) {
      error = e.message;
    }
    const elapsed = Date.now() - started;
    this.promptStart = 0;
    return {
      ok: !error,
      error,
      elapsedMs: elapsed,
      firstAnyFrameMs: this.firstAnyFrameMs,
      firstTextMs: this.firstTextMs,
      answer: this.answer.join(""),
      updateTypes: [...this.updateTypes],
      toolCalls: this.toolCalls.length,
      stopReason: result?.stopReason,
    };
  }

  async initialize() {
    return this.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  }

  async newSession(mcpServers = TEST_MCP) {
    const r = await this.request("session/new", { cwd: CWD, mcpServers });
    this.sid = r?.sessionId;
    return r;
  }

  /** ACP `session/set_config_option`; param shape follows the published profile. */
  async setConfig(configId, value) {
    if (!this.sid || value === undefined || value === "") return { skipped: true };
    return this.request("session/set_config_option", {
      sessionId: this.sid,
      configId,
      value,
    });
  }

  async close() {
    if (!this.sid) return { skipped: true };
    try {
      return await this.request("session/close", { sessionId: this.sid }, 30_000);
    } catch (e) {
      return { error: e.message };
    }
  }

  kill() {
    const pid = this.child.pid;
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        this.child.kill("SIGKILL");
      }
    } catch {
      /* ignore */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const png1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+YF9sAAAAASUVORK5CYII=";

(async () => {
  const summary = {
    bin: BIN,
    args: ARGS,
    shell: SHELL,
    cwd: CWD,
    homeEnv: HOME_ENV ? `${HOME_ENV}=${HOME}` : undefined,
    time: new Date().toISOString(),
  };
  let first;
  let second;
  try {
    first = new Client("first");
    summary.initialize = await first.initialize();
    log("initialize:", short(summary.initialize, 1200));
    summary.sessionNew = await first.newSession();
    log("session/new:", short(summary.sessionNew, 800));
    if (!first.sid) throw new Error("session/new returned no sessionId");

    if (MODEL) {
      try {
        summary.setModel = await first.setConfig("model", MODEL);
      } catch (e) {
        summary.setModel = { error: e.message };
      }
      log("set model:", short(summary.setModel, 600));
    }
    if (REASONING) {
      try {
        summary.setReasoning = await first.setConfig("reasoning_effort", REASONING);
      } catch (e) {
        summary.setReasoning = { error: e.message };
      }
      log("set reasoning:", short(summary.setReasoning, 600));
    }

    summary.prompt1 = await first.prompt(FIRST_PROMPT);
    log("prompt1:", short(summary.prompt1, 1200));

    if (TEST_IMAGE) {
      const started = Date.now();
      try {
        summary.image = await first.request(
          "session/prompt",
          {
            sessionId: first.sid,
            prompt: [
              { type: "image", mimeType: "image/png", data: png1x1 },
              { type: "text", text: "Describe this image in one word." },
            ],
          },
          60_000,
        );
      } catch (e) {
        summary.image = { error: e.message };
      }
      summary.image.elapsedMs = Date.now() - started;
      log("image prompt:", short(summary.image, 600));
    }

    summary.close = HARD_KILL ? { skipped: "ACP_HARD_KILL=1" } : await first.close();
    first.kill();
    await sleep(800);

    second = new Client("second");
    summary.initialize2 = await second.initialize();

    try {
      summary.load = await second.request("session/load", {
        sessionId: first.sid,
        cwd: CWD,
        mcpServers: TEST_MCP,
      });
    } catch (e) {
      summary.load = { error: e.message };
    }
    log("session/load:", short(summary.load, 600));

    if (!summary.load.error) {
      second.sid = first.sid;
      summary.resume = { skipped: "session/load ok" };
    } else {
      try {
        summary.resume = await second.request("session/resume", {
          sessionId: first.sid,
          cwd: CWD,
          mcpServers: TEST_MCP,
        });
        second.sid = first.sid;
      } catch (e) {
        summary.resume = { error: e.message };
      }
    }
    log("session/resume:", short(summary.resume, 600));

    if (second.sid) {
      summary.prompt2 = await second.prompt(SECOND_PROMPT);
      summary.contextKept = /PINEAPPLE/i.test(summary.prompt2.answer || "");
      log("prompt2:", short(summary.prompt2, 1200));
      log("contextKept:", summary.contextKept);
    } else {
      summary.contextKept = false;
    }

    summary.reverseRequests = first.reverse
      .concat(second.reverse)
      .map((r) => r.method);
    summary.resumeOk = !!second.sid && !summary.resume?.error;
    summary.ok = !!summary.prompt1?.ok && !!summary.contextKept;
  } catch (e) {
    summary.fatal = e instanceof Error ? e.message : String(e);
    summary.ok = false;
  } finally {
    try {
      first?.kill();
    } catch {}
    try {
      second?.kill();
    } catch {}
    // Only clean a temp home. Never delete the user's real ~/.dsh.
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    const isTempHome = !!HOME && path.resolve(HOME).startsWith(tempRoot);
    if (!KEEP && isTempHome) {
      try {
        fs.rmSync(HOME, { recursive: true, force: true });
      } catch {}
    }
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    process.exitCode = summary.ok ? 0 : 1;
  }
})();
