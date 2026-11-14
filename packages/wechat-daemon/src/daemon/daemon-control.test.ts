import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatCommand } from "../ipc/chat-commands.js";
import type { ResolvedAgent } from "../agents/brain-agents.js";
import type { ControlRequest } from "../ipc/control-bridge.js";

const m = vi.hoisted(() => ({
  agent: (name: string) =>
    ({ name, bin: `${name}.cmd`, args: [], source: "file" }) as unknown as ResolvedAgent,
  getAgent: vi.fn(),
  setAgent: vi.fn(),
  preflightSwitch: vi.fn(),
  switchBrain: vi.fn(),
  switchInFlightTarget: vi.fn(),
  newSession: vi.fn(),
  resumeSession: vi.fn(),
  askBrainTurn: vi.fn(),
  restartForMcpChange: vi.fn(),
  loadBrainConfig: vi.fn(() => ({})),
  agentConfigFor: vi.fn(() => ({})),
  presetAvailable: vi.fn(() => true),
  presetNames: vi.fn(() => ["gemini", "pi"]),
  resolvePresetByName: vi.fn(),
  currentSessionIdOf: vi.fn(),
  newSessionCmd: vi.fn(),
  sessionsCmd: vi.fn(),
  resumeSessionCmd: vi.fn(),
  renameSessionCmd: vi.fn(),
  deleteSessionCmd: vi.fn(),
  addMcp: vi.fn(),
  removeMcp: vi.fn(),
  listMcp: vi.fn(),
  saveHandoff: vi.fn(),
  killIdle: vi.fn(),
  hasActiveTask: vi.fn(() => false),
  taskPoolSummary: vi.fn<() => { agent: string; busy: number; idle: number; taskIds: number[] }[]>(
    () => [],
  ),
  loadAccount: vi.fn(),
  clearSessionPause: vi.fn(),
}));

vi.mock("@wemind/wechat-ilink-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wemind/wechat-ilink-core")>();
  return {
    ...actual,
    DATA_DIR: "/fake-dir",
    loadAccount: m.loadAccount,
    clearSessionPause: m.clearSessionPause,
  };
});
vi.mock("../acp/acp-brain.js", () => ({
  askBrainTurn: m.askBrainTurn,
  newSession: m.newSession,
  restartForMcpChange: m.restartForMcpChange,
  resumeSession: m.resumeSession,
}));
vi.mock("../agents/brain-config.js", () => ({
  loadBrainConfig: m.loadBrainConfig,
  agentConfigFor: m.agentConfigFor,
}));
vi.mock("../agents/brain-agents.js", () => ({
  ACP_AGENT_PRESETS: { gemini: {}, pi: {} },
  presetAvailable: m.presetAvailable,
  presetNames: m.presetNames,
  resolvePresetByName: m.resolvePresetByName,
}));
vi.mock("../agents/agent-slot.js", () => ({ getAgent: m.getAgent, setAgent: m.setAgent }));
vi.mock("../acp/brain-switch.js", () => ({
  preflightSwitch: m.preflightSwitch,
  switchBrain: m.switchBrain,
  switchInFlightTarget: m.switchInFlightTarget,
}));
vi.mock("../sessions/session-registry.js", () => ({ currentSessionIdOf: m.currentSessionIdOf }));
vi.mock("../sessions/session-manager.js", () => ({
  newSessionCmd: m.newSessionCmd,
  sessionsCmd: m.sessionsCmd,
  resumeSessionCmd: m.resumeSessionCmd,
  renameSessionCmd: m.renameSessionCmd,
  deleteSessionCmd: m.deleteSessionCmd,
}));
vi.mock("../agents/managed/mcp-brain.js", () => ({
  addMcp: m.addMcp,
  removeMcp: m.removeMcp,
  listMcp: m.listMcp,
}));
vi.mock("../sessions/handoff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions/handoff.js")>();
  return { ...actual, saveHandoff: m.saveHandoff };
});
vi.mock("../tasks/worker-pool.js", () => ({ killIdle: m.killIdle }));
vi.mock("../tasks/task-manager.js", () => ({
  hasActiveTask: m.hasActiveTask,
  taskPoolSummary: m.taskPoolSummary,
}));

