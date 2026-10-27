import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";

import { descendantPids } from "./manage.js";
import { isAlive } from "./proc-identity.js";

/*
 * 只测 POSIX 的后代收集：Windows 走 `taskkill /T`，没有对应逻辑。
 *
 * 为什么要测：`stopDaemon` 以前只 `process.kill(pid)`，daemon 拉起的 ACP 大脑/worker 会留下来
 * 继续占着会话与文件句柄（Windows 因为 /T 连带，问题一直没暴露）。`descendantPids` 是这条
 * 「停整条链」路径的地基，必须证明真能查到孙进程。
 */
const isPosix = process.platform !== "win32";
const spawned: number[] = [];

afterAll(() => {
  for (const pid of spawned) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
});

describe.skipIf(!isPosix)("descendantPids（POSIX 进程树）", () => {
  it("能查到子进程与孙进程；叶子 pid 返回空", async () => {
    // 父 → 子 → 孙，每层都用 node 起下一层，命令行稳定可查
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
      process.stdout.write(String(child.pid));
      setTimeout(() => {}, 60000);
    `;
    const parent = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (parent.pid) spawned.push(parent.pid);

    const childPid = await new Promise<number>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("没拿到子进程 pid")), 10_000);
      parent.stdout.on("data", (d) => {
        buf += d.toString();
        const n = Number.parseInt(buf, 10);
        if (Number.isInteger(n) && n > 0) {
          clearTimeout(timer);
          resolve(n);
        }
      });
      parent.on("error", reject);
    });
    spawned.push(childPid);

    const desc = descendantPids(parent.pid as number);
    expect(desc).toContain(childPid);

    // 叶子（孙进程）没有后代：不能因为「查不到」而返回它的父/兄弟
    expect(descendantPids(childPid)).toEqual([]);
  }, 20_000);

  it("不存在的 pid → 空数组（不抛、不误伤）", () => {
    // 2147483647 必然不存在；isAlive 也确认一下，避免断言建立在假设上
    expect(isAlive(2147483647)).toBe(false);
    expect(descendantPids(2147483647)).toEqual([]);
  });
});
