// 进程身份校验：pid 会复用（尤其**重启后**），只凭「pid 还活着」（process.kill(pid, 0)）就杀进程、
// 或判定「daemon 在跑」，可能**误杀别人的进程**（陈旧 pid 文件 + pid 被复用）或**误判**
// （自启看似成功、其实压根没起来）。这里改用「命令行里有没有我们自己的特征串」来确认身份。
//
// 原则：查不到命令行 → 一律判否（保守，宁可不杀）。
// 成本：只有 Windows 需要经 PowerShell 查 CIM（约 1~2s），所以调用方**先 isAlive() 过滤**——
// 正常路径（陈旧 pid 早就不存在了）零开销，只有「确实有活着的 pid」时才付这笔查询成本。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
 * 取文件名。**不依赖平台**：`/` 与 `\` 都当分隔符——
 * POSIX 的 `path.basename` 不认 `\`，会把 Windows 风格路径整条留下（CI 上踩过）。
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

function parsePipePairs(stdout: string, out: Map<number, string>): void {
  for (const raw of stdout.split(/\r?\n/)) {
    const i = raw.indexOf("|");
    if (i <= 0) continue;
    const pid = Number.parseInt(raw.slice(0, i).trim(), 10);
    if (Number.isInteger(pid) && pid > 0) out.set(pid, raw.slice(i + 1));
  }
}

/**
 * 批量查询 pid → 命令行。查不到（不存在 / 无权限 / 平台不支持）的 pid 不会出现在结果里。
 * 只查询「活着的」pid（调用方传一堆陈旧 pid 也不会白白起进程）。
 */
export function commandLines(pids: Array<number | null | undefined>): Map<number, string> {
  const out = new Map<number, string>();
  const list = [...new Set(pids.filter((p): p is number => isAlive(p)))];
  if (!list.length) return out;
  try {
    if (process.platform === "win32") {
      // wmic 已被新版 Windows 移除 → 用系统自带的 Windows PowerShell 5.1 + CIM；一次查询多个 pid。
      const ps = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const filter = list.map((p) => `ProcessId=${p}`).join(" or ");
      const script = `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`;
      const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
      });
      parsePipePairs(r.stdout ?? "", out);
    } else if (process.platform === "linux") {
      for (const p of list) {
        try {
          out.set(p, fs.readFileSync(`/proc/${p}/cmdline`, "utf-8").replaceAll("\0", " ").trim());
        } catch {
          /* 读不到就当查不到 */
        }
      }
    } else {
      // darwin 等：用 ps
      for (const p of list) {
        const r = spawnSync("ps", ["-o", "command=", "-p", String(p)], {
          encoding: "utf8",
          timeout: 5000,
        });
        const line = (r.stdout ?? "").trim();
        if (line) out.set(p, line);
      }
    }
  } catch {
    /* 查询失败 → 返回空（判否，保守） */
  }
  return out;
}

/** 该 pid 是否「活着**且确实是我们自己的**进程」（命令行命中 markerSets 之一）。 */
export function isOurProcess(pid: number | null | undefined, markerSets: string[][]): boolean {
  if (!isAlive(pid)) return false;
  return matchesMarkers(commandLines([pid]).get(pid as number), markerSets);
}

/**
 * 我们自己的 CLI / wrapper 进程特征。命令行为
 * `<node> …/wechat-daemon/dist/cli.js <子命令>`（相对、绝对、全局安装路径都含
 * `wechat-daemon` + `cli.js`），或 PowerShell wrapper（`run-daemon.ps1` 写 wrapper.pid）。
 */
export const CLI_PID_MARKERS: string[][] = [["wechat-daemon", "cli.js"], ["run-daemon.ps1"]];

/**
 * 大脑进程特征：`<bin> <args…>`（如 `opencode acp`、`kiro-cli acp`）。
 * 取 bin 的**文件名**并去掉扩展名，兼顾 shell=true（命令行是原始命令）与 `--bin` 绝对路径两种情况；
 * args 是关键区分位——用户自己的 `opencode serve`（本机 OpenCode 服务）不含 `acp`，不会被误判。
 * bin 为空（配置异常）时返回空数组 → matchesMarkers 恒判否，绝不误杀。
 */
export function brainPidMarkers(bin: string, args: string[]): string[][] {
  const name = baseName(bin ?? "").replace(/\.(exe|cmd|bat|ps1)$/i, "");
  if (!name) return []; // bin 为空 / 只剩目录（配置异常）→ 恒判否，绝不误杀
  return [[name, ...args].filter((t) => t !== "")];
}
