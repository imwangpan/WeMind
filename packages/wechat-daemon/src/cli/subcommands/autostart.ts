import * as path from "node:path";
import { print, listAccounts, type AccountMeta } from "@wemind/wechat-ilink-core";
import { stableExecPath } from "../../shared/launcher-env.js";
import { pm2Start } from "../pm2-runner.js";
import { stopDaemon } from "../process-lifecycle.js";
import {
  detectPM2,
  isPersistenceConfigured,
  markPersistenceConfigured,
} from "../../shared/pm2-detector.js";
import {
  cleanupPM2Instances,
  cleanupSystemTriggers,
  detectMixedConfig,
  getSystemTriggerInfo,
  promptForMixedConfig,
} from "../../shared/mixed-config.js";
import { installWindowsAutostart, uninstallWindowsAutostart } from "./windows-autostart.js";
import { installLaunchAgent, installSystemdUnit } from "./posix-autostart.js";

/**
 * `wemind autostart` —— 开机自启的统一入口。
 *
 * 三个子命令：
 * - `install`：默认给**所有已登记账号**安装（`--key` / `--label` 可只装一个）
 * - `uninstall`：清掉 PM2 实例与系统触发器
 * - `status`：查看当前装了什么
 *
 * 安装策略：检测到 PM2 就用 PM2（`wemind-<key>` 实例，复用 pm2-runner 的声明），
 * 否则用各平台原生触发器（Windows 计划任务→注册表，Linux systemd，macOS LaunchAgent）。
 */

const USAGE = `用法：
  wemind autostart install [--all | --key <key> | --label <标签>]
  wemind autostart uninstall
  wemind autostart status

说明：
  install 默认安装所有已登记账号；--key / --label 只安装指定账号。
  检测到 PM2 时用 PM2 托管，否则用系统原生触发器。`;

/** 帮助请求：`autostart help` / `autostart install --help` 都只打印用法，绝不分派到 install / uninstall。 */
export function autostartHelpRequested(argv: string[]): boolean {
  return argv.slice(1).some((a) => a === "help" || a === "--help" || a === "-h");
}

/**
 * 解析 install 的目标账号；纯函数，便于单测。
 * `all` 表示「没有点名账号」（默认或 --all）：Windows 任务要用 `start --all`，以后新登录的账号也自动覆盖；
 * 明确 `--key` / `--label` 时不能用 `--all`，否则单账号机器上以后新增的账号也会被带上。
 */
export function resolveAutostartKeys(
  argv: string[],
  accounts: AccountMeta[],
): { keys: string[]; all: boolean } | { error: string } {
  // 只认识这三个开关：拼错的 --labal / 多写的 key 不能静默变成「装全部账号」
  const known = new Set(["--all", "--key", "--label"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--key" || a === "--label") {
      i++; // 跳过参数值
      continue;
    }
    if (!known.has(a)) {
      return { error: `未知参数「${a}」（install 只接受 --all / --key <key> / --label <标签>）` };
    }
  }

  const takeValue = (flag: string): { value?: string; error?: string } => {
    const i = argv.indexOf(flag);
    if (i < 0) return {};
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) return { error: `${flag} 缺少参数值` };
    return { value: v };
  };

  const keyFlag = takeValue("--key");
  if (keyFlag.error) return { error: keyFlag.error };
  const labelFlag = takeValue("--label");
  if (labelFlag.error) return { error: labelFlag.error };

  if (keyFlag.value) {
    if (!accounts.some((a) => a.key === keyFlag.value)) {
      return { error: `未找到账号 key「${keyFlag.value}」。用 wemind list 查看已登记账号。` };
    }
    return { keys: [keyFlag.value], all: false };
  }

  if (labelFlag.value) {
    const hit = accounts.filter((a) => a.label === labelFlag.value);
    if (hit.length === 0) return { error: `未找到标签为「${labelFlag.value}」的账号。` };
    if (hit.length > 1) {
      return {
        error: `标签「${labelFlag.value}」对应多个账号（${hit.map((a) => a.key).join(", ")}），请改用 --key。`,
      };
    }
    return { keys: [hit[0].key], all: false };
  }

  // 默认（含显式 --all）：所有已登记账号
  if (accounts.length === 0) return { error: "没有已登记账号。先运行 wemind login 登录。" };
  return { keys: accounts.map((a) => a.key), all: true };
}

/** CLI 入口（由 manage.ts 在参数二次解析前直接分派）。 */
export async function cmdAutostart(argv: string[]): Promise<void> {
  const sub = (argv[0] ?? "").toLowerCase();

  if (sub === "" || sub === "help" || sub === "--help" || sub === "-h") {
    print(USAGE);
    return;
  }
  // `install --help` / `uninstall --help`：只打印用法，不能真的装/卸
  if (autostartHelpRequested(argv)) {
    print(USAGE);
    return;
  }
  if (sub === "install") return install(argv.slice(1));
  if (sub === "uninstall" || sub === "remove") return uninstall();
  if (sub === "status" || sub === "list") return status();
  throw new Error(`未知子命令「${sub}」\n\n${USAGE}`);
}