import { handleControl, handleControlRequest } from "./daemon-control.js";
import { resetSensitiveAllow, sensitiveAllowActive } from "./messaging/sensitive-allow.js";

function ctx(owner: string) {
  return { owner, notify: vi.fn(async () => {}) };
}

const req = (kind: ControlRequest["kind"], extra: Partial<ControlRequest> = {}) =>
  ({ id: "r1", kind, at: 1, ...extra }) as ControlRequest;

beforeEach(() => {
  vi.clearAllMocks();
  m.getAgent.mockImplementation((role: string) => m.agent(role === "worker" ? "gemini" : "gemini"));
  m.loadBrainConfig.mockReturnValue({});
  m.agentConfigFor.mockReturnValue({});
  m.presetAvailable.mockReturnValue(true);
  m.presetNames.mockReturnValue(["gemini", "pi"]);
  m.taskPoolSummary.mockReturnValue([]);
  m.hasActiveTask.mockReturnValue(false);
  m.switchInFlightTarget.mockReturnValue(undefined);
  m.restartForMcpChange.mockResolvedValue(true);
});

afterEach(() => resetSensitiveAllow());

describe("handleControl（微信控制指令分派）", () => {
  it("help 按「登录者 / 其他发送者」裁剪：ownerOnly 指令只出现在登录者那份", async () => {
    const ownerHelp = await handleControl({ kind: "help" }, "u1", ctx("u1"));
    const userHelp = await handleControl({ kind: "help" }, "u2", ctx("u1"));
    expect(ownerHelp).toContain("AI / AI 列表");
    expect(ownerHelp).toContain("切换大脑");
    expect(userHelp).not.toContain("AI / AI 列表");
    expect(userHelp).not.toBe(ownerHelp);
  });

  it("会话类指令把 agent/userId/引用/名字/页码原样交给实现层", async () => {
    m.newSessionCmd.mockResolvedValue("new");
    m.sessionsCmd.mockReturnValue("list");
    m.resumeSessionCmd.mockResolvedValue("resume");
    m.renameSessionCmd.mockReturnValue("rename");
    m.deleteSessionCmd.mockReturnValue("delete");

    expect(await handleControl({ kind: "new", name: "周报" }, "u1", ctx("u1"))).toBe("new");
    expect(m.newSessionCmd).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "gemini", userId: "u1", dir: "/fake-dir", name: "周报" }),
    );

    expect(await handleControl({ kind: "sessions", page: 2 }, "u1", ctx("u1"))).toBe("list");
    expect(m.sessionsCmd).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));

    expect(await handleControl({ kind: "resume", ref: "3" }, "u1", ctx("u1"))).toBe("resume");
    expect(m.resumeSessionCmd).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "gemini", userId: "u1" }),
      "3",
    );

    expect(await handleControl({ kind: "rename", ref: "3", name: "新名" }, "u1", ctx("u1"))).toBe(
      "rename",
    );
    expect(m.renameSessionCmd).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "gemini", userId: "u1" }),
      "3",
      "新名",
    );

    expect(await handleControl({ kind: "delete", ref: "3" }, "u1", ctx("u1"))).toBe("delete");
    expect(m.deleteSessionCmd).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "gemini" }),
      "3",
    );
  });

  it("MCP 加载/卸载：失败或激活集没变都不重启；切换进行中不杀新大脑", async () => {
    m.addMcp.mockReturnValue({ ok: false, changed: false, text: "❌ 失败" });
    expect(await handleControl({ kind: "add", name: "x" }, "u1", ctx("u1"))).toBe("❌ 失败");
    expect(m.restartForMcpChange).not.toHaveBeenCalled();

    m.addMcp.mockReturnValue({ ok: true, changed: false, text: "已经加载" });
    expect(await handleControl({ kind: "add", name: "x" }, "u1", ctx("u1"))).toBe("已经加载");
    expect(m.restartForMcpChange).not.toHaveBeenCalled();

    m.removeMcp.mockReturnValue({ ok: true, changed: true, text: "已卸载" });
    m.restartForMcpChange.mockResolvedValue(false);
    expect(await handleControl({ kind: "remove", name: "x" }, "u1", ctx("u1"))).toContain(
      "大脑正在切换中",
    );
    expect(m.restartForMcpChange).toHaveBeenCalled();

    m.restartForMcpChange.mockResolvedValue(true);
    expect(await handleControl({ kind: "remove", name: "x" }, "u1", ctx("u1"))).toBe("已卸载");
  });

  it("AI 总览与 MCP 列表直接走查询实现", async () => {
    m.listMcp.mockReturnValue("mcp-list");
    expect(await handleControl({ kind: "list" }, "u1", ctx("u1"))).toBe("mcp-list");

    m.taskPoolSummary.mockReturnValue([{ agent: "gemini", busy: 1, idle: 0, taskIds: [30] }]);
    const ai = await handleControl({ kind: "ai" }, "u1", ctx("u1"));
    expect(ai).toContain("AI 配置");
    expect(ai).toContain("对话大脑：gemini");
    expect(ai).toContain("池中 worker：gemini 忙1(#30)/闲0");
    expect(ai).toContain("可选 agent：gemini✅、pi✅、auto");
  });

  it("切换大脑：切脑中拒绝；预检失败不启动；已经是它直接等；否则先 ack 再后台补发", async () => {
    m.switchInFlightTarget.mockReturnValue("pi");
    expect(await handleControl({ kind: "brain", target: "opencode" }, "u1", ctx("u1"))).toContain(
      "正在切到「pi」",
    );

    m.switchInFlightTarget.mockReturnValue(undefined);
    m.preflightSwitch.mockReturnValue({ ok: false, problem: "未安装" });
    expect(await handleControl({ kind: "brain", target: "opencode" }, "u1", ctx("u1"))).toContain(
      "❌ 未安装",
    );
    expect(m.switchBrain).not.toHaveBeenCalled();

    m.preflightSwitch.mockReturnValue({ ok: true, already: true, agent: m.agent("gemini") });
    m.switchBrain.mockResolvedValue({ ok: true, notice: "✅ 已经是它" });
    expect(await handleControl({ kind: "brain", target: "gemini" }, "u1", ctx("u1"))).toBe(
      "✅ 已经是它",
    );

    const c = ctx("u1");
    m.preflightSwitch.mockReturnValue({ ok: true, already: false, agent: m.agent("pi") });
    let resolveSwitch!: (v: unknown) => void;
    m.switchBrain.mockReturnValue(new Promise((r) => (resolveSwitch = r)));
    expect(await handleControl({ kind: "brain", target: "pi" }, "u1", c)).toContain("⏳");
    expect(c.notify).not.toHaveBeenCalled(); // 还没到补发时刻
    resolveSwitch({ ok: true, notice: "✅ 切到 pi" });
    await vi.waitFor(() => expect(c.notify).toHaveBeenCalledWith("✅ 切到 pi"));
  });

  it("切换任务大脑：无参只展示；有参按 name/bin/args/model 判是否真切换", async () => {
    expect(await handleControl({ kind: "workerBrain" }, "u1", ctx("u1"))).toContain(
      "当前默认任务大脑：gemini",
    );

    m.resolvePresetByName.mockReturnValue({ ok: true, agent: m.agent("gemini") });
    expect(
      await handleControl({ kind: "workerBrain", target: "gemini" }, "u1", ctx("u1")),
    ).toContain("无需切换");
    expect(m.killIdle).not.toHaveBeenCalled();

    m.resolvePresetByName.mockReturnValue({ ok: true, agent: m.agent("pi") });
    expect(await handleControl({ kind: "workerBrain", target: "pi" }, "u1", ctx("u1"))).toContain(
      "gemini → pi",
    );
    expect(m.setAgent).toHaveBeenCalledWith("worker", expect.objectContaining({ name: "pi" }));
    expect(m.killIdle).toHaveBeenCalled();
  });

  it("交接：没有当前会话时直接说明；有会话时保存并返回摘要", async () => {
    m.currentSessionIdOf.mockReturnValue(null);
    expect(await handleControl({ kind: "handoff" }, "u1", ctx("u1"))).toContain("没什么可交接");

    m.currentSessionIdOf.mockReturnValue("s1");
    m.askBrainTurn.mockResolvedValue({ text: "旧上下文摘要", agent: "pi" });
    const out = await handleControl({ kind: "handoff" }, "u1", ctx("u1"));
    expect(out).toContain("交接摘要已保存");
    expect(out).toContain("来自「pi」");
    expect(m.saveHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", text: "旧上下文摘要", fromAgent: "pi" }),
      "/fake-dir",
    );
  });

  it("允许敏感文件：开窗口并如实报告分钟数；默认 2 分钟，超界夹到 30", async () => {
    const dflt = await handleControl({ kind: "allowSensitive" }, "u1", ctx("u1"));
    expect(dflt).toContain("已允许发送敏感文件");
    expect(dflt).toContain("窗口 2 分钟");
    expect(sensitiveAllowActive()).toBe(true);

    const five = await handleControl({ kind: "allowSensitive", minutes: 5 }, "u1", ctx("u1"));
    expect(five).toContain("窗口 5 分钟");

    const capped = await handleControl({ kind: "allowSensitive", minutes: 99 }, "u1", ctx("u1"));
    expect(capped).toContain("窗口 30 分钟");
  });

  it("允许敏感文件：先拦截后放行时补发之前的附件，并把结果写进答复", async () => {
    const ok = {
      ...ctx("u1"),
      releaseSensitive: vi.fn(async () => ({ sent: 2, failed: 0 })),
    };
    const out = await handleControl({ kind: "allowSensitive" }, "u1", ok);
    expect(ok.releaseSensitive).toHaveBeenCalledTimes(1);
    expect(out).toContain("已补发 2 个之前被拦下的附件");

    const partial = {
      ...ctx("u1"),
      releaseSensitive: vi.fn(async () => ({ sent: 1, failed: 1 })),
    };
    expect(await handleControl({ kind: "allowSensitive" }, "u1", partial)).toContain(
      "另有 1 个失败",
    );

    const none = {
      ...ctx("u1"),
      releaseSensitive: vi.fn(async () => ({ sent: 0, failed: 0 })),
    };
    expect(await handleControl({ kind: "allowSensitive" }, "u1", none)).not.toContain("📎");
  });

  it("指令表新增了 kind 但分派没接通时给明确提示，不静默吞掉", async () => {
    const out = await handleControl(
      { kind: "future-kind" } as unknown as ChatCommand,
      "u1",
      ctx("u1"),
    );
    expect(out).toContain("future-kind");
    expect(out).toContain("还没接通");
  });
});

