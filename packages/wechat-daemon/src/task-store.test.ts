import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  emptyTaskStore,
  loadTaskStore,
  markInterrupted,
  removeTask,
  saveTaskStore,
  takeNextId,
  taskStorePath,
  upsertTask,
  type StoredTask,
} from "./task-store.js";

/**
 * 任务表落盘只服务一件事：**daemon 重启后能续跑**（编号不归零、未完成的标「已中断」）。
 * 所以这里钉死三件事：往返不丢字段、坏文件降级为空表（不阻塞启动）、编号只增不复用。
 */

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-tstore-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const task = (over: Partial<StoredTask> = {}): StoredTask => ({
  id: 1,
  userId: "u1",
  agent: "kiro",
  key: "task-1@u1",
  status: "running",
  turns: 2,
  startedAt: 111,
  ...over,
});

describe("task-store 往返", () => {
  it("缺文件 → 空表（不是抛错）", () => {
    expect(loadTaskStore(dir)).toEqual({ version: 1, tasks: [], nextId: {} });
  });

  it("写→读 不丢字段（含 lastOutput/cwd/nextId）", () => {
    const s = emptyTaskStore();
    upsertTask(s, task({ lastOutput: "🤖【任务】做了一半", cwd: "D:\\proj" }));
    s.nextId.u1 = 3;
    saveTaskStore(s, dir);
    const back = loadTaskStore(dir);
    expect(back.tasks).toHaveLength(1);
    expect(back.tasks[0]).toMatchObject({
      id: 1,
      agent: "kiro",
      key: "task-1@u1",
      status: "running",
      turns: 2,
      lastOutput: "🤖【任务】做了一半",
      cwd: "D:\\proj",
    });
    expect(back.nextId).toEqual({ u1: 3 });
  });

  it("坏 JSON / 数组 / 缺字段的行 → 降级为空表或不收该行（绝不阻塞启动）", () => {
    fs.writeFileSync(taskStorePath(dir), "{ 这不是 JSON", "utf-8");
    expect(loadTaskStore(dir).tasks).toEqual([]);
    fs.writeFileSync(taskStorePath(dir), "[1,2,3]", "utf-8");
    expect(loadTaskStore(dir).tasks).toEqual([]);
    fs.writeFileSync(
      taskStorePath(dir),
      JSON.stringify({ tasks: [{ id: "x" }, { id: 2, userId: "u1", status: "什么鬼" }] }),
      "utf-8",
    );
    const back = loadTaskStore(dir);
    expect(back.tasks.map((t) => t.id)).toEqual([2]);
    expect(back.tasks[0].status).toBe("interrupted"); // 认不出的状态按「已中断」处理（保守：宁可让用户按继续）
    expect(back.tasks[0].key).toBe("task-2@u1"); // 缺 key 按约定补
  });
});

describe("重启语义", () => {
  it("markInterrupted：running/waiting → interrupted；已中断的不重复标", () => {
    const s = emptyTaskStore();
    s.tasks = [
      task({ id: 1, status: "running" }),
      task({ id: 2, status: "waiting" }),
      task({ id: 3, status: "interrupted" }),
    ];
    const hit = markInterrupted(s);
    expect(hit.map((t) => t.id)).toEqual([1, 2]);
    expect(s.tasks.map((t) => t.status)).toEqual(["interrupted", "interrupted", "interrupted"]);
  });

  it("编号按用户单调递增、不复用；表里的编号也计入 nextId（半截文件/手改不发号撞车）", () => {
    const s = emptyTaskStore();
    expect(takeNextId(s, "u1")).toBe(1);
    expect(takeNextId(s, "u1")).toBe(2);
    expect(takeNextId(s, "u2")).toBe(1); // 各自独立
    s.tasks = [task({ id: 9, userId: "u1" }), task({ id: 4, userId: "u2" })];
    saveTaskStore(s, dir);
    const back = loadTaskStore(dir);
    expect(takeNextId(back, "u1")).toBe(10); // 表里已有 9 → 下一个 10，绝不发 1
    expect(takeNextId(back, "u2")).toBe(5);
  });

  it("removeTask 只删指定编号", () => {
    const s = emptyTaskStore();
    s.tasks = [task({ id: 1 }), task({ id: 2 })];
    expect(removeTask(s, 1)).toBe(true);
    expect(removeTask(s, 1)).toBe(false);
    expect(s.tasks.map((t) => t.id)).toEqual([2]);
  });

  it("upsertTask 覆盖同编号、追加新编号（顺序稳定）", () => {
    const s = emptyTaskStore();
    upsertTask(s, task({ id: 1, turns: 1 }));
    upsertTask(s, task({ id: 2, turns: 1 }));
    upsertTask(s, task({ id: 1, turns: 5 }));
    expect(s.tasks.map((t) => [t.id, t.turns])).toEqual([
      [1, 5],
      [2, 1],
    ]);
  });
});
