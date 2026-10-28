import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

/**
 * 账号级「大脑」持久配置（brain.json）。
 *
 * 背景：此前「用哪个大脑」只存在于进程环境变量 `WEMIND_BRAIN`（见 brain-agents.ts），是个**临时态**——换个入口重启（登录自启、pm2、看门狗、`cli.js start`、另一个 shell）就丢，静默退回默认预设；而默认预设（kiro）的二进制不一定装了 → 直到第一条消息才报错（历史上表现为「⏳ 响应中断了，正在自动重试…」）。
 *
 * 这里把选择**按账号落盘**，成为单一事实来源：
 *   - 任何入口重启都能复现（不依赖启动者的 shell）；
 *   - 切换是一等命令（`wemind brain set <预设>`），而不是「改环境变量 + 记得重开终端」；
 *   - 环境变量 `WEMIND_BRAIN*` 仍为**一次性覆盖**（优先级更高），临时试别的 agent 不受影响。
 *
 * 文件形如 `~/.wemind/<账号>/brain.json`：
 * ```json
 * { "agent": "opencode", "worker": { "agent": "kiro" },
 *   "presets": { "deepseek": { "bin": "C:\\…\\dsh.cmd" } } }
 * ```
 *
 * - 顶层 `agent`（可带 `bin`/`args`/`shell`/`homeEnvVar` 启动覆盖）＝**对话大脑**，历史语义不变；
 * - `worker` ＝任务 worker 的独立选择（**缺省＝跟随对话大脑**，与拆分角色之前完全一致）；
 * - `presets` ＝**按预设名存**的启动覆盖：`wemind brain set X --bin …` 写在这里，于是「切到 opencode 再切回 deepseek」不会丢掉 deepseek 的绝对路径（DSH 桌面端必须显式给 `dsh.cmd`）。
 *   顶层那些字段仍会同步写一份（兼容旧版本 CLI 读取），切换 agent 时旧 agent 的覆盖会被迁移进 `presets[旧agent]`。
 */

export type AgentRole = "brain" | "worker";

