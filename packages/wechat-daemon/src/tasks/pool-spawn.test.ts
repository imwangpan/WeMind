import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isAlive } from "../shared/process/proc-identity.js";

/**
 * 进程池的 IO 侧测试：用**假 ACP agent**（本文件写出的 node 脚本）真起进程，验「复用/并行/上限/回收/身份记录」。
 * 策略判定已由 worker-pool.test.ts 的纯函数覆盖，这里只验「策略落到真实进程上是对的」。
 *
 * 环境变量必须在 import 前设好（`WECHAT_DATA_DIR`/`WEMIND_MAX_WORKERS` 都是模块加载期读的常量）。
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-pool-"));
const dataDir = path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });
process.env.WECHAT_DATA_DIR = dataDir;
process.env.WEMIND_MAX_WORKERS = "2"; // 便于测「第三条被拒」
process.env.WEMIND_MCP_CATALOG = path.join(root, "no-such-catalog.json");
// 本文件断言的是旧沙箱路径（data/worker-home）；默认已是 real，这里显式固定 sandbox。
process.env.WEMIND_HOME_MODE = "sandbox";
const savedNodeOptions = process.env.NODE_OPTIONS;
process.env.NODE_OPTIONS = ""; // 子进程会继承它；调试器注入会让假 agent 卡在握手
vi.setConfig({ testTimeout: 20_000 });

const {
  acquire,
  release,
  sweep,
  killAll,
  poolInfo,
  poolSummary,
  WORKERS_PID_FILE,
  resetPoolForTest,
} = await import("./worker-pool.js");
const { readPidRecords } = await import("../shared/process/pid-record.js");
import type { ResolvedAgent } from "../agents/brain-agents.js";

const FAKE = path.join(root, "fake-worker.mjs");
fs.writeFileSync(
  FAKE,
  `import fs from "node:fs";
const log = process.env.FAKE_LOG;
if (log) fs.appendFileSync(log, process.pid + "\\n");
// 故意把非 JSON 日志混进 stdout（DSH 实测如此）：worker-acp 必须跳过它们，不能把回合卡死
process.stdout.write("worker startup: plain log\\n");
process.stdout.write("{not-json}\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const f = JSON.parse(line);
    if (f.method === "initialize") out({ jsonrpc: "2.0", id: f.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (f.method === "session/new") out({ jsonrpc: "2.0", id: f.id, result: { sessionId: "s-" + process.pid } });
    else if (f.method === "session/load" || f.method === "session/resume") out({ jsonrpc: "2.0", id: f.id, result: {} });
    else if (f.method === "session/prompt") {
      process.stdout.write("prompt log line\\n");
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: f.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pid=" + process.pid + " 收到:" + f.params.prompt[0].text } } } });
      out({ jsonrpc: "2.0", id: f.id, result: { stopReason: "end_turn" } });
    } else out({ jsonrpc: "2.0", id: f.id, error: { code: -32601, message: "unsupported" } });
  }
});
`,
);

const agent = (name: string): ResolvedAgent =>
  ({
    name,
    bin: process.execPath,
    args: [FAKE],
    shell: false,
    source: "file",
    requestedKey: name,
    known: true,
    available: true,
    binPath: process.execPath,
    args_placeholder: undefined,
    // acquire 每次都会按这条任务的 agent 备 worker 沙箱：字段给全（空集合=不继承），别让它抛
    inherit: false,
    inheritDirs: [],
    inheritFiles: [],
    configSubdir: "",
    mcpFormat: "mcpServers",
    mcpConfigFile: "settings/mcp.json",
    catalogFile: "settings/mcp.json",
    env: {},
    envDefaults: {},
    images: true,
    credentialFiles: [],
    identityFiles: [],
    settingsDefaults: {},
    mcpViaAcp: false,
    requiresBins: [],
    binOverridden: false,
  }) as unknown as ResolvedAgent;

let logFile = "";
const spawnCount = (): number => {
  try {
    return fs.readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

/**
 * 等进程真的消失。POSIX 上 `kill()` 只是发信号（异步），紧接着 `isAlive()` 必然还看到活着——
 * CI 的 ubuntu runner 上踩过；Windows 走 `taskkill /F`（同步）所以本机看不出来。
 */
