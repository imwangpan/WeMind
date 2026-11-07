import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectPM2 } from "./pm2-detector.js";

/**
 * 自启状态探测与清理。
 *
 * 状态只有四种：都没有 / 只有系统触发器 / 只有 PM2 / 两者都有（mixed）。
 * `mixed` 必须让用户决定保留哪一个——同一个账号被拉起两次会抢同一个 bot token。
 */

/** 系统触发器名（Windows 计划任务名 / 注册表 Run 值名），native 模式。 */
export const AUTOSTART_TASK_NAME = "wemind-autostart";
/**
 * Windows 的 PM2 自启触发器名：Windows 上 `pm2 startup` 不原生支持，开机后必须有人执行 `pm2 resurrect`；
 * 这里让计划任务执行 `wemind start --all --runner pm2`。**用不同任务名区分**，状态探测就不必解析任务内容。
 */
export const AUTOSTART_TASK_NAME_PM2 = "wemind-autostart-pm2";
/** Linux systemd 用户单元名前缀；实例名 `<前缀>@<key>.service`。 */
export const SYSTEMD_UNIT_PREFIX = "wemind";
/** macOS LaunchAgent 的 Label 前缀；完整 Label 为 `<前缀>.<key>`。 */
export const LAUNCHD_LABEL_PREFIX = "dev.wemind";

export type MixedConfigStatus = "none" | "native-only" | "pm2-only" | "mixed";

/** 系统触发器的两个用途：直接拉起内置 watchdog（native），或拉起 PM2 实例（pm2）。 */
export interface TriggerInfo {
  native: boolean;
  pm2: boolean;
}

/** 探测当前自启配置状态。 */
export async function detectMixedConfig(): Promise<MixedConfigStatus> {
  const trig = getSystemTriggerInfo();
  const hasPM2 = checkPM2Instances();
  if (trig.native && hasPM2) return "mixed";
  if (trig.native) return "native-only";
  if (trig.pm2 || hasPM2) return "pm2-only";
  return "none";
}

/** 调系统工具（schtasks / reg / systemctl / launchctl 都是可执行文件，不需要 shell）。 */
function run(cmd: string, args: string[]): { status: number | null; stdout: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000, windowsHide: true });
    return { status: r.status, stdout: r.stdout ?? "" };
  } catch {
    return { status: null, stdout: "" };
  }
}

/**
 * 调 pm2：Windows 上是 `pm2.cmd`，必须经 shell；且不能同时传 args 数组（DEP0190 + 只拼接不转义），
 * 所以统一用整条命令字符串。拼进命令的只有固定子命令与数字 pm_id / 受控 key，无外部输入。
 */
function runPM2(sub: string): { status: number | null; stdout: string } {
  try {
    const r = spawnSync(`pm2 ${sub}`, {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      shell: true,
    });
    return { status: r.status, stdout: r.stdout ?? "" };
  } catch {
    return { status: null, stdout: "" };
  }
}

/** 探测系统触发器（Windows 计划任务 / Run 键；systemd；LaunchAgent）。`status` 用它区分「实例在跑」与「重启后会自动恢复」。 */
export function getSystemTriggerInfo(): TriggerInfo {
  switch (process.platform) {
    case "win32":
      return {
        native: windowsTriggerExists(AUTOSTART_TASK_NAME),
        pm2: windowsTriggerExists(AUTOSTART_TASK_NAME_PM2),
      };
    case "darwin": {
      const r = run("launchctl", ["list"]);
      return {
        native: r.status === 0 && r.stdout.includes(`${LAUNCHD_LABEL_PREFIX}.`),
        pm2: false,
      };
    }
    case "linux": {
      const r = run("systemctl", ["--user", "list-unit-files", `${SYSTEMD_UNIT_PREFIX}@*.service`]);
      return {
        native: r.status === 0 && r.stdout.includes(`${SYSTEMD_UNIT_PREFIX}@`),
        pm2: false,
      };
    }
    default:
      return { native: false, pm2: false };
  }
}

/** Windows：计划任务或注册表 Run 键任一存在即算（安装时优先任务，被拒才降级 Run）。 */
function windowsTriggerExists(name: string): boolean {
  if (run("schtasks", ["/Query", "/TN", name]).status === 0) return true;
  const reg = run("reg", [
    "query",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "/v",
    name,
  ]);
  return reg.status === 0 && reg.stdout.includes(name);
}

function checkPM2Instances(): boolean {
  const { available } = detectPM2();
  if (!available) return false;
  return pm2InstanceNames().length > 0;
}

