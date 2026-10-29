import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * ACP 层面的端到端测试：用**假 ACP agent**（本文件写出的 node 脚本）替代真 agent，覆盖两类最容易静默回归的行为——
 * 切脑（成功 / 失败退回 / 只起一个进程 / 异目标拒绝 / drain 门 / WEMIND_BRAIN 警告）与会话恢复（严格恢复：接不上就如实失败、不动当前会话记录）。
 *
 * 为什么必须是真子进程：切脑的价值全在「换掉那个进程」——用 mock 掉 spawn 只能测出「代码按顺序调了函数」，
 * 测不出「旧进程真的死了、没残留、新进程真的能用 ACP 说话」；恢复同理（load 失败/成功的分支在 ACP 往返上）。
 *
 * 环境变量必须在 import 前设好：`DATA_DIR`（core 模块加载期定死）与 `WEMIND_SWITCH_DRAIN_MS`
 * （brain-switch 模块加载期读）都是模块级常量（与 agent-slot.test.ts / sandbox-qoder.test.ts 同一手法）。
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-switch-"));
const dataDir = path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });
process.env.WECHAT_DATA_DIR = dataDir;
process.env.WEMIND_MCP_CATALOG = path.join(root, "no-such-catalog.json"); // 别去读用户真实的 MCP 配置
process.env.WEMIND_SWITCH_DRAIN_MS = "400"; // drain 门缩短，好测超时分支
const savedNodeOptions = process.env.NODE_OPTIONS;
process.env.NODE_OPTIONS = ""; // 子进程会继承它；调试器注入会让假 agent 卡在握手（同 spawn-agent.test.ts）

const { switchBrain, preflightSwitch, switchInFlightTarget } = await import("./brain-switch.js");
const { askBrain, resumeSession, restart } = await import("./acp-brain.js");
const { getAgent, resetSlotsForTest, seedSlots, setAgent } = await import("./agent-slot.js");
const { loadBrainConfig, saveBrainConfig } = await import("./brain-config.js");
const { readPidRecords } = await import("./pid-record.js");
const { loadRegistry } = await import("./session-registry.js");

// 本文件起真子进程（Windows 上单次 0.5–0.7s，全量并发时更慢），默认 5s 会偶发不够：放宽到 20s（同 spawn-agent.test.ts）
vi.setConfig({ testTimeout: 20_000 });

const FAKE = path.join(root, "fake-acp.mjs");
fs.writeFileSync(
  FAKE,
  `import fs from "node:fs";
const mode = process.argv[2] || "ok";
const log = process.env.FAKE_ACP_LOG;
const methods = process.env.FAKE_ACP_METHODS;
if (log) fs.appendFileSync(log, process.pid + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    handle(JSON.parse(line));
  }
});
function handle(f) {
  if (methods) fs.appendFileSync(methods, f.method + " " + JSON.stringify(f.params ?? {}).slice(0, 200) + "\\n");
  if (mode === "fail-init" && f.method === "initialize") {
    out({ jsonrpc: "2.0", id: f.id, error: { code: -32603, message: "boom: 握手被拒" } });
    return;
  }
  // 会话恢复的分支：load/resume 都接不上（模拟「这条会话已被 agent 自己清理 / 不支持恢复」）
  if (mode === "fail-load" && (f.method === "session/load" || f.method === "session/resume")) {
    out({ jsonrpc: "2.0", id: f.id, error: { code: -32602, message: "session not found" } });
    return;
  }
  const delay = (mode === "slow-init" && f.method === "initialize") || (mode === "slow-prompt" && f.method === "session/prompt") ? 700 : 0;
  setTimeout(() => {
    if (f.method === "initialize") out({ jsonrpc: "2.0", id: f.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (f.method === "session/new") out({ jsonrpc: "2.0", id: f.id, result: { sessionId: "sess-new" } });
    else if (f.method === "session/load" || f.method === "session/resume") out({ jsonrpc: "2.0", id: f.id, result: {} });
    else if (f.method === "session/set_config_option") out({ jsonrpc: "2.0", id: f.id, result: {} });
    else if (f.method === "session/prompt") {
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: f.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "答:" + (f.params.prompt[0].text || "").slice(0, 20) } } } });
      out({ jsonrpc: "2.0", id: f.id, result: { stopReason: "end_turn" } });
    } else out({ jsonrpc: "2.0", id: f.id, error: { code: -32601, message: "method not supported" } });
  }, delay);
}
`,
);

