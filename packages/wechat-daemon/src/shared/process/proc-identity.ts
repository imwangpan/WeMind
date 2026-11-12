// 进程身份校验：pid 会复用（尤其**重启后**），只凭「pid 还活着」（process.kill(pid, 0)）就杀进程、或判定「daemon 在跑」，可能**误杀别人的进程**（陈旧 pid 文件 + pid 被复用）或**误判**（自启看似成功、其实压根没起来）。这里改用「命令行里有没有我们自己的特征串」来确认身份。
//
// 判定分三态：ours（命令行命中）/ other（活着但不是我们）/ unknown（活着但查不到命令行，查询失败或权限不足）。
// 原则：unknown 只用于「不能确定」的场景——start/watchdog fail-closed（防双开抢 token），stop 不杀，list 显示「无法确认」；只有确认 other 才放行。
// 成本：只有 Windows 需要经 PowerShell 查 CIM（约 1~2s），所以调用方**先 isAlive() 过滤**——正常路径（陈旧 pid 早就不存在了）零开销，只有「确实有活着的 pid」时才付这笔查询成本。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { resolvePowerShell } from "./powershell.js";

/** pid 是否活着（零成本，仅探活；不代表是我们的进程）。 */
export function isAlive(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 归一化：小写 + 反斜杠统一成正斜杠，便于跨平台、跨相对/绝对路径匹配。 */
function normalize(s: string): string {
  return s.replaceAll("\\", "/").toLowerCase();
}

/**
 * 取文件名。**不依赖平台**：`/` 与 `\` 都当分隔符——POSIX 的 `path.basename` 不认 `\`，会把 Windows 风格路径整条留下（CI 上踩过）。
 */
function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 某条命令行是否命中「任一 marker 组合」（组合内每个 token 都必须出现、大小写与斜杠不敏感）。 */
export function matchesMarkers(line: string | null | undefined, markerSets: string[][]): boolean {
  if (!line) return false;
  const hay = normalize(line);
  return markerSets.some((set) => set.length > 0 && set.every((t) => hay.includes(normalize(t))));
}

/** Windows 查询输出的记录前缀；带前缀是为了忽略 PowerShell 偶发的警告/空行。 */
const PS_RECORD_PREFIX = "WEMIND|";

/**
 * 解析 `WEMIND|<pid>|<base64(UTF-8 commandline)>`。
 * 命令行走 base64 而不是直接输出：PowerShell 5.1 重定向 stdout 时按控制台代码页（中文 Windows 是 936）编码，Node 按 UTF-8 解码会乱码。
 * 导出仅供单测。
 */
export function parseCommandLineOutput(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw.startsWith(PS_RECORD_PREFIX)) continue;
    const rest = raw.slice(PS_RECORD_PREFIX.length);
    const i = rest.indexOf("|");
    if (i <= 0) continue;
    const pid = Number.parseInt(rest.slice(0, i).trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const b64 = rest.slice(i + 1).trim();
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) continue;
    out.set(pid, Buffer.from(b64, "base64").toString("utf8"));
  }
  return out;
}

/** 批量查询结果；error 为 null 表示查询本身成功（个别 pid 仍可能因无权限/已退出而缺失）。 */
export interface CommandLinesResult {
  lines: Map<number, string>;
  error: string | null;
}

/**
 * 批量查询 pid → 命令行。查不到（不存在 / 无权限 / 平台不支持）的 pid 不会出现在结果里，调用方用 identifyProcess 判三态。
 * 只查询「活着的」pid（调用方传一堆陈旧 pid 也不会白白起进程）。
 */
export function commandLines(pids: Array<number | null | undefined>): CommandLinesResult {
  const out = new Map<number, string>();
  const list = [...new Set(pids.filter((p): p is number => isAlive(p)))];
  if (!list.length) return { lines: out, error: null };
  try {
    if (process.platform === "win32") {
      // wmic 已被新版 Windows 移除 → 用系统自带 PowerShell + CIM；5.1 缺失时 resolvePowerShell 会回退 pwsh。
      const ps = resolvePowerShell();
      if (!ps.ok) return { lines: out, error: ps.error };
      const filter = list.map((p) => `ProcessId=${p}`).join(" or ");
      const script = `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "${PS_RECORD_PREFIX}$($_.ProcessId)|$([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine)))" }`;
      const r = spawnSync(ps.exe, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
      });
      if (r.error) return { lines: out, error: `PowerShell 查询失败：${r.error.message}` };
      const parsed = parseCommandLineOutput(r.stdout ?? "");
      for (const [pid, line] of parsed) out.set(pid, line);
      if (r.status !== 0) {
        const detail = (r.stderr ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
        return {
          lines: out,
          error: `PowerShell 查询失败（退出码 ${r.status ?? "超时"}${detail ? `：${detail}` : ""}）`,
        };
      }
      return { lines: out, error: null };
    }
    if (process.platform === "linux") {
      for (const p of list) {
        try {
          out.set(p, fs.readFileSync(`/proc/${p}/cmdline`, "utf-8").replaceAll("\0", " ").trim());
        } catch {
          /* 读不到 → 该 pid 不在结果里，由 identifyProcess 判 unknown */
        }
      }
      return { lines: out, error: null };
    }
    // darwin 等：用 ps
    let error: string | null = null;
    for (const p of list) {
      const r = spawnSync("ps", ["-o", "command=", "-p", String(p)], {
        encoding: "utf8",
        timeout: 5000,
      });
      if (r.error) {
        error = `ps 查询失败：${r.error.message}`;
        continue;
      }
      const line = (r.stdout ?? "").trim();
      if (line) out.set(p, line);
    }
    return { lines: out, error };
  } catch (e) {
    return { lines: out, error: `进程命令行查询失败：${(e as Error).message}` };
  }
}

