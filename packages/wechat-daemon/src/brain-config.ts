import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

/**
 * 账号级「大脑」持久配置（brain.json）。
 *
 * 背景：此前「用哪个大脑」只存在于进程环境变量 `WEMIND_BRAIN`（见 brain-agents.ts），
 * 是个**临时态**——换个入口重启（登录自启、pm2、看门狗、`cli.js start`、另一个 shell）就丢，
 * 静默退回默认预设；而默认预设（kiro）的二进制不一定装了 → 直到第一条消息才报错
 * （历史上表现为「⏳ 响应中断了，正在自动重试…」）。
 *
 * 这里把选择**按账号落盘**，成为单一事实来源：
 *   - 任何入口重启都能复现（不依赖启动者的 shell）；
 *   - 切换是一等命令（`wemind brain set <预设>`），而不是「改环境变量 + 记得重开终端」；
 *   - 环境变量 `WEMIND_BRAIN*` 仍为**一次性覆盖**（优先级更高），临时试别的 agent 不受影响。
 *
 * 文件形如 `~/.wemind/<账号>/brain.json`：
 * ```json
 * { "agent": "opencode" }
 * ```
 * 可选 `bin` / `args` / `shell` / `homeEnvVar`，用于覆盖预设的启动细节。
 */

export type BrainConfig = {
  /** 预设名（见 brain-agents.ts 的 ACP_AGENT_PRESETS），或 `auto`（自动探测）。 */
  agent: string;
  /** 覆盖二进制（绝对路径或 PATH 上的名字）。 */
  bin?: string;
  /** 覆盖 ACP 启动参数。 */
  args?: string[];
  /** 覆盖是否经 shell 启动。 */
  shell?: boolean;
  /** 覆盖「配置目录环境变量名」（指向沙箱）。 */
  homeEnvVar?: string;
};

/** brain.json 的完整路径（默认当前账号数据目录）。 */
export function brainConfigPath(dir: string = DATA_DIR): string {
  return path.join(dir, "brain.json");
}

/**
 * 读取账号的大脑配置；缺失/损坏/无有效 agent 一律返回 null（幂等、不抛）。
 * 字段做了宽松归一化：args 允许字符串（空格分隔）或数组；未知字段忽略。
 */
export function loadBrainConfig(dir: string = DATA_DIR): BrainConfig | null {
  let j: any;
  try {
    j = JSON.parse(fs.readFileSync(brainConfigPath(dir), "utf-8"));
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const agent = typeof j.agent === "string" ? j.agent.trim() : "";
  if (!agent) return null;
  const cfg: BrainConfig = { agent };
  if (typeof j.bin === "string" && j.bin.trim()) cfg.bin = j.bin.trim();
  if (Array.isArray(j.args))
    cfg.args = j.args.filter((x: unknown): x is string => typeof x === "string");
  else if (typeof j.args === "string" && j.args.trim()) cfg.args = j.args.trim().split(/\s+/);
  if (typeof j.shell === "boolean") cfg.shell = j.shell;
  if (typeof j.homeEnvVar === "string" && j.homeEnvVar.trim()) cfg.homeEnvVar = j.homeEnvVar.trim();
  return cfg;
}

/** 原子写入账号的大脑配置（临时文件 + rename，避免读到半截）。 */
export function saveBrainConfig(cfg: BrainConfig, dir: string = DATA_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  const fp = brainConfigPath(dir);
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, fp);
}

/** 清除账号的大脑配置（回到自动探测/默认）；返回是否确有文件被删。 */
export function clearBrainConfig(dir: string = DATA_DIR): boolean {
  try {
    fs.unlinkSync(brainConfigPath(dir));
    return true;
  } catch {
    return false;
  }
}
