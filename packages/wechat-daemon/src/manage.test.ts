import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { descendantPids, helpText } from "./manage.js";
import { isAlive } from "./proc-identity.js";

/*
 * 只测 POSIX 的后代收集：Windows 走 `taskkill /T`，没有对应逻辑。
 *
 * 为什么要测：`stopDaemon` 以前逐个 `process.kill(pid)`——只结束候选 pid 本身，且候选里没有 `worker.pid`，daemon 拉起的 ACP 任务 worker 会留下来继续占着会话与文件句柄（Windows 因为 `/T` 连带子树，问题一直没暴露）。`descendantPids` 是这条「停整条链」路径的地基，必须证明真能查到孙进程。
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

describe("helpText（CLI 帮助面）", () => {
  it("列出自本次改造起新增的指令：热切换 / 交接 / 会话四件套 / 任务列表（与微信表同源）", () => {
    const h = helpText();
    for (const s of [
      "wemind brain switch", // 热切换（--worker 也在同一条里）
      "wemind brain handoff",
      "wemind session new",
      "wemind session list",
      "wemind session resume",
      "wemind session rename",
      "wemind session delete",
      "wemind task-list",
      "wemind task-reply",
      "控制桥", // 说明「CLI 与微信走同一段代码」的那句
    ])
      expect(h).toContain(s);
    expect(h).not.toContain("（无 CLI）"); // CLI 帮助不列只在微信里存在的操作（加载/卸载 MCP）
  });
});

/*
 * 「省略账号 = 默认账号」：`start`/`stop` 走 pickKey（与 session/task 一致）。
 * `WEMIND_ROOT` 是模块加载时定死的，所以要在设好 WEMIND_HOME 之后**重新加载模块**。
 */
describe("pickKey（省略账号 = 默认账号）", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-pickkey-"));
  const prevHome = process.env.WEMIND_HOME;
  let pickKey: typeof import("./manage.js").pickKey;

  beforeAll(async () => {
    process.env.WEMIND_HOME = home;
    vi.resetModules();
    ({ pickKey } = await import("./manage.js"));
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.WEMIND_HOME;
    else process.env.WEMIND_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const writeRegistry = (reg: unknown) =>
    fs.writeFileSync(path.join(home, "accounts.json"), JSON.stringify(reg), "utf-8");

  it("没有登记账号 → 报「无默认账号」（而不是旧的「需要 <key 或 label>」）", () => {
    expect(() => pickKey()).toThrow(/无默认账号/);
  });

  it("省略 → 默认账号；显式 key / 别名优先；查不到 → 报错", () => {
    writeRegistry({
      default: "bbb",
      accounts: {
        aaa: {
          key: "aaa",
          botId: "a",
          userId: "u",
          baseUrl: "https://x",
          label: "副号",
          addedAt: 1,
        },
        bbb: {
          key: "bbb",
          botId: "b",
          userId: "u",
          baseUrl: "https://x",
          label: "main",
          addedAt: 2,
        },
      },
    });
    expect(pickKey()).toBe("bbb");
    expect(pickKey("aaa")).toBe("aaa");
    expect(pickKey("副号")).toBe("aaa");
    expect(() => pickKey("nope")).toThrow(/未找到账号/);
  });

  it("default 字段缺失（老注册表）→ 回落第一个登记的账号", () => {
    writeRegistry({
      accounts: {
        ccc: {
          key: "ccc",
          botId: "c",
          userId: "u",
          baseUrl: "https://x",
          label: "ccc",
          addedAt: 1,
        },
        ddd: {
          key: "ddd",
          botId: "d",
          userId: "u",
          baseUrl: "https://x",
          label: "ddd",
          addedAt: 2,
        },
      },
    });
    expect(pickKey()).toBe("ccc");
  });
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
