import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * `scripts/run-daemon.ps1` 的契约测试（源码仓库的常驻外壳）。
 *
 * 用 `-DryRun` 只解析参数并打印将执行的命令，不启动任何进程——否则测试会真的拉起 daemon。
 * 重点守住两条：默认走 cli 薄壳（`start`），`-Mode shell` 才走旧的 `daemon` 循环；任何模式都不得执行 `autostart install`。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const script = path.join(repoRoot, "scripts", "run-daemon.ps1");

describe("scripts/run-daemon.ps1 日志格式", () => {
  it("自己写进 daemon.log 的每行都带 [LEVEL]（--errors 才能精确识别）", () => {
    const lines = fs
      .readFileSync(script, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes("[wemind/wechat-daemon/wrapper]"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/\[wemind\/wechat-daemon\/wrapper\]\[(INFO|WARN|ERROR)\]/);
    }
  });
});

/** 一次脚本调用的结果；pwsh 冷启动约 1 秒，所以 5 个用例在 beforeAll 里并发跑，不逐个等。 */
type ScriptRun = { status: number | null; stdout: string; stderr: string };

function runScript(args: string[]): Promise<ScriptRun> {
  const env = { ...process.env };
  delete env.WECHAT_ACCOUNT;
  delete env.WECHAT_DATA_DIR;
  return new Promise((resolve) => {
    const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, ...args], {
      cwd: repoRoot,
      env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

const CASES = {
  defaultCli: ["-DryRun"],
  account: ["-Mode", "cli", "-Account", "aaa111", "-DryRun"],
  all: ["-Mode", "cli", "-All", "-DryRun"],
  shell: ["-Mode", "shell", "-Account", "aaa111", "-DryRun"],
  mutex: ["-Mode", "cli", "-All", "-Account", "aaa111", "-DryRun"],
} as const satisfies Record<string, string[]>;

type CaseName = keyof typeof CASES;

const hasPwsh =
  spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    windowsHide: true,
  }).status === 0;

describe.skipIf(!hasPwsh)("scripts/run-daemon.ps1（源码常驻外壳）", () => {
  const runs = new Map<CaseName, Promise<ScriptRun>>();

  beforeAll(() => {
    for (const name of Object.keys(CASES) as CaseName[]) {
      runs.set(name, runScript(CASES[name]));
    }
  });

  async function output(name: CaseName): Promise<ScriptRun> {
    return runs.get(name) ?? runScript(CASES[name]);
  }

  it("默认 cli 模式：薄壳执行 wemind start，不执行 autostart install", async () => {
    const r = await output("defaultCli");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DRYRUN mode=cli");
    expect(r.stdout).toMatch(/args=.*\bstart\b/);
    expect(r.stdout).not.toContain("autostart");
  }, 60_000);

  it("-Account <key>：把 key 传给 start", async () => {
    const r = await output("account");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("start aaa111");
  }, 60_000);

  it("-All：传给 start --all（自启场景）", async () => {
    const r = await output("all");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("start --all");
  }, 60_000);

  it("-Mode shell：保留旧行为，直接跑 cli.js daemon（不经过 start）", async () => {
    const r = await output("shell");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("mode=shell");
    expect(r.stdout).toContain("daemon account=aaa111");
    expect(r.stdout).not.toContain(" start");
  }, 60_000);

  it("-All 与 -Account 互斥：直接报错，不启动任何进程", async () => {
    const r = await output("mutex");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("不能同时使用");
  }, 60_000);
});