export type ProcessIdentity = "ours" | "other" | "unknown";

/**
 * 三态身份判定：pid 不活 → other；查到命令行 → 按 markers 判 ours/other；活着但结果里没有 → unknown。
 * unknown 不能当成 other：那等于「查询失败就放行」，会让第二个 daemon 抢同一个 bot token。
 */
export function identifyProcess(
  pid: number | null | undefined,
  markerSets: string[][],
  query: CommandLinesResult,
): ProcessIdentity {
  if (pid === null || pid === undefined) return "other";
  // 查询结果里有的 pid，以当时的命令行为准（查询时它还活着；查询后退出也不影响「它是不是我们」）。
  const line = query.lines.get(pid);
  if (line !== undefined) return matchesMarkers(line, markerSets) ? "ours" : "other";
  // 查询成功但没这个 pid：可能刚好退出，也可能无权限/受保护进程；再探活一次区分「已退出」和「查不到」。
  return isAlive(pid) ? "unknown" : "other";
}

/** 该 pid 是否「活着**且确实是我们自己的**进程」；查询失败时判否（调用方要区分时用 identifyProcess）。 */
export function isOurProcess(pid: number | null | undefined, markerSets: string[][]): boolean {
  return identifyProcess(pid, markerSets, commandLines([pid])) === "ours";
}

/** 同账号单实例判定结果；unknown=true 时 pid 为 null，但**不能**据此认为没有别的实例。 */
export interface OtherProcessCheck {
  pid: number | null;
  unknown: boolean;
  error: string | null;
}

/**
 * 「同账号已有另一个我们自己的进程」判定：ours → 返回 pid；other → 没有；unknown → 无法确认。
 * 排除自己（同一个 pid 写进文件时不算冲突）；陈旧 pid / pid 复用由 identifyProcess 的身份校验挡掉。
 */
export function findOtherOurProcess(
  pid: number | null | undefined,
  selfPid: number,
  markerSets: string[][],
): OtherProcessCheck {
  if (pid === null || pid === undefined || pid === selfPid)
    return { pid: null, unknown: false, error: null };
  const query = commandLines([pid]);
  const identity = identifyProcess(pid, markerSets, query);
  if (identity === "ours") return { pid, unknown: false, error: query.error };
  return { pid: null, unknown: identity === "unknown", error: query.error };
}

/**
 * 我们自己的 CLI / wrapper 进程特征：命令行里同时含 `wemind` + `cli.js`。
 *
 * 这串必须同时覆盖**四种**安装方式（少一种 → 对应场景下 stop/list/单实例判断全失效）：
 *  - 源码仓库（绝对路径）：`<node> D:\repo\WeMind\packages\wechat-daemon\dist\cli.js daemon`（由 marker 组合里的 `wemind` 命中仓库名 WeMind；注意大小写不敏感比较在下面已处理）；
 *  - 源码仓库（**相对路径**）：`<node> packages/wechat-daemon/dist/cli.js daemon`（命令行里既没有仓库名也没有包名，只有源码目录名 → 靠第三组 marker `wechat-daemon` + `cli.js` 命中）。没有这一组时，「在仓库根目录手跑 CLI + daemon」会互相认不出（daemon 明明活着，CLI 却说没运行，控制桥也拒绝发送）；
 *  - 全局/本地安装：`<node> …/node_modules/@wemind/cli/dist/cli.js daemon`（npm 的 bin shim 最终 exec 的正是这个路径；Windows 上可能走 `…\@wemind\cli\dist\cli.js` 短路径。两种形态都命中 marker 里的 `wemind`——它同时是 scope 名与命令名）；
 *  - 源码开发期的 PowerShell wrapper：`pwsh -File …\scripts\run-daemon.ps1`。
 *
 * 注意**不能**用 `wechat-daemon` **替代** `wemind`：源码目录名在发布版里不存在（包目录叫 `@wemind/cli`），只有它会让「装出来的 wemind」永远匹配不上、list 永远显示「已停止」。它只作为**追加**的一组，补上「相对路径启动」这一种形态；并要求 `dist` 一起出现，把「别的项目里恰好有个叫 wechat-daemon 的目录」这类误判（这串最终用于**杀进程**，宁可漏也要少误）。
 */
export const CLI_PID_MARKERS: string[][] = [
  ["wemind", "cli.js"],
  ["wechat-daemon", "dist", "cli.js"],
  ["run-daemon.ps1"],
];

/**
 * 大脑进程特征：`<bin> <args…>`（如 `opencode acp`、`kiro-cli acp`）。
 * 取 bin 的**文件名**并去掉扩展名，兼顾 shell=true（命令行是原始命令）与 `--bin` 绝对路径两种情况；args 是关键区分位——用户自己的 `opencode serve`（本机 OpenCode 服务）不含 `acp`，不会被误判。
 * bin 为空（配置异常）时返回空数组 → matchesMarkers 恒判否，绝不误杀。
 */
export function brainPidMarkers(bin: string, args: string[]): string[][] {
  const name = baseName(bin ?? "").replace(/\.(exe|cmd|bat|ps1)$/i, "");
  if (!name) return []; // bin 为空 / 只剩目录（配置异常）→ 恒判否，绝不误杀
  return [[name, ...args].filter((t) => t !== "")];
}