describe("handleControlRequest（控制桥 9 个 kind）", () => {
  it("brain.switch：缺 target / 预检失败 / 成功 / 失败四种答复", async () => {
    expect(await handleControlRequest(req("brain.switch"), "o")).toContain("用法");
    expect(m.preflightSwitch).not.toHaveBeenCalled();

    m.preflightSwitch.mockReturnValue({ ok: false, problem: "不可用" });
    expect(await handleControlRequest(req("brain.switch", { target: "x" }), "o")).toBe("❌ 不可用");

    m.preflightSwitch.mockReturnValue({ ok: true, already: false, agent: m.agent("x") });
    m.switchBrain.mockResolvedValue({ ok: true, notice: "✅ 已切换" });
    expect(await handleControlRequest(req("brain.switch", { target: "x" }), "o")).toBe("✅ 已切换");
    expect(m.switchBrain).toHaveBeenCalledWith("x", { userId: "o", dir: "/fake-dir" });

    m.switchBrain.mockResolvedValue({ ok: false, problem: "启动失败" });
    expect(await handleControlRequest(req("brain.switch", { target: "x" }), "o")).toBe(
      "❌ 启动失败",
    );
  });

  it("brain.worker：缺 target 展示当前，有 target 走真切换", async () => {
    expect(await handleControlRequest(req("brain.worker"), "o")).toContain("当前默认任务大脑");
    m.resolvePresetByName.mockReturnValue({ ok: true, agent: m.agent("pi") });
    expect(await handleControlRequest(req("brain.worker", { target: "pi" }), "o")).toContain(
      "gemini → pi",
    );
  });

  it("brain.handoff：没有当前会话时不上报摘要在做", async () => {
    m.currentSessionIdOf.mockReturnValue(null);
    expect(await handleControlRequest(req("brain.handoff"), "o")).toContain("没什么可交接");
    expect(m.askBrainTurn).not.toHaveBeenCalled();
  });

  it("session.new / list / resume / rename / delete：参数与截止时间原样下传", async () => {
    m.newSessionCmd.mockResolvedValue("new");
    m.sessionsCmd.mockReturnValue("list");
    m.resumeSessionCmd.mockResolvedValue("resume");
    m.renameSessionCmd.mockReturnValue("rename");
    m.deleteSessionCmd.mockReturnValue("delete");
    m.newSession.mockResolvedValue({ sessionId: "s9" });
    m.resumeSession.mockResolvedValue({ ok: true });

    expect(await handleControlRequest(req("session.new", { name: "周报" }), "o")).toBe("new");
    const newCtx = m.newSessionCmd.mock.calls[0][0] as any;
    expect(newCtx).toMatchObject({ agent: "gemini", userId: "o", dir: "/fake-dir", name: "周报" });
    await newCtx.create("o");
    expect(m.newSession).toHaveBeenCalledWith("o", { deadline: undefined });

    await handleControlRequest(req("session.list", { page: 3 }), "o");
    expect(m.sessionsCmd).toHaveBeenCalledWith(expect.objectContaining({ page: 3 }));

    expect(await handleControlRequest(req("session.resume"), "o")).toContain("用法");
    expect(await handleControlRequest(req("session.resume", { ref: "3" }), "o")).toBe("resume");
    const resumeCtx = m.resumeSessionCmd.mock.calls[0][0] as any;
    expect(resumeCtx.dir).toBe("/fake-dir");
    await resumeCtx.resume("o", "s1");
    expect(m.resumeSession).toHaveBeenCalledWith("o", "s1", { deadline: undefined });

    expect(await handleControlRequest(req("session.rename", { ref: "3" }), "o")).toContain("用法");
    expect(await handleControlRequest(req("session.delete"), "o")).toContain("用法");
    expect(await handleControlRequest(req("session.rename", { ref: "3", name: "新名" }), "o")).toBe(
      "rename",
    );
    expect(await handleControlRequest(req("session.delete", { ref: "3" }), "o")).toBe("delete");
  });

  it("session.unpause：没有凭证时拒绝；有 botId 时清进程内冷却", async () => {
    m.loadAccount.mockReturnValue(null);
    expect(await handleControlRequest(req("session.unpause"), "o")).toContain("没有登录凭证");

    m.loadAccount.mockReturnValue({ botId: "bot-1" });
    expect(await handleControlRequest(req("session.unpause"), "o")).toContain("已解除");
    expect(m.clearSessionPause).toHaveBeenCalledWith("bot-1");
  });
});
