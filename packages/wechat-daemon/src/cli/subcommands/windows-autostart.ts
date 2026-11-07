import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { AUTOSTART_TASK_NAME, AUTOSTART_TASK_NAME_PM2 } from "../../shared/mixed-config.js";

/**
 * Windows 自启安装。
 *
 * 首选：登录触发的计划任务（`ExecutionTimeLimit=0`，否则默认 72 小时后被杀；`AtLogOn` 以**当前用户**运行，
 * 不需要管理员权限，也不落到 Session 0——daemon 需要用户级环境变量与用户目录）。
 * 退路：注册表 `HKCU\...\Run`（受管机器禁止建计划任务时用；代价是会出现在「任务管理器 → 启动」里）。
 *
 * 触发后执行的是 `wemind start --all`（内置 watchdog 保活）或 `wemind start --all --runner pm2`
 * （Windows 的 `pm2 startup` 不原生支持，靠这条命令让 pm2 重启实例），**不是** `autostart install`。
 * 两种用途用不同任务名区分（见 mixed-config.ts），状态探测不必解析任务内容。
 */

/** Windows PowerShell 5.1 的固定位置：不依赖 PATH，也不要求装 PowerShell 7。 */
function windowsPowerShell(): string {
  const root = process.env.SystemRoot || "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** PowerShell 单引号字符串转义。 */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** 自启触发时要执行的命令（供日志与注册表值复用）。keys 为空 = 全部账号。 */
export function windowsAutostartCommand(
  nodePath: string,
  cliPath: string,
  keys?: string[],
  runner?: string,
): string {
  return `"${nodePath}" ${windowsAutostartArgs(cliPath, keys, runner)}`;
}

/** 计划任务 `-Argument` 的纯函数形式（不含 node 路径）。 */
export function windowsAutostartArgs(cliPath: string, keys?: string[], runner?: string): string {
  const tail = keys?.length ? `start ${keys.join(" ")}` : "start --all";
  const pm2 = runner === "pm2" ? " --runner pm2" : "";
  return `"${cliPath}" ${tail}${pm2}`;
}

/** 安装 Windows 自启；返回实际采用的方式（便于测试与提示）。keys 为空 = 全部账号。 */
export function installWindowsAutostart(
  nodePath: string,
  cliPath: string,
  keys?: string[],
  runner?: string,
): "scheduled-task" | "run-key" {
  const name = runner === "pm2" ? AUTOSTART_TASK_NAME_PM2 : AUTOSTART_TASK_NAME;
  const command = windowsAutostartCommand(nodePath, cliPath, keys, runner);

  // 先清掉两套旧触发器（同名任务 / Run 键、另一种用途的任务）：
  // 否则上一次降级留下的 Run 键会和这次新建的计划任务同时存在，登录时启动两次。
  uninstallWindowsAutostart();

  try {
    registerScheduledTask(nodePath, cliPath, name, keys, runner);
    if (taskExists(name)) {
      console.log(`已创建 Windows 计划任务 ${name}（登录时自动启动）`);
      return "scheduled-task";
    }
    throw new Error("任务注册后未查询到");
  } catch (err) {
    console.warn(`计划任务创建失败（${(err as Error).message}），改用注册表 Run 键…`);
    // 注册可能已经部分成功（只是查询失败）；再清一次，确保最终只剩 Run 键这一种触发器。
    uninstallWindowsAutostart();
    installRunKey(name, command);
    console.log(`已写入注册表 Run 键 ${name}（登录时自动启动）`);
    return "run-key";
  }
}

function registerScheduledTask(
  nodePath: string,
  cliPath: string,
  name: string,
  keys?: string[],
  runner?: string,
): void {
  const argument = windowsAutostartArgs(cliPath, keys, runner);
  const script = [
    `$action = New-ScheduledTaskAction -Execute ${psQuote(nodePath)} -Argument ${psQuote(argument)}`,
    "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable",
    // 触发条件绑定当前用户：不写 -User 时，任何用户登录都会触发（多用户机器上会多跑一次）。
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)",
    `Register-ScheduledTask -TaskName ${psQuote(name)} -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
  ].join("; ");

  execFileSync(
    windowsPowerShell(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      stdio: "pipe",
      windowsHide: true,
      timeout: 30_000,
    },
  );
}

function taskExists(name: string): boolean {
  try {
    execFileSync("schtasks", ["/Query", "/TN", name], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

function installRunKey(name: string, command: string): void {
  execFileSync(
    "reg",
    [
      "add",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/v",
      name,
      "/t",
      "REG_SZ",
      "/d",
      command,
      "/f",
    ],
    { stdio: "pipe", windowsHide: true, timeout: 10_000 },
  );
}

/** 卸载 Windows 自启：两种用途的任务与 Run 键都清。 */
export function uninstallWindowsAutostart(): void {
  for (const name of [AUTOSTART_TASK_NAME, AUTOSTART_TASK_NAME_PM2]) {
    try {
      execFileSync("schtasks", ["/Delete", "/TN", name, "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 10_000,
      });
    } catch {
      /* 不存在 */
    }
    try {
      execFileSync(
        "reg",
        ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", name, "/F"],
        { stdio: "ignore", windowsHide: true, timeout: 10_000 },
      );
    } catch {
      /* 不存在 */
    }
  }
}
