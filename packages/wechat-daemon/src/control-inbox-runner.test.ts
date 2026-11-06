import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  controlInboxDir,
  readControlResponse,
  writeControlRequest,
  type ControlRequest,
} from "./ipc/control-bridge.js";
import { ControlInboxRunner } from "./control-inbox-runner.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-control-inbox-"));
  dirs.push(dir);
  const calls: string[] = [];
  const handle = async (req: ControlRequest, owner: string) => {
    calls.push(`${req.kind}:${owner}`);
    return `✅ ${req.kind}`;
  };
  return { dir, calls, handle };
}

function request(id: string, at: number, extra: Partial<ControlRequest> = {}): ControlRequest {
  return { id, at, kind: "session.list", ...extra };
}

function remaining(dir: string): string[] {
  try {
    return fs.readdirSync(controlInboxDir(dir));
  } catch {
    return [];
  }
}

describe("ControlInboxRunner：过期与失败路径", () => {
  it("未过期请求：执行并写回成功应答，收件箱清空", async () => {
    const h = setup();
    writeControlRequest(request("r1", 1000, { expiresAt: 2000 }), h.dir);
    const runner = new ControlInboxRunner(h.dir, {
      handle: h.handle,
      log: () => {},
      now: () => 1500,
    });
    await runner.scan("owner");
    expect(h.calls).toEqual(["session.list:owner"]);
    expect(readControlResponse("r1", h.dir)).toMatchObject({ ok: true, text: "✅ session.list" });
    expect(remaining(h.dir)).toEqual([]);
  });

  it("已过期请求：不执行，但一定写回失败应答（CLI 不能白等）", async () => {
    const h = setup();
    writeControlRequest(request("r1", 1000, { expiresAt: 1200 }), h.dir);
    const runner = new ControlInboxRunner(h.dir, {
      handle: h.handle,
      log: () => {},
      now: () => 2000,
    });
    await runner.scan("owner");
    expect(h.calls).toEqual([]);
    const res = readControlResponse("r1", h.dir);
    expect(res?.ok).toBe(false);
    expect(res?.text).toContain("已超时");
  });

  it("处理返回 ❌ → 应答 ok=false；抛错 → 应答 ❌ 处理出错，后续请求继续", async () => {
    const h = setup();
    h.handle = async (req, owner) => {
      h.calls.push(`${req.kind}:${owner}`);
      if (req.id === "r1") throw new Error("boom");
      if (req.id === "r2") return "❌ 参数不对";
      return "✅ ok";
    };
    writeControlRequest(request("r1", 1001), h.dir);
    writeControlRequest(request("r2", 1002), h.dir);
    writeControlRequest(request("r3", 1003), h.dir);
    const runner = new ControlInboxRunner(h.dir, {
      handle: h.handle,
      log: () => {},
      now: () => 2000,
    });
    await runner.scan("owner");
    expect(h.calls).toHaveLength(3);
    expect(readControlResponse("r1", h.dir)).toMatchObject({ ok: false });
    expect(readControlResponse("r1", h.dir)?.text).toContain("处理出错");
    expect(readControlResponse("r2", h.dir)).toMatchObject({ ok: false, text: "❌ 参数不对" });
    expect(readControlResponse("r3", h.dir)).toMatchObject({ ok: true, text: "✅ ok" });
  });

  it("坏 JSON 请求丢弃且不写应答，后面的合法请求照常执行", async () => {
    const h = setup();
    writeControlRequest(request("good", 1002), h.dir);
    fs.writeFileSync(path.join(controlInboxDir(h.dir), "1001-bad.json"), "{oops", "utf-8");
    const runner = new ControlInboxRunner(h.dir, {
      handle: h.handle,
      log: () => {},
      now: () => 2000,
    });
    await runner.scan("owner");
    expect(h.calls).toEqual(["session.list:owner"]);
    expect(readControlResponse("good", h.dir)?.ok).toBe(true);
    expect(remaining(h.dir)).toEqual([]);
  });
});

describe("ControlInboxRunner：串行门", () => {
  it("前一条还在执行时，后一次扫描直接返回；结束后再扫描会处理剩下的请求", async () => {
    const h = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    h.handle = async (req, owner) => {
      h.calls.push(`${req.kind}:${owner}:${req.id}`);
      if (req.id === "r1") await gate;
      return "✅ ok";
    };
    writeControlRequest(request("r1", 1001), h.dir);
    writeControlRequest(request("r2", 1002), h.dir);
    const runner = new ControlInboxRunner(h.dir, {
      handle: h.handle,
      log: () => {},
      now: () => 2000,
    });

    const first = runner.scan("owner");
    await Promise.resolve();
    // 第二次扫描看见 busy，立刻返回；r2 还留在收件箱里
    await runner.scan("owner");
    expect(h.calls).toEqual(["session.list:owner:r1"]);
    expect(readControlResponse("r2", h.dir)).toBeNull();

    release();
    await first;
    await runner.scan("owner");
    expect(h.calls).toEqual(["session.list:owner:r1", "session.list:owner:r2"]);
    expect(readControlResponse("r2", h.dir)?.ok).toBe(true);
  });
});
