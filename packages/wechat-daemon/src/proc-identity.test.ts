import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";

import {
  isAlive,
  matchesMarkers,
  commandLines,
  isOurProcess,
  brainPidMarkers,
  CLI_PID_MARKERS,
} from "./proc-identity.js";

// 一个「活着但绝不是我们」的进程：用来复现「陈旧 pid 文件 + pid 复用 → 误杀/误判」的场景。
const dummy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
const dummyPid = dummy.pid ?? 0;
const NEVER = 2147483647; // 必然不存在的 pid

afterAll(() => {
  try {
    dummy.kill();
  } catch {
    /* ignore */
  }
});

describe("matchesMarkers（纯逻辑，无系统调用）", () => {
  it("命中我们 CLI：源码仓库 / 全局安装（node_modules/wemind）/ 大小写与斜杠都不敏感", () => {
    // 源码仓库（目录名仍是 wechat-daemon）：靠路径里的仓库名 WeMind 命中
    expect(
      matchesMarkers(
        String.raw`node D:\repo\WeMind\packages\wechat-daemon\dist\cli.js daemon`,
        CLI_PID_MARKERS,
      ),
    ).toBe(true);
    // 发布后的全局安装：npm bin shim 最终 exec 的是 node_modules/wemind/dist/cli.js
    expect(
      matchesMarkers(
        String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\wemind\dist\cli.js daemon`,
        CLI_PID_MARKERS,
      ),
    ).toBe(true);
    expect(
      matchesMarkers(
        "node /usr/local/lib/node_modules/wemind/dist/cli.js _watchdog",
        CLI_PID_MARKERS,
      ),
    ).toBe(true);
    expect(
      matchesMarkers(String.raw`pwsh -File D:\repo\scripts\run-daemon.ps1`, CLI_PID_MARKERS),
    ).toBe(true);
    // 仓库根目录用**相对路径**手跑（`node packages/wechat-daemon/dist/cli.js daemon`）：命令行里没有仓库名/包名，
    // 只有源码目录名 → 必须靠追加的那组 marker 命中，否则 daemon 活着、CLI 却认定「没在运行」。
    expect(
      matchesMarkers("node packages/wechat-daemon/dist/cli.js daemon", CLI_PID_MARKERS),
    ).toBe(true);
    expect(matchesMarkers("node ./packages/wechat-daemon/dist/cli.js brain", CLI_PID_MARKERS)).toBe(
      true,
    );
  });

  it("组合内 token 必须全部出现（AND），不同组合任一命中即可（OR）", () => {
    expect(matchesMarkers("node /other/proj/cli.js daemon", CLI_PID_MARKERS)).toBe(false); // 缺 wemind
    // 追加的 `wechat-daemon` 组还要求 `dist`：别的项目里恰好有个同名目录时不会误命中（这串最终用于杀进程）
    expect(matchesMarkers("node /other/proj/wechat-daemon-tools/cli.js", CLI_PID_MARKERS)).toBe(
      false,
    );
    expect(matchesMarkers("node /other/proj/wechat-daemon/cli.js", CLI_PID_MARKERS)).toBe(false);
    expect(matchesMarkers("opencode", [["opencode", "acp"]])).toBe(false); // 缺 acp
    expect(matchesMarkers("opencode acp", [["nope"], ["opencode", "acp"]])).toBe(true); // 第二组命中
  });

  it("空命令行 / 空组合 → 一律判否（保守，绝不误杀）", () => {
    expect(matchesMarkers(undefined, CLI_PID_MARKERS)).toBe(false);
    expect(matchesMarkers("", CLI_PID_MARKERS)).toBe(false);
    expect(matchesMarkers("anything at all", [])).toBe(false);
    expect(matchesMarkers("anything at all", [[]])).toBe(false);
  });

  it("大脑 marker：区分 `opencode acp` 与用户自己的 `opencode serve`", () => {
    const m = brainPidMarkers("opencode", ["acp"]);
    expect(matchesMarkers(String.raw`cmd.exe /d /s /c "opencode acp"`, m)).toBe(true);
    expect(matchesMarkers(String.raw`C:\x\opencode.exe acp`, m)).toBe(true);
    // 本机 OpenCode 服务（用户会话的宿主）：命令行不含 acp → 绝不命中
    expect(matchesMarkers(String.raw`opencode.exe serve --service`, m)).toBe(false);
  });

  it("brainPidMarkers：剥扩展名/取文件名（两种分隔符都认）；bin 为空 → 空（恒判否）", () => {
    expect(brainPidMarkers(String.raw`C:\x\opencode.cmd`, ["acp"])).toEqual([["opencode", "acp"]]);
    expect(brainPidMarkers("/usr/local/bin/opencode", ["acp"])).toEqual([["opencode", "acp"]]);
    expect(brainPidMarkers("kiro-cli.exe", ["acp", "--trust-all-tools"])).toEqual([
      ["kiro-cli", "acp", "--trust-all-tools"],
    ]);
    expect(brainPidMarkers("", [])).toEqual([]);
    // bin 只剩目录 / 为空 → 绝不退化成「只按 args 匹配」（否则会误伤含 acp 的无关进程）
    expect(brainPidMarkers("", ["acp"])).toEqual([]);
    expect(brainPidMarkers("/x/", ["acp"])).toEqual([]);
  });
});

describe("isAlive / commandLines / isOurProcess（真实系统调用）", () => {
  it("isAlive：自己活着；非法/不存在的 pid 为否", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(NEVER)).toBe(false);
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
    expect(isAlive(null)).toBe(false);
    expect(isAlive(undefined)).toBe(false);
  });

  it("commandLines：能查到自己与 dummy；不存在的 pid 查不到（不白起进程）", () => {
    const lines = commandLines([process.pid, dummyPid, NEVER]);
    expect(lines.get(process.pid)?.toLowerCase()).toContain("node");
    expect(lines.has(dummyPid)).toBe(true);
    expect(lines.has(NEVER)).toBe(false);
  });

  it("isOurProcess：活着但不是我们的进程 → false（重启后误杀/误判的根因场景）", () => {
    expect(isAlive(dummyPid)).toBe(true);
    expect(isOurProcess(dummyPid, CLI_PID_MARKERS)).toBe(false);
    expect(isOurProcess(dummyPid, brainPidMarkers("opencode", ["acp"]))).toBe(false);
    expect(isOurProcess(NEVER, CLI_PID_MARKERS)).toBe(false);
  });
});