/** 让某个 agent 指向假 agent（bin 用当前 node，args 带上脚本与模式）。 */
function presetArgs(mode: string): { bin: string; args: string[] } {
  return { bin: process.execPath, args: [FAKE, mode] };
}

const pidFile = path.join(dataDir, "brain.pid");
const sessionsFile = path.join(dataDir, "brain-sessions.json");
const savedBrainEnv = process.env.WEMIND_BRAIN;
const savedWorkerBrainEnv = process.env.WEMIND_WORKER_BRAIN;

let logFile = "";
let methodsFile = "";
const spawnCount = (): number => {
  try {
    return fs.readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};
const methods = (): string[] => {
  try {
    return fs.readFileSync(methodsFile, "utf-8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

beforeEach(() => {
  delete process.env.WEMIND_BRAIN;
  delete process.env.WEMIND_WORKER_BRAIN;
  resetSlotsForTest();
  restart();
  fs.rmSync(path.join(dataDir, "brain.json"), { force: true });
  fs.rmSync(pidFile, { force: true });
  fs.rmSync(sessionsFile, { force: true });
  fs.rmSync(path.join(dataDir, "session-registry.json"), { force: true });
  logFile = path.join(root, `spawns-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  methodsFile = `${logFile}.methods`;
  process.env.FAKE_ACP_LOG = logFile;
  process.env.FAKE_ACP_METHODS = methodsFile;
});

afterEach(() => {
  restart(); // 杀掉本用例起的假 agent，别留给下一个用例
});

/** 写入磁盘一份「脑=opencode，目标=kiro」的配置，两个 agent 都指向假 agent。返回当前槽位。 */
function setup(modeCur = "ok", modeTarget = "ok") {
  saveBrainConfig({
    agent: "opencode",
    presets: { opencode: presetArgs(modeCur), kiro: presetArgs(modeTarget) },
  });
  seedSlots();
  return getAgent("brain");
}

describe("preflightSwitch", () => {
  it("未知 agent：直接失败，不 spawn", async () => {
    setup();
    const pre = preflightSwitch("没这个", dataDir);
    expect(pre.ok).toBe(false);
    expect(pre.ok === false && pre.problem).toContain("未知 agent");
    expect(spawnCount()).toBe(0);
  });

  it("agent 有名无实（bin 找不到）：失败并说明怎么修，不 spawn", async () => {
    saveBrainConfig({
      agent: "opencode",
      presets: { opencode: presetArgs("ok"), kiro: { bin: path.join(root, "没有这个.exe") } },
    });
    seedSlots();
    const pre = preflightSwitch("kiro", dataDir);
    expect(pre.ok).toBe(false);
    expect(pre.ok === false && pre.problem).toContain("找不到");
    expect(spawnCount()).toBe(0);
  });

  it("已经是当前大脑：already=true（调用方据此省掉 ack/补发两段）", () => {
    setup();
    const pre = preflightSwitch("opencode", dataDir);
    expect(pre.ok).toBe(true);
    expect(pre.ok === true && pre.already).toBe(true);
  });

  it("忽略 WEMIND_BRAIN 环境变量（命令式切换不能被 env 压住）", () => {
    setup();
    process.env.WEMIND_BRAIN = "qoder";
    expect(preflightSwitch("kiro", dataDir).ok).toBe(true); // 仍解析 kiro，而不是 env 的 qoder
    expect(getAgent("brain").name).toBe("opencode"); // 槽位未被 env 影响（此前已 seed）
  });
});

describe("switchBrain", () => {
  it("成功切换：换槽位、落 brain.json、pid 记录写新 agent、按用户建会话", async () => {
    setup();
    const out = await switchBrain("kiro", { userId: "u1", dir: dataDir });
    expect(out.ok).toBe(true);
    expect(out.ok === true && out.changed).toBe(true);
    expect(out.ok === true && out.agent.name).toBe("kiro");
    expect(getAgent("brain").name).toBe("kiro"); // 槽位热更新
    expect(loadBrainConfig(dataDir)?.agent).toBe("kiro"); // 持久化
    expect(spawnCount()).toBe(1); // 只起了新 agent 一个进程
    const recs = readPidRecords(pidFile);
    expect(recs.length).toBe(1);
    expect(recs[0].agent).toBe("kiro");
    const map = JSON.parse(fs.readFileSync(sessionsFile, "utf-8"));
    expect(map["kiro:u1"]).toBe("sess-new"); // 会话映射按新 agent 分开存
    expect(methods()).toContainEqual(expect.stringContaining("initialize"));
  });

  it("切回旧大脑：该 agent 的旧会话用 session/load 恢复（不是新建）", async () => {
    // 先让 kiro 有一条旧会话（模拟「切走之前的上下文」）
    fs.writeFileSync(sessionsFile, JSON.stringify({ "kiro:u1": "sess-old" }));
    setup();
    const out = await switchBrain("kiro", { userId: "u1", dir: dataDir });
    expect(out.ok).toBe(true);
    const loads = methods().filter((m) => m.startsWith("session/load"));
    expect(loads.length).toBe(1);
    expect(loads[0]).toContain("sess-old");
    expect(methods().some((m) => m.startsWith("session/new"))).toBe(false); // 有旧会话就不新建
    expect(JSON.parse(fs.readFileSync(sessionsFile, "utf-8"))["kiro:u1"]).toBe("sess-old");
  });

  it("握手失败：回滚——槽位与 brain.json 都不变，不留半截进程与 pid 记录", async () => {
    setup("ok", "fail-init");
    const out = await switchBrain("kiro", { userId: "u1", dir: dataDir });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.problem).toContain("已退回原来那个「opencode」");
    expect(out.ok === false && out.problem).toContain("下一条消息会自动重启");
    expect(getAgent("brain").name).toBe("opencode"); // 槽位留旧
    expect(loadBrainConfig(dataDir)?.agent).toBe("opencode"); // 磁盘未动
    expect(readPidRecords(pidFile)).toEqual([]); // 无残留记录
    expect(spawnCount()).toBe(1); // 只起过那个失败的进程
    expect(fs.existsSync(sessionsFile)).toBe(false); // 没走到建会话
  });

  it("已经是它：不重启进程、不 spawn，只把选择写入磁盘", async () => {
    setup();
    const before = spawnCount();
    const out = await switchBrain("opencode", { userId: "u1", dir: dataDir });
    expect(out.ok).toBe(true);
    expect(out.ok === true && out.changed).toBe(false);
    expect(out.ok === true && out.notice).toContain("无需切换");
    expect(spawnCount()).toBe(before); // 没有为新进程付代价
  });

  it("同一目标的并发请求复用同一次切换（启动新大脑只做一遍）", async () => {
    setup("ok", "slow-init");
    const [a, b] = await Promise.all([
      switchBrain("kiro", { userId: "u1", dir: dataDir }),
      switchBrain("kiro", { userId: "u1", dir: dataDir }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(spawnCount()).toBe(1); // 关键断言：两次请求只起了一个进程
    expect(getAgent("brain").name).toBe("kiro");
  });

  it("飞行中切另一个目标：拒绝（不排队，避免「连点两下」的歧义）", async () => {
    setup("ok", "slow-init");
    const p = switchBrain("kiro", { userId: "u1", dir: dataDir });
    await new Promise((r) => setTimeout(r, 100));
    expect(switchInFlightTarget()).toBe("kiro");
    const other = await switchBrain("opencode", { userId: "u1", dir: dataDir });
    expect(other.ok).toBe(false);
    expect(other.ok === false && other.problem).toContain("正在切到「kiro」");
    expect((await p).ok).toBe(true);
    expect(switchInFlightTarget()).toBeNull(); // 结束后清空
  });

  it("有回合在跑：drain 超时 → 诚实失败（不砍回合、不换大脑），回合结束后可再切", async () => {
    setup("slow-prompt", "ok");
    const turn = askBrain("u1", "你好"); // 假 agent 700ms 后才回，够 drain 门（400ms）超时
    await new Promise((r) => setTimeout(r, 100));
    const failed = await switchBrain("kiro", { userId: "u1", dir: dataDir });
    expect(failed.ok).toBe(false);
    expect(failed.ok === false && failed.problem).toContain("有回合正在进行");
    expect(getAgent("brain").name).toBe("opencode"); // 没换
    expect(await turn).toContain("答:"); // 回合正常跑完，没被砍
    const ok = await switchBrain("kiro", { userId: "u1", dir: dataDir });
    expect(ok.ok).toBe(true);
  });

  it("切换进行中发来的回合会等新大脑就绪：全程只 spawn 一次，答案来自新大脑", async () => {
    setup("ok", "slow-init");
    const switching = switchBrain("kiro", { userId: "u1", dir: dataDir });
    const turn = askBrain("u1", "在吗"); // 此刻槽位还是 opencode，但切换已把它挡住
    expect((await switching).ok).toBe(true);
    expect(await turn).toContain("答:");
    expect(spawnCount()).toBe(1); // 双起进程的回归护栏：启动新大脑与回合不能各起一个
    expect(getAgent("brain").name).toBe("kiro");
  });

  it("WEMIND_BRAIN 压着时：切换照做，但答复如实警告重启后会回去", async () => {
    setup();
    process.env.WEMIND_BRAIN = "opencode";
    const out = await switchBrain("kiro", { userId: "u1", dir: dataDir });
    expect(out.ok).toBe(true);
    expect(out.ok === true && out.notice).toContain("WEMIND_BRAIN=opencode");
    expect(out.ok === true && out.notice).toContain("重启后会回到");
    expect(loadBrainConfig(dataDir)?.agent).toBe("kiro"); // 磁盘仍是命令的选择
  });

  it("persist=false：只在本进程生效，不写 brain.json（CLI「仅本次」场景）", async () => {
    setup();
    const out = await switchBrain("kiro", { userId: "u1", dir: dataDir, persist: false });
    expect(out.ok).toBe(true);
    expect(getAgent("brain").name).toBe("kiro");
    expect(loadBrainConfig(dataDir)?.agent).toBe("opencode");
  });
});

describe("槽位与假 agent 的一致性", () => {
  it("already 的判据含 bin/args：名字对但二进制不是一个 → 仍要切", async () => {
    setup();
    setAgent("brain", { ...getAgent("brain"), name: "kiro", bin: path.join(root, "别的") });
    const pre = preflightSwitch("kiro", dataDir);
    expect(pre.ok).toBe(true);
    expect(pre.ok === true && pre.already).toBe(false);
    expect(await switchBrain("kiro", { userId: "u1", dir: dataDir })).toMatchObject({
      ok: true,
      changed: true,
    });
  });

  it("already 的判据含 model：同一个 agent、只改了模型 → 仍要切（否则新模型永远不生效）", async () => {
    setup();
    expect(await switchBrain("kiro", { userId: "u1", dir: dataDir })).toMatchObject({
      ok: true,
      changed: true,
    });
    // 槽位现在就是 kiro；磁盘上把 kiro 的覆盖加一个 model（模拟 `brain set --model` 只写盘）
    const cfg = loadBrainConfig(dataDir)!;
    saveBrainConfig({
      ...cfg,
      agent: "kiro",
      presets: {
        ...cfg.presets,
        kiro: { ...cfg.presets!.kiro, model: '["deepseek-account","deepseek-v4-pro"]' },
      },
    });
    const pre = preflightSwitch("kiro", dataDir);
    expect(pre.ok).toBe(true);
    expect(pre.ok === true && pre.already).toBe(false);
    expect(await switchBrain("kiro", { userId: "u1", dir: dataDir })).toMatchObject({
      ok: true,
      changed: true,
    });
  });
});

describe("会话（ACP 侧写入 + 严格恢复）", () => {
  const entries = () => loadRegistry(dataDir).entries;
  const pointerOf = (userId: string): string | undefined => {
    try {
      return JSON.parse(fs.readFileSync(sessionsFile, "utf-8"))[`opencode:${userId}`];
    } catch {
      return undefined;
    }
  };

  it("新会话 + 成功回合：登记进列表、轮次累加、标题只写首次", async () => {
    setup();
    expect(await askBrain("u1", "帮我看看这个 bug")).toContain("答:");
    let e = entries().find((x) => x.agent === "opencode" && x.userId === "u1");
    expect(e).toMatchObject({ sessionId: "sess-new", turns: 1, title: "帮我看看这个 bug" });

    await askBrain("u1", "再问一句");
    e = entries().find((x) => x.agent === "opencode" && x.userId === "u1");
    expect(e).toMatchObject({ turns: 2, title: "帮我看看这个 bug" }); // 标题留在第一条消息上
    expect(entries().filter((x) => x.userId === "u1")).toHaveLength(1); // 同一条会话，不是又开了一条
  });

  it("恢复会话成功：当前会话记录改到目标，下一回合直接发进那条会话（不再 load 一次）", async () => {
    fs.writeFileSync(sessionsFile, JSON.stringify({ "opencode:u1": "sess-cur" }));
    setup();
    expect(await resumeSession("u1", "sess-old")).toEqual({ ok: true });
    expect(pointerOf("u1")).toBe("sess-old");
    expect(await askBrain("u1", "接着上次说")).toContain("答:");
    const prompts = methods().filter((m) => m.startsWith("session/prompt"));
    expect(prompts[prompts.length - 1]).toContain("sess-old"); // 这一轮真的进了恢复的那条会话
    expect(entries().find((x) => x.sessionId === "sess-old")).toMatchObject({ turns: 1 });
  });

  it("恢复会话失败：如实报错、**当前会话记录不变**（不静默新建一条顶替）", async () => {
    fs.writeFileSync(sessionsFile, JSON.stringify({ "opencode:u1": "sess-cur" }));
    setup("fail-load");
    const r = await resumeSession("u1", "sess-ghost");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.problem).toContain("接不上会话 sess-gho");
    expect(r.ok === false && r.problem).toContain("当前会话没变");
    expect(pointerOf("u1")).toBe("sess-cur"); // 原来的当前会话记录原样
    expect(methods().some((m) => m.startsWith("session/new"))).toBe(false); // 没有偷偷开新会话
    expect(entries().some((x) => x.sessionId === "sess-ghost")).toBe(false); // 也没登记一条假会话
  });
});

afterEach(() => {
  if (savedBrainEnv === undefined) delete process.env.WEMIND_BRAIN;
  else process.env.WEMIND_BRAIN = savedBrainEnv;
  if (savedWorkerBrainEnv === undefined) delete process.env.WEMIND_WORKER_BRAIN;
  else process.env.WEMIND_WORKER_BRAIN = savedWorkerBrainEnv;
  delete process.env.FAKE_ACP_LOG;
  delete process.env.FAKE_ACP_METHODS;
  resetSlotsForTest();
});
// NODE_OPTIONS 放到最后再恢复：本文件每条用例都要起子进程，中途恢复会把调试器注入带回去（同 spawn-agent.test.ts 的顾虑）
afterAll(() => {
  if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = savedNodeOptions;
});
