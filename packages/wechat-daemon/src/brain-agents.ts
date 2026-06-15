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
  shell?: boolean;      // 是否经 shell 启动（npx/.cmd/.bat 类适配器在 Windows 需要 true）
};

/**
 * 已知 ACP agent 预设。
 * - `kiro` 为默认且**已实测**。
 * - 其余均为**示例（未实测）**：参数/包名以各自官方为准，接入前请核对（见 docs/接入其它-ACP-Agent.md）。
 * - 区别两类：① **原生 ACP**（CLI 自带 ACP 模式，直接起，如 kiro、gemini）；
 *   ② **需适配器**（CLI 本身不说 ACP，要起一个适配器进程，如 Claude Code、Codex）。
 */
export const ACP_AGENT_PRESETS: Record<string, AcpAgentPreset> = {
  // —— 原生 ACP ——
  kiro: { name: "kiro", bin: "kiro-cli", binWin: "kiro-cli.exe", args: ["acp", "--trust-all-tools"], homeEnvVar: "KIRO_HOME" },
  // Gemini CLI 实验性 ACP（未实测，flag 以官方为准）
  gemini: { name: "gemini", bin: "gemini", binWin: "gemini.cmd", args: ["--experimental-acp"], homeEnvVar: "GEMINI_CLI_HOME", shell: true },

  // —— 需适配器（CLI 不原生支持 ACP，经第三方适配器桥接；未实测）——
  // Claude Code：Zed 官方适配器 @zed-industries/claude-code-acp（npx 运行；需 Claude Code 登录/ANTHROPIC_API_KEY）
  "claude-code": { name: "claude-code", bin: "npx", binWin: "npx.cmd", args: ["-y", "@zed-industries/claude-code-acp"], shell: true },
  // Codex：社区适配器 codex-acp（agentclientprotocol/codex-acp，需自行安装其二进制；Codex 本身暂不原生支持 ACP）
  codex: { name: "codex", bin: "codex-acp", binWin: "codex-acp.exe", args: [] },
};

function onPath(exe: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  return null;
}

export type ResolvedAgent = { name: string; bin: string; args: string[]; homeEnvVar?: string; shell: boolean };

/** 解析当前要用的 ACP agent（预设 + 环境变量覆盖）。 */
export function resolveAgent(): ResolvedAgent {
  const key = (process.env.WEMIND_BRAIN?.trim() || "kiro").toLowerCase();
  const preset = ACP_AGENT_PRESETS[key] ?? ACP_AGENT_PRESETS.kiro;

  const shellEnv = process.env.WEMIND_BRAIN_SHELL?.trim();
  const shell = shellEnv !== undefined && shellEnv !== ""
    ? (shellEnv === "1" || shellEnv.toLowerCase() === "true")
    : (preset.shell ?? false);

  const exe = process.platform === "win32" ? (preset.binWin ?? `${preset.bin}.exe`) : preset.bin;
  // 经 shell 启动时用裸名（让 shell 从 PATH 解析，避免带空格的全路径在 shell 下出问题）；否则在 PATH 上找全路径
  const bin = process.env.WEMIND_BRAIN_BIN?.trim()
    || (preset.name === "kiro" ? process.env.KIRO_CLI_BIN?.trim() : undefined)
    || (shell ? (process.platform === "win32" ? exe : preset.bin) : (onPath(exe) || preset.bin));

  const argsOverride = process.env.WEMIND_BRAIN_ARGS?.trim();
  const args = argsOverride ? argsOverride.split(/\s+/) : preset.args;

  const homeEnvVar = process.env.WEMIND_BRAIN_HOME_ENV?.trim() || preset.homeEnvVar;

  return { name: preset.name, bin, args, homeEnvVar, shell };
}
