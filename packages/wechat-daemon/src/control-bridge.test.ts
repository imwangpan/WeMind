import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitControlResponse,
  bridgePidOf,
  clearControlDirs,
  controlInboxDir,
  controlOutDir,
  controlTimeoutMs,
  markBridgeReady,
  newRequestId,
  parseControlRequest,
  readControlInbox,
  readControlResponse,
  writeControlRequest,
  writeControlResponse,
  type ControlRequest,
} from "./control-bridge.js";

/**
 * 控制桥是 CLI 唯一的写入口，所以这里重点钉两件事：
 *  ① 文件形状与往返（坏文件/非法 kind 一律丢弃，绝不让 daemon 去执行半截请求）；
 *  ② **安全边界**：请求里没有、也不可能有 bin/args/shell 的位置——伪造请求最坏只能「选一个已装的 agent」。
 */
let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-bridge-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const req = (over: Partial<ControlRequest> = {}): ControlRequest => ({
  id: newRequestId(),
  kind: "brain.switch",
  at: 1000,
  target: "kiro",
  ...over,
});

describe("parseControlRequest（唯一入口校验）", () => {
  it("已知 kind + 字符串/数字字段 → 通过", () => {
    const r = parseControlRequest({
      id: "x1",
      kind: "session.rename",
      at: 5,
      ref: "1",
      name: "周报",
      page: 2,
      taskId: 3,
    });
    expect(r).toMatchObject({
      id: "x1",
      kind: "session.rename",
      ref: "1",
      name: "周报",
      page: 2,
      taskId: 3,
    });
  });

  it("未知 kind / 缺 id / 非对象 → null（daemon 不会去执行）", () => {
    expect(parseControlRequest({ id: "x", kind: "shell.exec", text: "rm -rf /" })).toBeNull();
    expect(parseControlRequest({ kind: "brain.switch" })).toBeNull();
    expect(parseControlRequest(null)).toBeNull();
    expect(parseControlRequest([{ kind: "brain.switch" }])).toBeNull();
    expect(parseControlRequest("brain.switch")).toBeNull();
  });

  it("安全边界：bin/args/shell 这类字段**没有位置**，伪造也进不来", () => {
    const r = parseControlRequest({
      id: "x",
      kind: "brain.switch",
      target: "kiro",
      bin: "C:\\windows\\system32\\cmd.exe",
      args: ["/c", "whoami"],
      shell: true,
    });
    expect(r).not.toBeNull();
    expect(r).not.toHaveProperty("bin");
    expect(r).not.toHaveProperty("args");
    expect(r).not.toHaveProperty("shell");
    expect(JSON.stringify(r)).not.toContain("cmd.exe");
  });

  it("非法数值/超长文本被规整（taskId 只收正整数或 all；文本截断）", () => {
    const r = parseControlRequest({
      id: "x",
      kind: "task.reply",
      taskId: -3,
      text: "a".repeat(5000),
    })!;
    expect(r.taskId).toBeUndefined();
    expect(r.text!.length).toBe(2000);
    expect(parseControlRequest({ id: "x", kind: "task.stop", taskId: "all" })!.taskId).toBe("all");
  });
});

describe("收件箱 / 应答文件", () => {
  it("写请求 → 读回来：字段齐，文件名按时间排序", () => {
    writeControlRequest(req({ id: "a", at: 2000, target: "opencode" }), dir);
    writeControlRequest(req({ id: "b", at: 1000, target: "kiro" }), dir);
    const items = readControlInbox(dir);
    expect(items.map((i) => i.req?.id)).toEqual(["b", "a"]); // 文件名 = <at>-<id>，字典序即时间序
    expect(items[0].req).toMatchObject({ kind: "brain.switch", target: "kiro" });
    expect(fs.readdirSync(controlInboxDir(dir)).some((f) => f.endsWith(".tmp"))).toBe(false); // 不留半截文件
  });

  it("坏 JSON / 非法 kind 的文件：读出来 req=null（调用方丢弃），不抛", () => {
    fs.mkdirSync(controlInboxDir(dir), { recursive: true });
    fs.writeFileSync(path.join(controlInboxDir(dir), "1-bad.json"), "{ 不是 JSON", "utf-8");
    fs.writeFileSync(
      path.join(controlInboxDir(dir), "2-bad.json"),
      JSON.stringify({ id: "x", kind: "还没实现的命令" }),
      "utf-8",
    );
    const items = readControlInbox(dir);
    expect(items.map((i) => i.req)).toEqual([null, null]);
    expect(readControlInbox(path.join(dir, "没这个目录"))).toEqual([]);
  });

  it("应答：写→读往返；没有应答文件 → null（CLI 据此报超时而不是假装成功）", () => {
    writeControlResponse({ id: "r1", at: 9, ok: true, text: "✅ 好了" }, dir);
    expect(readControlResponse("r1", dir)).toMatchObject({ ok: true, text: "✅ 好了" });
    expect(readControlResponse("没写过", dir)).toBeNull();
  });

  it("awaitControlResponse：已有应答立即返回；超时返回 null", async () => {
    writeControlResponse({ id: "r2", at: 1, ok: false, text: "❌ 失败" }, dir);
    expect(await awaitControlResponse("r2", dir, 500, 10)).toMatchObject({ ok: false });
    const t0 = Date.now();
    expect(await awaitControlResponse("永远没有的", dir, 60, 10)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("clearControlDirs：清空并重建（daemon 启动时作废残留命令）", () => {
    writeControlRequest(req(), dir);
    writeControlResponse({ id: "old", at: 1, ok: true, text: "上一轮残留" }, dir);
    clearControlDirs(dir);
    expect(readControlInbox(dir)).toEqual([]);
    expect(readControlResponse("old", dir)).toBeNull();
    expect(fs.existsSync(controlInboxDir(dir))).toBe(true);
    expect(fs.existsSync(controlOutDir(dir))).toBe(true);
  });

  it("「这个 daemon 认识桥」凭据：markBridgeReady 写的 pid 能读回，clear 后消失", () => {
    expect(bridgePidOf(dir)).toBeNull(); // 没有凭据 = 旧版 daemon（CLI 据此拒绝发送）
    markBridgeReady(dir, 4321);
    expect(bridgePidOf(dir)).toBe(4321);
    clearControlDirs(dir); // daemon 重启会先清目录再写凭据
    expect(bridgePidOf(dir)).toBeNull();
  });
});

describe("controlTimeoutMs", () => {
  it("普通命令用 base（默认 30s，env 可调）", () => {
    expect(controlTimeoutMs("session.list", {})).toBe(30_000);
    expect(controlTimeoutMs("task.reply", { WEMIND_CONTROL_TIMEOUT_MS: "5000" })).toBe(5000);
  });

  it("brain.switch 给足「等在途回合结束 + 启动新大脑」的时间：不能比 daemon 自己的上限还短", () => {
    // 默认：30s base 明显不够 → 取 warm(120s) + drain(30s) + 余量
    expect(controlTimeoutMs("brain.switch", {})).toBeGreaterThan(150_000);
    expect(
      controlTimeoutMs("brain.switch", {
        WEMIND_CONTROL_TIMEOUT_MS: "600000",
        WEMIND_SWITCH_TIMEOUT_MS: "1000",
        WEMIND_SWITCH_DRAIN_MS: "1000",
      }),
    ).toBe(600_000); // 显式配得更长就听用户的
  });
});
