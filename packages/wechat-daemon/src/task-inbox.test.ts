import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitTaskAck,
  clearTaskDirs,
  taskInboxDir,
  taskOutDir,
  writeTaskAck,
  writeTaskCmd,
} from "./task-inbox.js";

/**
 * 任务收件箱的两个方向：命令（CLI 写、daemon 读）与答复（daemon 写、CLI 读）。
 * 回结果通道的存在理由见 task-inbox.ts 头部注释——「没等到答复」必须能与「答复说失败」区分开。
 */

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-inbox-"));
});

const files = (p: string) => (fs.existsSync(p) ? fs.readdirSync(p).sort() : []);

describe("收命令通道：写命令文件", () => {
  it("命令文件带 ack id 与时间戳，文件名用同一个 id（按名排序即按时间排序）", () => {
    const id = writeTaskCmd(dir, { kind: "dispatch", text: "做X", cwd: "D:\\p" });
    const names = files(taskInboxDir(dir));
    expect(names).toEqual([`${id}.json`]);
    const cmd = JSON.parse(fs.readFileSync(path.join(taskInboxDir(dir), names[0]), "utf-8"));
    expect(cmd).toMatchObject({ kind: "dispatch", text: "做X", cwd: "D:\\p", ack: id });
    expect(typeof cmd.ts).toBe("number");
    expect(id.startsWith(String(cmd.ts))).toBe(true); // 时间戳前缀 → 字典序＝时间序
  });

  it("目录不存在也能写（自建），且不留 .tmp 半截文件", () => {
    expect(fs.existsSync(taskInboxDir(dir))).toBe(false);
    writeTaskCmd(dir, { kind: "stop", id: "all" });
    expect(files(taskInboxDir(dir)).length).toBe(1);
    expect(files(taskInboxDir(dir)).some((f) => f.includes(".tmp"))).toBe(false);
  });

  it("两次写命令拿到不同 id（同毫秒也不撞）", () => {
    const a = writeTaskCmd(dir, { kind: "reply", text: "1" });
    const b = writeTaskCmd(dir, { kind: "reply", text: "2" });
    expect(a).not.toBe(b);
    expect(files(taskInboxDir(dir)).length).toBe(2);
  });
});

describe("回结果通道：写答复与短轮询", () => {
  it("往返：daemon 写、CLI 读到原文并删掉（目录不留垃圾）", async () => {
    const id = writeTaskCmd(dir, { kind: "dispatch", text: "做X" });
    writeTaskAck(dir, id, "✅ 已派发任务 #3（kiro 执行）。");
    const a = await awaitTaskAck(dir, id, 2000, 50);
    expect(a?.text).toBe("✅ 已派发任务 #3（kiro 执行）。");
    expect(a?.ok).toBe(true);
    expect(files(taskOutDir(dir))).toEqual([]);
  });

  it("ok 由文案决定：以 ❌ 开头的算失败（CLI 这才有办法给退出码/着色）", async () => {
    writeTaskAck(dir, "x1", "❌ 不能用「nope」跑任务：没有这个 agent");
    writeTaskAck(dir, "x2", "🛑 任务 #2 已结束。");
    expect((await awaitTaskAck(dir, "x1", 1000, 20))?.ok).toBe(false);
    expect((await awaitTaskAck(dir, "x2", 1000, 20))?.ok).toBe(true);
  });

  it("等不到就超时返回 null（老 daemon 不认这条通道 → CLI 退回「已发送」措辞）", async () => {
    const t0 = Date.now();
    expect(await awaitTaskAck(dir, "从未写过", 300, 50)).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it("id 为空时静默不写（没有请求方，别在目录里留无主答复）", () => {
    writeTaskAck(dir, undefined, "❌ 不认识的任务命令：whoops");
    expect(files(taskOutDir(dir))).toEqual([]);
  });

  it("答复目录写不进去也不抛（答复丢了不该影响命令本身）", () => {
    // 拿一个「答复目录其实是文件」的布局把 mkdir 逼失败
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(taskOutDir(dir), "占位", "utf-8");
    expect(() => writeTaskAck(dir, "any", "✅ 已派发")).not.toThrow();
  });
});

describe("清理", () => {
  it("clearTaskDirs 清掉两个通道的残留并重建收件箱（防重放）", () => {
    writeTaskCmd(dir, { kind: "dispatch", text: "旧命令" });
    writeTaskAck(dir, "old", "旧答复");
    clearTaskDirs(dir);
    expect(files(taskInboxDir(dir))).toEqual([]);
    expect(files(taskOutDir(dir))).toEqual([]);
    expect(fs.existsSync(taskInboxDir(dir))).toBe(true); // 重建：daemon 起来后就能收命令
  });

  it("目录本就不存在时也能清（首次启动/被手工删过）", () => {
    expect(() => clearTaskDirs(dir)).not.toThrow();
    expect(fs.existsSync(taskInboxDir(dir))).toBe(true);
  });
});
