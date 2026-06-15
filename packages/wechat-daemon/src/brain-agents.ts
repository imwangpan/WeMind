import path from "node:path";
import fs from "node:fs";

/**
 * ACP agent 预设与解析。
 *
 * WeMind 的大脑通过**标准 ACP（Agent Client Protocol，JSON-RPC over stdio）**驱动一个
 * agent CLI。ACP 是通用协议（kiro-cli、gemini-cli 等都支持），因此接入任意兼容 ACP 的
 * agent 不需要改协议代码——只需告诉我们三件事：① 二进制名；② 进入 ACP 模式的启动参数；
 * ③ 该 agent 读取「配置/数据目录」的环境变量名（我们把它指向 brain 沙箱）。
 *
 * 选择与覆盖（均为环境变量，零代码接入）：
 *  - `WEMIND_BRAIN`         选预设（默认 `kiro`）
 *  - `WEMIND_BRAIN_BIN`     覆盖二进制（绝对路径或 PATH 上的名字）
 *  - `WEMIND_BRAIN_ARGS`    覆盖启动参数（空格分隔）
 *  - `WEMIND_BRAIN_HOME_ENV`覆盖「配置目录环境变量名」
 *  - `KIRO_CLI_BIN`         旧的 kiro 专用覆盖（仅 kiro 预设、且未设 WEMIND_BRAIN_BIN 时仍生效）
 */

export type AcpAgentPreset = {
  name: string;
  bin: string;          // PATH 上的二进制名（非 Windows）
  binWin?: string;      // Windows 下可执行名（默认在 bin 后加 .exe）
  args: string[];       // 进入 ACP 模式的启动参数
  homeEnvVar?: string;  // agent 读取其配置/数据目录的环境变量名；指向 brain 沙箱。留空=不设置
};

/** 已知 ACP agent 预设。`kiro` 为默认且已实测；其余为可扩展示例（参数以各自官方为准，未实测）。 */
export const ACP_AGENT_PRESETS: Record<string, AcpAgentPreset> = {
  kiro: { name: "kiro", bin: "kiro-cli", binWin: "kiro-cli.exe", args: ["acp", "--trust-all-tools"], homeEnvVar: "KIRO_HOME" },
  // 示例（未实测，参数请对照官方文档）：Gemini CLI 的实验性 ACP 模式
  gemini: { name: "gemini", bin: "gemini", binWin: "gemini.cmd", args: ["--experimental-acp"], homeEnvVar: "GEMINI_CLI_HOME" },
};

function onPath(exe: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  return null;
}

export type ResolvedAgent = { name: string; bin: string; args: string[]; homeEnvVar?: string };

/** 解析当前要用的 ACP agent（预设 + 环境变量覆盖）。 */
export function resolveAgent(): ResolvedAgent {
  const key = (process.env.WEMIND_BRAIN?.trim() || "kiro").toLowerCase();
  const preset = ACP_AGENT_PRESETS[key] ?? ACP_AGENT_PRESETS.kiro;

  const exe = process.platform === "win32" ? (preset.binWin ?? `${preset.bin}.exe`) : preset.bin;
  const bin = process.env.WEMIND_BRAIN_BIN?.trim()
    || (preset.name === "kiro" ? process.env.KIRO_CLI_BIN?.trim() : undefined)
    || onPath(exe)
    || preset.bin;

  const argsOverride = process.env.WEMIND_BRAIN_ARGS?.trim();
  const args = argsOverride ? argsOverride.split(/\s+/) : preset.args;

  const homeEnvVar = process.env.WEMIND_BRAIN_HOME_ENV?.trim() || preset.homeEnvVar;

  return { name: preset.name, bin, args, homeEnvVar };
}