/** 解析 `pm2 jlist` 的 JSON；非 JSON（pm2 未运行时可能输出提示文本）当作没有实例。 */
function pm2InstanceNames(): string[] {
  const r = runPM2("jlist");
  if (r.status !== 0) return [];
  try {
    const list = JSON.parse(r.stdout) as Array<{ name?: string }>;
    return list.map((i) => i.name ?? "").filter((n) => n.startsWith("wemind-"));
  } catch {
    return [];
  }
}

/** 人工确认：检测到双重配置时由用户决定保留哪一个。 */
export async function promptForMixedConfig(): Promise<"keep-native" | "keep-pm2" | "clean-all"> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

  console.log("\n检测到双重自启配置：");
  console.log("  · 系统触发器（计划任务 / systemd / LaunchAgent）");
  console.log("  · PM2 实例（wemind-*）");
  console.log("\n同一个账号被拉起两次会争抢同一个 bot token，必须只保留一种。\n");
  console.log("请选择处理方式：");
  console.log("  1) 只保留系统触发器（删除所有 PM2 实例）");
  console.log("  2) 只保留 PM2（删除所有系统触发器）");
  console.log("  3) 全部清空（之后重新安装）");

  const choice = (await ask("你的选择 [1-3]：")).trim();
  rl.close();

  switch (choice) {
    case "1":
      return "keep-native";
    case "2":
      return "keep-pm2";
    case "3":
      return "clean-all";
    default:
      throw new Error(`无效选择「${choice}」，请输入 1、2 或 3`);
  }
}

/** 删除所有 wemind-* PM2 实例。 */
export function cleanupPM2Instances(): void {
  const r = runPM2("jlist");
  if (r.status !== 0) return;
  let instances: Array<{ name?: string; pm_id?: number }>;
  try {
    instances = JSON.parse(r.stdout) as Array<{ name?: string; pm_id?: number }>;
  } catch {
    return;
  }
  let deleted = 0;
  for (const inst of instances) {
    if (!inst.name?.startsWith("wemind-")) continue;
    runPM2(`delete ${Number(inst.pm_id)}`);
    console.log(`已删除 PM2 实例：${inst.name}`);
    deleted++;
  }
  // 不同步 dump 的话，`pm2 resurrect`（pm2 startup 生成的单元）会在重启后把这些实例重新拉起来
  if (deleted && runPM2("save").status !== 0) {
    console.warn(
      "已删除 PM2 实例，但 pm2 save 失败：重启后 pm2 可能恢复旧列表，请手动执行 pm2 save。",
    );
  }
}

/** 删除系统触发器（按平台）。 */
export function cleanupSystemTriggers(): void {
  switch (process.platform) {
    case "win32": {
      for (const name of [AUTOSTART_TASK_NAME, AUTOSTART_TASK_NAME_PM2]) {
        run("schtasks", ["/Delete", "/TN", name, "/F"]);
        run("reg", [
          "delete",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
          "/v",
          name,
          "/F",
        ]);
      }
      console.log("已删除 Windows 计划任务与注册表 Run 键（若存在）");
      return;
    }
    case "linux": {
      const units = run("systemctl", [
        "--user",
        "list-unit-files",
        `${SYSTEMD_UNIT_PREFIX}@*.service`,
        "--no-legend",
      ]);
      for (const line of units.stdout.split("\n")) {
        const unit = line.trim().split(/\s+/)[0];
        if (!unit?.startsWith(`${SYSTEMD_UNIT_PREFIX}@`)) continue;
        run("systemctl", ["--user", "disable", "--now", unit]);
      }
      // systemctl 没有「删除单元文件」命令，手工清掉
      const dir = path.join(os.homedir(), ".config", "systemd", "user");
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(`${SYSTEMD_UNIT_PREFIX}@`) && f.endsWith(".service")) {
            fs.rmSync(path.join(dir, f), { force: true });
          }
        }
      } catch {
        /* 目录不存在：本来就没装 */
      }
      run("systemctl", ["--user", "daemon-reload"]);
      console.log("已禁用并移除 systemd 用户单元");
      return;
    }
    case "darwin": {
      const dir = path.join(os.homedir(), "Library", "LaunchAgents");
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.startsWith(`${LAUNCHD_LABEL_PREFIX}.`) || !f.endsWith(".plist")) continue;
          const file = path.join(dir, f);
          try {
            execFileSync("launchctl", ["unload", file], { stdio: "ignore" });
          } catch {
            /* 未加载 */
          }
          fs.rmSync(file, { force: true });
        }
      } catch {
        /* 目录不存在 */
      }
      console.log("已卸载并移除 LaunchAgent");
      return;
    }
    default:
      return;
  }
}
