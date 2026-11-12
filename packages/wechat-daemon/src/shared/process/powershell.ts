// PowerShell 解析：优先系统自带的 Windows PowerShell 5.1（固定位置，不依赖 PATH），缺失时回退 PATH 上的 pwsh。
// 自启与进程身份查询共用这一份判断：两处各拼一份路径，会在精简镜像 / 只有 PowerShell 7 的机器上跑偏。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type PowerShellSource = "windows-powershell" | "pwsh" | "none";

export interface PowerShellResolution {
  ok: boolean;
  /** 可执行文件路径（source=pwsh 时为裸命令名，交给 PATH 解析）。 */
  exe: string;
  source: PowerShellSource;
  /** ok=false 时的可读原因。 */
  error: string;
}

/** spawnSync 的最小接口：单测注入假实现，不必构造完整的 SpawnSyncReturns。 */
export type PowerShellSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: "ignore"; windowsHide: boolean; timeout: number },
) => { status: number | null; error?: Error };

export interface PowerShellDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existsSync?: (p: string) => boolean;
  spawnSync?: PowerShellSpawn;
}

function probe(deps: PowerShellDeps): PowerShellResolution {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32")
    return { ok: false, exe: "", source: "none", error: "PowerShell 查询只在 Windows 上使用" };
  const env = deps.env ?? process.env;
  const exists = deps.existsSync ?? fs.existsSync;
  const fixed = path.win32.join(
    env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (exists(fixed)) return { ok: true, exe: fixed, source: "windows-powershell", error: "" };
  // 5.1 缺失（Nano Server / 精简镜像）时再试 PowerShell 7：直接试跑一次，而不是只看 PATH 上有没有文件（坏安装 / 别名都可能存在却跑不起来）。
  const spawn: PowerShellSpawn =
    deps.spawnSync ?? ((cmd, args, opts) => spawnSync(cmd, args, opts));
  try {
    const r = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5000,
    });
    if (r.status === 0) return { ok: true, exe: "pwsh", source: "pwsh", error: "" };
    return {
      ok: false,
      exe: "",
      source: "none",
      error: `未找到 Windows PowerShell 5.1（${fixed}），PATH 上的 pwsh 也无法运行（${r.error?.message ?? `退出码 ${r.status ?? "超时"}`}）`,
    };
  } catch (e) {
    return {
      ok: false,
      exe: "",
      source: "none",
      error: `未找到 Windows PowerShell 5.1（${fixed}），PATH 上也没有可用的 pwsh：${(e as Error).message}`,
    };
  }
}

/** 解析用于执行 PowerShell 脚本的可执行文件；无法解析时 ok=false 且 error 说明原因。 */
export function resolvePowerShell(deps?: PowerShellDeps): PowerShellResolution {
  return probe(deps ?? {});
}
