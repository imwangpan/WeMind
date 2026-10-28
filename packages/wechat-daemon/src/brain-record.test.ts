import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { brainRecord } from "./manage.js";

/**
 * `stop`/`list` 判定大脑进程身份时的取值来源。
 *
 * 为什么值得一测：改造前用「**当前配置里**的 agent」算特征串，于是 `wemind brain set X`（不带 --restart）
 * 之后就认不出正在跑的旧 agent 进程 —— 表现为 `stop` 跳杀（留下孤儿）、`list` 显示已停止。
 * 现在优先用起进程时写下的身份记录（真实 bin/args）。
 */
let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-brainrec-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("brainRecord", () => {
  it("有身份记录 → pid/特征串/agent 都来自记录（与配置里是哪个 agent 无关）", () => {
    fs.writeFileSync(
      path.join(dir, "brain.pid"),
      JSON.stringify({
        pid: 4242,
        agent: "qoder",
        bin: "C:\\q\\qodercli.exe",
        args: ["--acp", "--yolo"],
        shell: false,
        state: "busy",
        startedAt: 1,
        writtenAt: 1,
      }),
      "utf-8",
    );
    const r = brainRecord(dir);
    expect(r.pid).toBe(4242);
    expect(r.agent).toBe("qoder");
    expect(r.markers).toEqual([["qodercli", "--acp", "--yolo"]]);
  });

  it("旧版裸整数 → 有 pid 但 markers 为 null（调用方回退按配置算）", () => {
    fs.writeFileSync(path.join(dir, "brain.pid"), "12345", "utf-8");
    const r = brainRecord(dir);
    expect(r.pid).toBe(12345);
    expect(r.markers).toBeNull();
    expect(r.agent).toBe("");
  });

  it("无文件 / 损坏 → 全空（不抛）", () => {
    expect(brainRecord(dir)).toEqual({ pid: null, markers: null, agent: "" });
    fs.writeFileSync(path.join(dir, "brain.pid"), "{ 坏", "utf-8");
    expect(brainRecord(dir)).toEqual({ pid: null, markers: null, agent: "" });
  });
});
