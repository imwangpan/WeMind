import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { scanTaskInbox, type TaskInboxOps } from "./task-inbox-runner.js";
import { taskInboxDir } from "./tasks/task-inbox.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-task-inbox-"));
  dirs.push(dir);
  fs.mkdirSync(taskInboxDir(dir), { recursive: true });
  const calls: string[] = [];
  const acks: Array<{ id?: string; text: string }> = [];
  const ops: TaskInboxOps = {
    dispatch: (_owner, text, opts) => {
      calls.push(`dispatch:${text}:${opts.agentKey ?? ""}:${opts.cwd ?? ""}:${opts.ackId ?? ""}`);
      return "ok";
    },
    inject: (_owner, text, id, ackId) => {
      calls.push(`inject:${text}:${id ?? ""}:${ackId ?? ""}`);
      return "ok";
    },
    stop: (_owner, id, ackId) => {
      calls.push(`stop:${id ?? ""}:${ackId ?? ""}`);
      return "ok";
    },
    writeAck: (id, text) => acks.push({ id, text }),
    log: () => {},
  };
  return { dir, ops, calls, acks };
}

function writeCmd(dir: string, file: string, cmd: Record<string, unknown>) {
  fs.writeFileSync(path.join(taskInboxDir(dir), file), JSON.stringify(cmd), "utf-8");
}

function remaining(dir: string): string[] {
  return fs.readdirSync(taskInboxDir(dir));
}

describe("scanTaskInbox：命令分发编排", () => {
  it("按文件名升序处理 dispatch / reply / stop，并先删文件", () => {
    const h = setup();
    writeCmd(h.dir, "002-reply.json", { kind: "reply", id: 5, text: "继续", ack: "a2" });
    writeCmd(h.dir, "001-dispatch.json", {
      kind: "dispatch",
      text: "写周报",
      agent: "pi",
      cwd: "D:/work",
      ack: "a1",
    });
    writeCmd(h.dir, "003-stop.json", { kind: "stop", id: "all", ack: "a3" });
    scanTaskInbox(h.dir, "owner", h.ops);
    expect(h.calls).toEqual(["dispatch:写周报:pi:D:/work:a1", "inject:继续:5:a2", "stop:all:a3"]);
    expect(remaining(h.dir)).toEqual([]);
  });

  it("编号 0/非数字按「无编号」处理；stop 数字编号保留", () => {
    const h = setup();
    writeCmd(h.dir, "001-reply.json", { kind: "reply", id: 0, text: "x" });
    writeCmd(h.dir, "002-stop.json", { kind: "stop", id: "3" });
    scanTaskInbox(h.dir, "owner", h.ops);
    expect(h.calls).toEqual(["inject:x::", "stop:3:"]);
  });

  it("坏 JSON 直接删掉，不影响后面的命令", () => {
    const h = setup();
    fs.writeFileSync(path.join(taskInboxDir(h.dir), "001-bad.json"), "{not json", "utf-8");
    writeCmd(h.dir, "002-reply.json", { kind: "reply", text: "好" });
    scanTaskInbox(h.dir, "owner", h.ops);
    expect(h.calls).toEqual(["inject:好::"]);
    expect(remaining(h.dir)).toEqual([]);
  });

  it("未知 kind → 写回 ❌ ack", () => {
    const h = setup();
    writeCmd(h.dir, "001-unknown.json", { kind: "wat", ack: "a1" });
    scanTaskInbox(h.dir, "owner", h.ops);
    expect(h.calls).toEqual([]);
    expect(h.acks).toEqual([{ id: "a1", text: "❌ 不认识的任务命令：wat" }]);
  });

  it("单条执行抛错 → 写回 ❌ ack，后面的命令继续处理", () => {
    const h = setup();
    h.ops.dispatch = () => {
      throw new Error("起进程失败");
    };
    writeCmd(h.dir, "001-dispatch.json", { kind: "dispatch", text: "坏", ack: "a1" });
    writeCmd(h.dir, "002-reply.json", { kind: "reply", text: "好", ack: "a2" });
    scanTaskInbox(h.dir, "owner", h.ops);
    expect(h.calls).toEqual(["inject:好::a2"]);
    expect(h.acks).toEqual([{ id: "a1", text: "❌ 命令执行出错：Error: 起进程失败" }]);
  });

  it("收件箱目录不存在 → 静默跳过", () => {
    const h = setup();
    fs.rmSync(taskInboxDir(h.dir), { recursive: true, force: true });
    expect(() => scanTaskInbox(h.dir, "owner", h.ops)).not.toThrow();
  });
});
