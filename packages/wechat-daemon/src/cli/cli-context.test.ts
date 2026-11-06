import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const m = vi.hoisted(() => ({
  home: "",
  bridgePidOf: vi.fn(),
  writeControlRequest: vi.fn(),
  awaitControlResponse: vi.fn(),
}));

vi.mock("@wemind/wechat-ilink-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wemind/wechat-ilink-core")>();
  return {
    ...actual,
    accountDir: (key: string) => `${m.home}/${key}`,
  };
});
vi.mock("../ipc/control-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc/control-bridge.js")>();
  return {
    ...actual,
    bridgePidOf: m.bridgePidOf,
    newRequestId: () => "req-1",
    writeControlRequest: m.writeControlRequest,
    awaitControlResponse: m.awaitControlResponse,
    controlTimeoutMs: () => 1234,
  };
});

import { viaBridge } from "./cli-context.js";

describe("viaBridge（CLI 与 daemon 走同一段实现）", () => {
  let home = "";
  let dir = "";

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-bridge-"));
    m.home = home;
    dir = path.join(home, "acc1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "daemon.pid"), "123", "utf-8");
  });

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    vi.useRealTimers();
  });

  it("旧 daemon（不认识控制桥）在发送前就拒绝，并给重启命令", async () => {
    m.bridgePidOf.mockReturnValue(99);
    await expect(viaBridge("acc1", { kind: "session.list" })).rejects.toThrow(/旧版本/);
    expect(m.writeControlRequest).not.toHaveBeenCalled();
  });

  it("请求带截止时间；成功答复原样返回", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    m.bridgePidOf.mockReturnValue(123);
    m.awaitControlResponse.mockResolvedValue({ ok: true, text: "列表" });

    await expect(viaBridge("acc1", { kind: "session.list", page: 2 })).resolves.toBe("列表");
    expect(m.writeControlRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "req-1",
        at: 1000,
        kind: "session.list",
        page: 2,
        expiresAt: 2234,
      }),
      `${home}/acc1`,
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("daemon 明确失败 → 返回它的文案并把退出码置 1", async () => {
    m.bridgePidOf.mockReturnValue(123);
    m.awaitControlResponse.mockResolvedValue({ ok: false, text: "❌ 失败" });
    await expect(viaBridge("acc1", { kind: "brain.switch", target: "x" })).resolves.toBe("❌ 失败");
    expect(process.exitCode).toBe(1);
  });

  it("等不到答复 → 如实报超时，不假装成功", async () => {
    m.bridgePidOf.mockReturnValue(123);
    m.awaitControlResponse.mockResolvedValue(null);
    await expect(viaBridge("acc1", { kind: "session.new" })).rejects.toThrow(/超时/);
  });
});