const waitDead = async (pid: number | null, timeoutMs = 5_000): Promise<boolean> => {
  const started = Date.now();
  while (isAlive(pid)) {
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
};

beforeEach(() => {
  resetPoolForTest();
  logFile = path.join(root, `spawns-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  process.env.FAKE_LOG = logFile;
});
afterEach(() => {
  resetPoolForTest();
  delete process.env.FAKE_LOG;
});
// 恢复时机放在 afterAll：本文件每条用例都要起子进程，中途恢复会把调试器注入带回去（同 spawn-agent.test.ts 的顾虑）
afterAll(() => {
  if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = savedNodeOptions;
  delete process.env.WEMIND_HOME_MODE;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("worker 进程池（真进程）", () => {
  it("agent 往 stdout 混非 JSON 日志行：忽略噪音，回合照常完成", async () => {
    const g = await acquire(agent("kiro"), 99);
    expect(g.ok).toBe(true);
    if (!g.ok) throw new Error(g.problem);
    try {
      expect(await g.conn.ask("噪音测试", "task-99@u1")).toContain("收到:噪音测试");
    } finally {
      release(g.conn);
    }
  });

  it("派发→用完→再派同 agent：复用同一进程（不重复冷启动）", async () => {
    const a = agent("kiro");
    const g1 = await acquire(a, 1);
    expect(g1.ok).toBe(true);
    const c1 = g1.ok ? g1.conn : null;
    expect(await c1!.ask("第一轮", "task-1@u1")).toContain("收到:第一轮");
    expect(spawnCount()).toBe(1);

    release(c1!);
    expect(poolSummary()).toEqual([{ agent: "kiro", busy: 0, idle: 1, taskIds: [] }]);

    const g2 = await acquire(a, 2);
    expect(g2.ok).toBe(true);
    if (!g2.ok) throw new Error(g2.problem);
    expect(g2.conn.id).toBe(c1!.id); // 同一条连接
    expect(spawnCount()).toBe(1); // 没有第二次 spawn
    expect(await g2.conn.ask("第二轮", "task-2@u1")).toContain("收到:第二轮");
  });

  it("按这条任务的 agent 备沙箱：派到非默认 agent 时它自己的 settings 也进 worker 沙箱", async () => {
    const realHome = path.join(root, "real-pi");
    fs.mkdirSync(realHome, { recursive: true });
    fs.writeFileSync(
      path.join(realHome, "settings.json"),
      JSON.stringify({ defaultProvider: "magpie" }),
    );
    const a = {
      ...agent("pi-like"),
      realHome,
      credentialFiles: ["settings.json"],
      settingsDefaults: { quietStartup: true },
    } as ResolvedAgent;
    const g = await acquire(a, 1);
    expect(g.ok).toBe(true);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(dataDir, "worker-home", "settings.json"), "utf-8"),
    );
    expect(cfg.defaultProvider).toBe("magpie"); // 从这条任务 agent 的 realHome 同步进来
    expect(cfg.quietStartup).toBe(true); // 预设默认项也补上
  });

  it("换 cwd 不复用旧进程：子进程 cwd 不能中途改", async () => {
    const a = agent("kiro");
    const g1 = await acquire(a, 1, root);
    expect(g1.ok).toBe(true);
    if (!g1.ok) return;
    expect(g1.conn.effectiveCwd()).toBe(root);
    release(g1.conn);

    const g2 = await acquire(a, 2, dataDir);
    expect(g2.ok).toBe(true);
    if (!g2.ok) return;
    expect(g2.conn.id).not.toBe(g1.conn.id); // 新进程，不是把旧进程改目录
    expect(g2.conn.effectiveCwd()).toBe(dataDir);
    expect(spawnCount()).toBe(2);
  });

  it("两个 agent 并行：两条连接、两个进程，各答各的", async () => {
    const gK = await acquire(agent("kiro"), 1);
    const gO = await acquire(agent("opencode"), 2);
    expect(gK.ok && gO.ok).toBe(true);
    const [rk, ro] = await Promise.all([
      gK.ok ? gK.conn.ask("K 的问题", "task-1@u1") : "",
      gO.ok ? gO.conn.ask("O 的问题", "task-2@u1") : "",
    ]);
    expect(spawnCount()).toBe(2);
    expect(rk).toContain("收到:K 的问题");
    expect(ro).toContain("收到:O 的问题");
    expect(rk).not.toBe(ro); // 两条不同进程（pid 不同 → 应答文本不同）
    expect(
      poolSummary()
        .map((p) => p.agent)
        .sort(),
    ).toEqual(["kiro", "opencode"]);
    expect(poolSummary().every((p) => p.busy === 1)).toBe(true);
  });

  it("超过并发上限：第三条被拒（不排队、不硬起）", async () => {
    const g1 = await acquire(agent("kiro"), 1);
    const g2 = await acquire(agent("opencode"), 2);
    expect(g1.ok && g2.ok).toBe(true);
    const g3 = await acquire(agent("qoder"), 3);
    expect(g3.ok).toBe(false);
    expect(g3.ok === false && g3.problem).toContain("已达上限（2 个）"); // WEMIND_MAX_WORKERS=2
    expect(spawnCount()).toBe(2); // 被拒的那条没起进程
  });

  it("空闲回收：过期/超编的空闲连接被杀，busy 的不动", async () => {
    const a = agent("kiro");
    const b = agent("opencode");
    const gA = await acquire(a, 1);
    const gB = await acquire(b, 2);
    expect(gA.ok && gB.ok).toBe(true);
    const pidA = gA.ok ? gA.conn.pid() : null;
    const pidB = gB.ok ? gB.conn.pid() : null;
    release(gA.ok ? gA.conn : null!);
    release(gB.ok ? gB.conn : null!, { maxConcurrent: 2, idleMax: 1, idleMs: 0 }); // 两条都「过期」→ 收掉最旧的那条
    expect(poolSummary()).toEqual([{ agent: "opencode", busy: 0, idle: 1, taskIds: [] }]);
    expect(await waitDead(pidA)).toBe(true); // 被回收（真杀掉了；POSIX 信号异步，等它退）
    expect(isAlive(pidB)).toBe(true); // 留下的一条还活着
    // 再派 kiro：池里没有可复用的 → 起新进程（拿到的不是刚才那条）
    const gA2 = await acquire(a, 3);
    expect(gA2.ok && gA2.conn.pid()).not.toBe(pidA);
    expect(spawnCount()).toBe(3);
  });

  it("sweep：清掉已死连接的身份记录（busy 的死连接留给 release/drop）", async () => {
    const g = await acquire(agent("kiro"), 1);
    expect(g.ok).toBe(true);
    const conn = g.ok ? g.conn : null!;
    conn.kill(); // 模拟进程自己崩了
    sweep();
    expect(poolInfo()).toEqual([]); // 死连接不对外展示
    expect(readPidRecords(WORKERS_PID_FILE)).toEqual([]); // 身份记录立刻清掉
    release(conn); // 任务结束：死连接从池里摘掉
    expect(poolInfo()).toEqual([]);
  });

  it("身份记录：每条连接一条（带 agent/bin/args/state/taskId），killAll 后文件消失", async () => {
    const g1 = await acquire(agent("kiro"), 7);
    const g2 = await acquire(agent("opencode"), 8);
    expect(g1.ok && g2.ok).toBe(true);
    const recs = readPidRecords(WORKERS_PID_FILE);
    expect(recs.map((r) => r.agent).sort()).toEqual(["kiro", "opencode"]);
    expect(recs.find((r) => r.agent === "kiro")).toMatchObject({
      state: "busy",
      taskId: 7,
      bin: process.execPath,
    });
    release(g1.ok ? g1.conn : null!);
    expect(readPidRecords(WORKERS_PID_FILE).find((r) => r.agent === "kiro")).toMatchObject({
      state: "idle",
    });

    const pids = [g1.ok ? g1.conn.pid() : null, g2.ok ? g2.conn.pid() : null];
    killAll();
    expect(poolInfo()).toEqual([]);
    expect(fs.existsSync(WORKERS_PID_FILE)).toBe(false);
    expect(await Promise.all(pids.map((p) => waitDead(p)))).toEqual([true, true]);
  });

  it("cwd 不存在：报真实原因（ENOENT），不被笼统的 worker conn killed 覆盖", async () => {
    const g = await acquire(agent("kiro"), 1, path.join(root, "没有这个目录"));
    expect(g.ok).toBe(false);
    expect(g.ok === false && g.problem).not.toContain("worker conn killed");
    expect(g.ok === false && g.problem).toMatch(/进程启动失败|ENOENT/);
    expect(poolInfo()).toEqual([]);
  });

  it("起进程失败：不乱留记录、如实报错（bin 不存在）", async () => {
    const bad = { ...agent("kiro"), bin: path.join(root, "没有这个.exe") } as ResolvedAgent;
    const g = await acquire(bad, 1);
    expect(g.ok).toBe(false);
    expect(g.ok === false && g.problem).toContain("起 worker 进程失败");
    expect(poolInfo()).toEqual([]);
    expect(readPidRecords(WORKERS_PID_FILE)).toEqual([]);
  });
});