async function install(argv: string[]): Promise<void> {
  const accounts = listAccounts();
  const resolved = resolveAutostartKeys(argv, accounts);
  if ("error" in resolved) throw new Error(resolved.error);
  const { keys, all } = resolved;

  // 1) 双重配置：先让用户决定保留哪个，避免装完两套互相抢 token
  let forceNative = false;
  const configStatus = await detectMixedConfig();
  if (configStatus === "mixed") {
    const choice = await promptForMixedConfig();
    if (choice === "keep-native") {
      cleanupPM2Instances();
      // 用户刚选了「只保留系统触发器」：本次安装不能被下面的「检测到 PM2 优先」再改回 PM2
      forceNative = true;
    } else if (choice === "keep-pm2") cleanupSystemTriggers();
    else {
      cleanupPM2Instances();
      cleanupSystemTriggers();
    }
    print("旧配置已按选择清理。\n");
  }

  // 2) 有 PM2 就让 PM2 托管（复用 pm2-runner 的声明：daemon 前台常驻、5s 重拉、退出码 75/78 不重拉）
  const pm2 = detectPM2();
  const nodePath = stableExecPath(process.execPath);
  const cliPath = stableExecPath(currentCliPath());
  if (pm2.available && !forceNative) {
    print(`检测到 PM2 ${pm2.version}，使用 PM2 托管（实例名 wemind-<key>）。\n`);
    // 从系统触发器切到 PM2 时，先停掉并移除旧单元；否则开机时 systemd/launchd 会再拉起一份。
    if (process.platform !== "win32") cleanupSystemTriggers();
    let failed = 0;
    for (const key of keys) {
      // 切换外壳前先停旧链（builtin / 系统服务）：旧 daemon 占着 token 时，pm2 实例会以 75 退出并被标记停止。
      // 停不干净（或无法确认）就不起 pm2，否则两个实例抢同一个 bot token。
      const stop = stopDaemon(key);
      if (!stop.ok) {
        print(`跳过 ${key}：${stop.msg}`);
        failed++;
        continue;
      }
      const r = pm2Start(key, cliPath);
      print(r.msg);
      if (!r.ok) failed++;
    }
    if (process.platform === "win32") {
      // Windows 的 `pm2 startup` 不原生支持：用登录任务执行 `start --all --runner pm2` 让 pm2 重启实例。
      // 默认全部账号才用 --all；明确 --key / --label 时只写点名的 key。
      installWindowsAutostart(nodePath, cliPath, all ? undefined : keys, "pm2");
    } else if (!isPersistenceConfigured()) {
      print("\n要让 PM2 在重启后自动恢复，请执行一次（只需一次）：");
      print("  pm2 startup\n  pm2 save");
      markPersistenceConfigured();
    }
    if (failed) process.exitCode = 1;
    return;
  }

  // 3) 没有 PM2：用系统原生触发器
  print("未检测到 PM2，使用系统原生自启方案。\n");

  if (process.platform === "win32") {
    // 装全部时用 --all（以后 login 的新账号也自动覆盖）；明确点名的账号只写这些 key。
    installWindowsAutostart(nodePath, cliPath, all ? undefined : keys); // 一次安装，覆盖所选账号（触发时执行 start …）
    return;
  }

  if (process.platform === "linux") {
    // 默认全部账号时先清掉旧单元，避免已删除账号的 service 在下次登录继续被拉起；只装指定账号时不动其它账号。
    if (all) cleanupSystemTriggers();
    for (const key of keys) installSystemdUnit(key, nodePath, cliPath);
    return;
  }

  if (process.platform === "darwin") {
    if (all) cleanupSystemTriggers();
    for (const key of keys) installLaunchAgent(key, nodePath, cliPath);
    return;
  }

  throw new Error(`当前平台（${process.platform}）暂不支持自动安装自启。`);
}

function uninstall(): void {
  const pm2 = detectPM2();
  if (pm2.available) cleanupPM2Instances();

  if (process.platform === "win32") {
    uninstallWindowsAutostart();
    print("已移除 Windows 自启（计划任务 / 注册表 Run 键）。");
    return;
  }

  cleanupSystemTriggers();
}

async function status(): Promise<void> {
  const s = await detectMixedConfig();
  const pm2 = detectPM2();

  print(`平台：${process.platform}`);
  print(`PM2：${pm2.available ? `已安装（${pm2.version}），自启方式为 PM2` : "未安装"}`);

  switch (s) {
    case "none":
      print("自启：未安装");
      print("\n运行 wemind autostart install 安装。");
      break;
    case "native-only":
      print("自启：系统触发器已安装（计划任务 / systemd / LaunchAgent）");
      break;
    case "pm2-only":
      if (!pm2.available) {
        print("自启：检测到 PM2 触发器，但 PM2 未安装（配置已失效）。");
        print(
          "\n重新运行 wemind autostart install（改用原生触发器），或 autostart uninstall 清理。",
        );
        break;
      }
      print("自启：PM2 已托管（pm2 list 查看 wemind-* 实例）");
      if (process.platform === "win32") {
        const trig = getSystemTriggerInfo();
        if (trig.pm2) {
          print("Windows：登录任务 wemind-autostart-pm2 会执行 start --all --runner pm2。");
        } else {
          print("提醒：未检测到登录任务 wemind-autostart-pm2，重启后 PM2 实例不会自动恢复。");
          print("\n运行 wemind autostart install 安装登录任务。");
        }
      } else if (!isPersistenceConfigured()) {
        print("提醒：还没记录 pm2 startup / pm2 save，重启后可能不会自动恢复。");
      }
      break;
    case "mixed":
      print("自启：检测到双重配置（系统触发器 + PM2），互相冲突！");
      print("\n运行 wemind autostart install，按提示选择保留其中一种。");
      break;
  }
}

/** 当前正在执行的 cli.js 绝对路径：发布版是全局 bin，源码版是仓库 dist/cli.js。 */
function currentCliPath(): string {
  const argv1 = process.argv[1];
  if (!argv1)
    throw new Error("无法确定 cli.js 路径（process.argv[1] 为空），请在命令行中运行本命令。");
  return path.resolve(argv1);
}