/** 一个角色的 agent 选择与其启动覆盖。 */
export type AgentConfig = {
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

/** 按预设名保存的启动覆盖。 */
export type PresetOverride = Omit<AgentConfig, "agent">;

export type BrainConfig = AgentConfig & {
  /** 任务 worker 的独立选择；缺省＝跟随对话大脑。 */
  worker?: AgentConfig;
  /** 预设名 → 启动覆盖。 */
  presets?: Record<string, PresetOverride>;
};

/** brain.json 的完整路径（默认当前账号数据目录）。 */
export function brainConfigPath(dir: string = DATA_DIR): string {
  return path.join(dir, "brain.json");
}

/** 宽松归一化「一块 agent 字段」（顶层与 worker 段共用）；无有效 agent 返回 null。 */
function normAgentFields(j: any): AgentConfig | null {
  const agent = typeof j?.agent === "string" ? j.agent.trim() : "";
  if (!agent) return null;
  const cfg: AgentConfig = { agent };
  if (typeof j.bin === "string" && j.bin.trim()) cfg.bin = j.bin.trim();
  if (Array.isArray(j.args))
    cfg.args = j.args.filter((x: unknown): x is string => typeof x === "string");
  else if (typeof j.args === "string" && j.args.trim()) cfg.args = j.args.trim().split(/\s+/);
  if (typeof j.shell === "boolean") cfg.shell = j.shell;
  if (typeof j.homeEnvVar === "string" && j.homeEnvVar.trim()) cfg.homeEnvVar = j.homeEnvVar.trim();
  return cfg;
}

/** 宽松归一化一条预设覆盖；全空返回 null。 */
function normPresetOverride(j: any): PresetOverride | null {
  const ov: PresetOverride = {};
  if (typeof j?.bin === "string" && j.bin.trim()) ov.bin = j.bin.trim();
  if (Array.isArray(j?.args))
    ov.args = j.args.filter((x: unknown): x is string => typeof x === "string");
  else if (typeof j?.args === "string" && j.args.trim()) ov.args = j.args.trim().split(/\s+/);
  if (typeof j?.shell === "boolean") ov.shell = j.shell;
  if (typeof j?.homeEnvVar === "string" && j.homeEnvVar.trim()) ov.homeEnvVar = j.homeEnvVar.trim();
  return Object.keys(ov).length ? ov : null;
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
  const base = normAgentFields(j);
  if (!base) return null;
  const cfg: BrainConfig = { ...base };
  const worker = normAgentFields(j.worker);
  if (worker) cfg.worker = worker;
  if (j.presets && typeof j.presets === "object" && !Array.isArray(j.presets)) {
    const presets: Record<string, PresetOverride> = {};
    for (const [k, v] of Object.entries(j.presets as Record<string, unknown>)) {
      const ov = normPresetOverride(v);
      if (ov) presets[k.trim().toLowerCase()] = ov;
    }
    if (Object.keys(presets).length) cfg.presets = presets;
  }
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

/**
 * 取某角色对应的配置块：worker 未单独设置时**回落到顶层**（拆分角色之前的行为完全不变），
 * 顶层为空则返回 null（交给 resolveAgent 走 auto/默认）。
 */
export function agentConfigFor(cfg: BrainConfig | null, role: AgentRole): BrainConfig | null {
  if (!cfg) return null;
  if (role === "brain") return cfg;
  if (!cfg.worker?.agent) return cfg; // 没有独立 worker 段：worker 沿用顶层整段（含 presets）
  // presets 是**账号级**的「按预设名存的启动覆盖」，与「用哪一段选 agent」无关，必须跟着走：
  // 否则 worker 段的存在会让 presets 查不到，`--bin` 之类的覆盖对 worker 静默失效。
  return cfg.presets ? { ...cfg.worker, presets: cfg.presets } : cfg.worker;
}

/**
 * 合并一次「设配置」（`wemind brain set` / 切换命令落盘）：
 *  - patch 的顶层字段整体替换顶层；
 *  - 保留 existing 的 worker 段（除非 patch 自带）——旧实现整体覆盖写会把 worker 段删掉；
 *  - agent 变了 → 把 existing 顶层还带着的启动覆盖（它们属于**旧** agent）迁进 `presets[旧agent]`，
 *    避免「切到 opencode 再切回 deepseek」丢掉 deepseek 的 `--bin`；agent 没变则沿用未给定的覆盖；
 *  - patch 自带的启动覆盖同时写进 `presets[新agent]`（并被顶层同步一份，兼容旧版本 CLI）。
 */
export function mergeBrainConfig(existing: BrainConfig | null, patch: BrainConfig): BrainConfig {
  const prev = existing?.agent?.trim().toLowerCase() ?? "";
  const nextAgent = patch.agent.trim().toLowerCase();
  const presets: Record<string, PresetOverride> = { ...existing?.presets };

  if (prev && prev !== nextAgent) {
    const legacy: PresetOverride = {};
    if (existing?.bin) legacy.bin = existing.bin;
    if (existing?.args?.length) legacy.args = existing.args;
    if (existing?.shell !== undefined) legacy.shell = existing.shell;
    if (existing?.homeEnvVar) legacy.homeEnvVar = existing.homeEnvVar;
    if (Object.keys(legacy).length) presets[prev] = { ...presets[prev], ...legacy };
  }

  const next: BrainConfig = { agent: patch.agent };
  if (patch.bin) next.bin = patch.bin;
  if (patch.args) next.args = patch.args;
  if (patch.shell !== undefined) next.shell = patch.shell;
  if (patch.homeEnvVar) next.homeEnvVar = patch.homeEnvVar;
  // 同一个 agent 再设一次（如只改了 args）：没给的启动覆盖沿用原值——它们本来就属于这个 agent，
  // 丢掉会让「切走再切回」丢 --bin 的坑在原地重现。
  if (prev && prev === nextAgent) {
    if (!patch.bin && existing?.bin) next.bin = existing.bin;
    if (!patch.args && existing?.args?.length) next.args = existing.args;
    if (patch.shell === undefined && existing?.shell !== undefined) next.shell = existing.shell;
    if (!patch.homeEnvVar && existing?.homeEnvVar) next.homeEnvVar = existing.homeEnvVar;
  }

  if (next.bin || next.args?.length || next.shell !== undefined || next.homeEnvVar) {
    const ov: PresetOverride = { ...presets[nextAgent] };
    if (next.bin) ov.bin = next.bin;
    if (next.args?.length) ov.args = next.args;
    if (next.shell !== undefined) ov.shell = next.shell;
    if (next.homeEnvVar) ov.homeEnvVar = next.homeEnvVar;
    presets[nextAgent] = ov;
  }
  if (Object.keys(presets).length) next.presets = presets;

  const worker = patch.worker ?? existing?.worker;
  if (worker?.agent) next.worker = worker;
  return next;
}

/** 读-改-写一步到位（manage.ts 用）：返回落盘后的配置。 */
export function updateBrainConfig(patch: BrainConfig, dir: string = DATA_DIR): BrainConfig {
  const next = mergeBrainConfig(loadBrainConfig(dir), patch);
  saveBrainConfig(next, dir);
  return next;
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
