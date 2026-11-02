import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  bridgeReady: vi.fn(),
  daemonAlive: vi.fn(),
  viaBridge: vi.fn(),
  requireDaemonAlive: vi.fn(),
  ownerOf: vi.fn(() => "u1"),
  agentNameOf: vi.fn(() => "gemini"),
  pickKey: vi.fn(() => "acc1"),
  splitKeyArg: vi.fn((args: string[]) => ({ args })),
  listSessions: vi.fn(),
  renderSessionList: vi.fn(() => "render"),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  clearSessionPointer: vi.fn(() => true),
}));

vi.mock("./cli-context.js", () => ({
  bridgeReady: m.bridgeReady,
  daemonAlive: m.daemonAlive,
  viaBridge: m.viaBridge,
  requireDaemonAlive: m.requireDaemonAlive,
  ownerOf: m.ownerOf,
  agentNameOf: m.agentNameOf,
  pickKey: m.pickKey,
  splitKeyArg: m.splitKeyArg,
}));
vi.mock("./session-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-registry.js")>();
  return {
    ...actual,
    listSessions: m.listSessions,
    renderSessionList: m.renderSessionList,
    deleteSession: m.deleteSession,
    renameSession: m.renameSession,
  };
});
vi.mock("./session-map.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-map.js")>();
  return { ...actual, clearSessionPointer: m.clearSessionPointer };
});

import { cmdSession } from "./cli-session.js";

function defaults(): void {
  m.pickKey.mockReturnValue("acc1");
  m.ownerOf.mockReturnValue("u1");
  m.agentNameOf.mockReturnValue("gemini");
  m.splitKeyArg.mockImplementation((args: string[]) => ({ args }));
  m.bridgeReady.mockReturnValue(false);
  m.daemonAlive.mockReturnValue(false);
  m.viaBridge.mockResolvedValue("via-bridge");
}

beforeEach(() => {
  vi.clearAllMocks();
  defaults();
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("cmdSession（写优先走 daemon，读/文件类可直连）", () => {
  it("list：桥可用走桥并带页码；桥不可用直接读登记表并说明原因", async () => {
    m.bridgeReady.mockReturnValue(true);
    expect(await cmdSession(["list", "--page", "2"])).toBe("via-bridge");
    expect(m.viaBridge).toHaveBeenCalledWith("acc1", { kind: "session.list", page: 2 });

    vi.clearAllMocks();
    defaults();
    m.listSessions.mockReturnValue({ entries: [], others: 0, currentSessionId: undefined });
    const out = await cmdSession(["list"]);
    expect(out).toContain("render");
    expect(out).toContain("daemon 未运行");
  });

  it("new：daemon 在跑走桥；没跑时只清当前会话记录（名字等建好后再说）", async () => {
    m.daemonAlive.mockReturnValue(true);
    expect(await cmdSession(["new", "周报"])).toBe("via-bridge");
    expect(m.viaBridge).toHaveBeenCalledWith("acc1", { kind: "session.new", name: "周报" });

    vi.clearAllMocks();
    defaults();
    m.daemonAlive.mockReturnValue(false);
    m.clearSessionPointer.mockReturnValue(true);
    const out = await cmdSession(["new", "周报"]);
    expect(out).toContain("已清空当前会话记录");
    expect(out).toContain("session rename 1 周报");
    expect(m.clearSessionPointer).toHaveBeenCalled();
  });

  it("resume：必须先有 daemon，再把引用原样交给桥", async () => {
    m.daemonAlive.mockReturnValue(false);
    m.requireDaemonAlive.mockImplementation(() => {
      throw new Error("daemon 未运行");
    });
    await expect(cmdSession(["resume", "3"])).rejects.toThrow("daemon 未运行");

    m.requireDaemonAlive.mockImplementation(() => {});
    expect(await cmdSession(["resume", "3"])).toBe("via-bridge");
    expect(m.viaBridge).toHaveBeenCalledWith("acc1", { kind: "session.resume", ref: "3" });
  });

  it("rename/delete：桥可用走桥；不可用时直改登记表，失败置退出码 1", async () => {
    m.bridgeReady.mockReturnValue(true);
    expect(await cmdSession(["rename", "3", "新名"])).toBe("via-bridge");
    expect(m.viaBridge).toHaveBeenCalledWith("acc1", {
      kind: "session.rename",
      ref: "3",
      name: "新名",
    });

    vi.clearAllMocks();
    defaults();
    m.renameSession.mockReturnValue({ ok: true, entry: { name: "新名" } });
    expect(await cmdSession(["rename", "3", "新名"])).toContain("已重命名");
    expect(m.renameSession).toHaveBeenCalledWith("gemini", "u1", "3", "新名", expect.any(String));

    m.deleteSession.mockReturnValue({
      ok: false,
      error: "没有这条会话",
    });
    expect(await cmdSession(["delete", "3"])).toContain("没有这条会话");
    expect(process.exitCode).toBe(1);
  });
});
