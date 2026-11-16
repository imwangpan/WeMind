import path from "node:path";
import fs from "node:fs";

import { DATA_DIR } from "@wemind/wechat-ilink-core";
import { agentConfigFor, type AgentRole, type BrainConfig } from "./brain-config.js";
import {
  ACP_AGENT_PRESETS,
  AUTO_PROBE_ORDER,
  brokenAgentDefinitionMessage,
  findBrokenAgentDefinition,
  isAgentToken,
  presetForDefinition,
  type AcpAgentPreset,
} from "./agent-registry.js";
import { AGENT_DEFINITION_SCHEMA_VERSION, type AgentDefinition } from "./agent-definition.js";
import type { AgentAdapter } from "./agent-adapter.js";
import { readEnvSnapshot, mergeEnvSnapshot } from "./config/env-snapshot.js";
import { readHomeMode } from "./config/home-mode.js";

/**
 * ACP agent 与解析。
 *
 * WeMind 的大脑通过**标准 ACP（Agent Client Protocol，JSON-RPC over stdio）**驱动一个 agent CLI。ACP 是通用协议（kiro-cli、gemini-cli 等都支持），因此接入任意兼容 ACP 的 agent 不需要改协议代码——只需告诉我们三件事：① 二进制名；② 进入 ACP 模式的启动参数；③ 该 agent 读取「配置/数据目录」的环境变量名（只在 managed 下指向账号副本；direct 不设置）。
 *
 * 选择与覆盖（优先级从高到低）：
 *  ① 环境变量（一次性覆盖；临时试别的 agent 用它，别写进 profile）：
 *  - `WEMIND_BRAIN`            选「对话大脑」agent（默认 `auto`：自动探测已安装的 agent，见 AUTO_PROBE_ORDER）
 *  - `WEMIND_WORKER_BRAIN`     选「任务 worker」agent（未设则回落 `WEMIND_BRAIN`；与文件侧 `worker ?? 顶层` 的回退规则对称）
 *  - `WEMIND_BRAIN_BIN`        覆盖二进制（绝对路径或 PATH 上的名字）
 *  - `WEMIND_BRAIN_ARGS`       覆盖启动参数（空格分隔；**整段替换**）
 *  - `WEMIND_BRAIN_EXTRA_ARGS` 追加启动参数（空格分隔；保留预设在前面，适合只加一个开关）
 *  - `WEMIND_BRAIN_HOME_ENV`   覆盖「配置目录环境变量名」
 *  - `WEMIND_BRAIN_SHELL`      是否经 shell 启动（1/true）
 *  - `WEMIND_BRAIN_INHERIT`    是否继承真实配置目录的记忆/规则（默认 1；0 关闭）
 *  - `WEMIND_BRAIN_REAL_HOME`  覆盖被继承的真实配置目录（默认取该 agent 的 `realHome`）
 *  - `WEMIND_BRAIN_INHERIT_DIRS` 覆盖继承的子目录清单（逗号/空格分隔）
 *  - `WEMIND_ACP_SESSION_MODE` 覆盖预设的会话模式（`session/set_mode`）：`0`/`false`/`off` 关掉该调用，其它非空值 = 用该 modeId
 *  - `KIRO_CLI_BIN`            旧的 kiro 专用覆盖（仅 kiro agent、且未设 WEMIND_BRAIN_BIN 时仍生效）
 *  ② 账号级持久配置（`<数据目录>/brain.json`，见 brain-config.ts）：顶层 = 对话大脑，`worker` 段 = 任务 worker（缺省跟随顶层）；每段可带 `agent` / `bin` / `args` / `shell` / `homeEnvVar`，另有按 agent 名存启动覆盖的 `presets` 段。写入磁盘后任何入口重启都能复现，切换用 `wemind brain set <agent 名>`。
 *  ③ `auto`（未配置时的兜底）：按 AUTO_PROBE_ORDER 取第一个二进制可解析的 agent；Copilot 虽是原生 ACP，也因安装不代表已登录而要求显式选择。一个都没有则标记 unavailable，由启动校验明确报错（不再「静默跑起来、第一条消息才炸」）。
 *  另：未知的 `WEMIND_BRAIN` 值不再静默回退 kiro，而是 `known:false`，交由启动校验报错。
 *
 * 角色（role）：同一份 agent 表既是「对话大脑」也是「任务 worker」的来源；`resolveAgent()` = 对话大脑，
 * `resolveAgentFor(cfg, "worker")` = 任务 worker。命令驱动的切换用 `resolvePresetByName()` —— 它**绕开环境变量**，
 * 否则用户点了切换、env 却压着它，会出现「看着成功、实际没生效」。
 */

export { ACP_AGENT_PRESETS } from "./agent-registry.js";
export type { AcpAgentPreset } from "./agent-registry.js";

function onPath(exe: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  return null;
}

/** 同 onPath，但按平台补齐扩展名：适配器依赖的运行时（如 pi）在 Windows 上通常是 .cmd。 */
function onPathAny(exe: string): string | null {
  if (process.platform === "win32")
    return onPath(`${exe}.cmd`) ?? onPath(`${exe}.exe`) ?? onPath(exe);
  return onPath(exe);
}

/**
 * `auto` 的探测顺序：按序取第一个「二进制能在 PATH 上解析到」的 agent。只收纳**适合无配置自动选择的原生 ACP**；Copilot 虽原生支持 ACP，但认证独立于二进制安装，故与适配器一样只允许显式选择（`wemind brain set|switch <名>`）。适配器（`claude-code` / `codex` / `pi`）也不参与自动探测。顺序按本机实测的启动耗时排（暖启动：opencode ~1.7s、cline ~2.0s、qoder ~2.5s、gemini ~4.3s）；kiro 与 deepseek 在该轮实测中未握手成功（kiro `session/new` 超时、deepseek 旧会话 artifact 布局错误），暂排最后，修复后可再前移。
 */
export { AUTO_PROBE_ORDER };

/**
 * 该 agent 预设里「进入 ACP 模式」的标记 token：从默认 args 中挑出含 `acp` 的项。
 * 只用于整段替换 args 时的静态提醒；适配器（claude-code / codex）的 args 为空 → 返回空数组（不检查——适配器本体就是 ACP server，没有模式参数）。
 * 不能只查裸 `acp`：qoder 是 `--acp`、gemini 是 `--acp`、deepseek 是 `--profile acp`。
 */
export function acpModeTokens(name: string): string[] {
  const preset = ACP_AGENT_PRESETS[name];
  return preset ? preset.args.filter((a) => /acp/i.test(a)) : [];
}

/**
 * 整段替换 args 时的静态提醒（**只提醒、不拒绝**）：新 args 里找不到该 agent 的 ACP 模式标记时返回文案。
 * `binOverridden`（env / brain.json 指定了自定义 bin）时不检查——自定义入口/包装脚本可能自带 ACP 模式，静态判断不可靠。
 */
export function acpArgsWarning(
  name: string,
  args: string[],
  binOverridden: boolean,
): string | null {
  if (binOverridden) return null;
  const markers = acpModeTokens(name);
  if (!markers.length) return null;
  // 宽匹配：任何含 `acp` 的 token 都算（`--experimental-acp` 是 gemini 旧版仍在用的等价开关，不能被判成漏参数）
  if (args.some((a) => /acp/i.test(a))) return null;
  return `args 里没有 ${name} 的 ACP 模式参数（预设是 ${markers.map((m) => `\`${m}\``).join(" / ")}）——进程可能起得来但不会说 ACP，首条消息会握手超时。请把它一起写回去，或改用 --extra-args 只追加。`;
}

/** 运行时诊断：握手失败 / 进程在握手前退出时追加的提示；args 看起来正常、或 bin 是自定义入口时返回空串。 */
export function acpArgsHint(ag: ResolvedAgent): string {
  if (ag.binOverridden) return ""; // 自定义入口/包装脚本可能自带 ACP 模式，静态判断不可靠
  const markers = acpModeTokens(ag.name);
  if (!markers.length || ag.args.some((a) => /acp/i.test(a))) return "";
  return `（当前 args=[${ag.args.join(" ")}] 里没有 ${markers.map((m) => `\`${m}\``).join(" / ")}——若覆盖过 --args，确认没漏 ACP 模式参数；也可改用 --extra-args 只追加）`;
}

/** agent 在该平台的「可执行文件名」（用于 PATH 探测）。 */
function presetExe(preset: Pick<AcpAgentPreset, "bin" | "binWin">): string {
  if (process.platform !== "win32") return preset.bin;
  if (preset.binWin) return preset.binWin;
  // 已带扩展名的裸名/绝对路径不要再拼一次 .exe（本机定义的 bin 允许直接写路径）。
  return /\.[A-Za-z0-9]+$/.test(preset.bin) ? preset.bin : `${preset.bin}.exe`;
}

/** 数据面的 `mcpFormat` 是开放字符串；自定义格式必须由 adapter 提供 mcp.* hook。 */
function resolvedMcpFormat(
  v: string | undefined,
  hooks: AgentAdapter | undefined,
): ResolvedAgent["mcpFormat"] {
  if (v === undefined) return "mcpServers";
  if (v === "mcpServers" || v === "mcp.servers" || v === "dshProfileYaml") return v;
  if (hooks?.mcp) return v;
  throw new Error(
    `mcpFormat「${v}」需要 adapter 提供 mcp.read/write hook（内置格式只有 mcpServers / mcp.servers / dshProfileYaml）`,
  );
}

/**
 * 解析预设二进制的实际位置：显式覆盖（`presets[名].bin`）> PATH > 预设的 `fallbackBinPaths`。
 * `presetAvailable` 与 `resolveAgentCore` 共用这一份判据，避免「能解析到却探测说没有」（qoder 的官方安装目录就是这种情况）。
 * 导出仅供单测。
 */
export function presetBinPath(
  preset: Pick<AcpAgentPreset, "bin" | "binWin" | "fallbackBinPaths">,
  overrideBin?: string,
): string | null {
  if (overrideBin) return locateBin(overrideBin);
  // 本机定义允许 bin 直接写绝对/相对路径；此时不该按 PATH 裸名处理。
  if (preset.bin.includes("/") || preset.bin.includes("\\"))
    return fs.existsSync(preset.bin) ? preset.bin : null;
  return (
    onPath(presetExe(preset)) ??
    (preset.fallbackBinPaths ?? []).find((p) => fs.existsSync(p)) ??
    null
  );
}

/**
 * 该 agent 的二进制是否可解析（只判定、不启动）。
 * 传入 cfg 时，`presets[名].bin` 里存的绝对路径也算「可用」——否则桌面端 DSH 这种「装了但不在 PATH」的 agent，auto 探测会白白跳过它。
 */
export function presetAvailable(key: string, cfg?: BrainConfig | null): boolean {
  const preset = ACP_AGENT_PRESETS[key];
  if (!preset) return false;
  const presets = cfg?.presets;
  const normalized = key.toLowerCase();
  const bin = presets && Object.hasOwn(presets, normalized) ? presets[normalized]?.bin : undefined;
  return presetBinPath(preset, bin) !== null;
}

/**
 * 解析一个 bin 说明（绝对/相对路径，或 PATH 上的裸名）到实际文件；解析不到返回 null。
 * 裸名在 Windows 上会补试 `.exe`/`.cmd`，覆盖 npm shim 的常见布局。
 */
function locateBin(bin: string): string | null {
  if (!bin) return null;
  if (bin.includes("/") || bin.includes(path.sep)) return fs.existsSync(bin) ? bin : null;
  const candidates = [bin];
  if (process.platform === "win32" && !/\.[A-Za-z0-9]+$/.test(bin))
    candidates.push(`${bin}.exe`, `${bin}.cmd`);
  for (const c of candidates) {
    const hit = onPath(c);
    if (hit) return hit;
  }
  return null;
}

/** daemon 因「大脑配置错误」退出时用的退出码；后台守护进程据此停止自动重启（配置错误需人工修，重拉无益）。 */
export const BRAIN_CONFIG_EXIT_CODE = 78;

export type ResolvedAgent = {
  name: string;
  /** 选中的定义坏了时的完整说明（含文件与修法）；此时 `known` 为 false。 */
  definitionProblem?: string;
  bin: string;
  args: string[];
  homeEnvVar?: string;
  extraConfigFiles: string[];
  shell: boolean;
  inherit: boolean;
  realHome?: string;
  inheritDirs: string[];
  inheritFiles: string[];
  configSubdir: string;
  mcpFormat: string;
  mcpConfigFile: string;
  catalogFile: string;
  env: Record<string, string>;
  /** 预设给的「默认环境变量」：父进程已设同名变量时不覆盖（用于审批类开关，部署方可以收紧）。 */
  envDefaults: Record<string, string>;
  /** 该 agent 的 adapter hook（数据表达不了的代码语义都在这里）。 */
  hooks?: AgentAdapter;
  /** adapter 的实际来源（内置模块名或绝对路径）；`agent show` 用它展示「会执行哪段代码」。 */
  adapterSource?: string;
  restore?: "load" | "resume";
  /** session/load|resume 返回后还会异步回放历史帧：恢复后先等帧流安静，再开始本轮提问。 */
  replayOnLoad: boolean;
  firstFrameMs?: number;
  heartbeatMs?: number;
  images: boolean;
  credentialFiles: string[];
  identityFiles: string[];
  settingsBase?: string;
  /** managed settings.json 的预设默认键（只补缺失键；用户显式设过则保留用户的值）。 */
  settingsDefaults: Record<string, unknown>;
  model?: string;
  /** 模型改为追加到启动参数（agent 不支持 session/set_config_option 时；如 gemini 的 "--model"）。 */
  modelArg?: string;
  realProfile?: string;
  /** 纯能力：Agent 接受 ACP `session/new|resume` 的 `mcpServers`（不代表它不读自己的配置）。 */
  acpMcpServers: boolean;
  /** WeMind 在 managed 托管 MCP 时的投递方式：写 Agent 配置文件，或随 ACP 会话下发。 */
  mcpDelivery: "config" | "acp";
  /** 会话建立/恢复后切到的模式 id（`session/set_mode`）；「免审批」用，留空=不调用。 */
  sessionMode?: string;
  /** `adapter.engine.prepareArgs` 的结论（如 kiro 的 v2/v3）。 */
  engine?: string;
  /** 启动前要落盘的 session-root patch（DSH：`--patch` 指向该文件，root 指向账号数据目录）。 */
  sessionPatch?: { file: string; root: string };
  /** 请求的原始值（来自 env / brain.json / 缺省 `auto`）。 */
  requestedKey: string;
  /** `requestedKey` 的来源。 */
  source: "env" | "file" | "auto";
  /** `requestedKey` 是否为已知 agent（未知 → false，不再静默回退 kiro）。 */
  known: boolean;
  /** 二进制是否解析到了实际文件（找不到 → false）。 */
  available: boolean;
  /** 解析到的二进制绝对路径（`available` 时才有）。 */
  binPath: string | null;
  /** 除 bin 外还必须能在 PATH 上解析到的运行时（如 pi-acp 需要 pi 本体）。 */
  requiresBins: string[];
  /** bin 是否来自覆盖（env / brain.json），而不是预设——静态 ACP 标记检查据此跳过（自定义入口可能自带 ACP 模式）。 */
  binOverridden: boolean;
};

/**
 * 组装 spawn 用的环境变量：父进程 env → `homeEnvVar` 指向副本（仅 managed）→ 从凭据文件派生的 env（父进程未提供时）→ 预设强制 `env`（仅 managed）→ 预设 `envDefaults`（父进程已设同名变量时保留父进程的，`skipped` 收集这些键供调用方记日志）。
 *
 * `direct`（默认）：不注入 `homeEnvVar` / 预设 `env`，
 * 让 Agent 像在终端直接启动一样读取自己的真实配置；仍保留 `envDefaults`（yolo / 免审批等默认值，父进程显式设置优先）与只读的凭据环境桥接。
 */
export function agentEnv(
  ag: ResolvedAgent,
  home: string,
  skipped: string[] = [],
  dataDir: string = DATA_DIR,
  opts: { direct?: boolean } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = mergeEnvSnapshot(process.env, readEnvSnapshot(dataDir));
  const direct = opts.direct === true;
  if (ag.homeEnvVar && !direct) env[ag.homeEnvVar] = home; // 把账号副本目录传给 agent（direct 不注入）
  // 从 agent 自己的凭据文件派生（如 Cline 的 CLINE_PROVIDER/CLINE_API_KEY）；helper 内部已保证父进程显式值优先
  for (const [k, v] of Object.entries(
    ag.hooks?.env?.derive?.({ realHome: ag.realHome, parentEnv: process.env }) ?? {},
  )) {
    if (env[k] === undefined) env[k] = v;
  }
  if (!direct) {
    for (const [k, v] of Object.entries(ag.env ?? {})) env[k] = v.replaceAll("%HOME%", home);
  }
  // envDefaults 是 WeMind 为保证「微信侧免逐次审批」而下发的默认值，不属于 Agent 配置；direct 下仍要保留。
  // 显式设置的同名变量优先（部署方可用它收紧权限），所以叫 defaults。
  for (const [k, v] of Object.entries(ag.envDefaults ?? {})) {
    if (env[k] !== undefined) {
      skipped.push(k);
      continue;
    }
    env[k] = v.replaceAll("%HOME%", home);
  }
  return env;
}

/** 该角色「选 agent」的环境变量：worker 先看 `WEMIND_WORKER_BRAIN`，未设则回落 `WEMIND_BRAIN`。 */
function envKeyFor(role: AgentRole): string | undefined {
  const key =
    role === "worker"
      ? process.env.WEMIND_WORKER_BRAIN?.trim() || process.env.WEMIND_BRAIN?.trim()
      : process.env.WEMIND_BRAIN?.trim();
  return key || undefined;
}

/** 模型覆盖里的「跟随 agent 默认」写法（`brain set deepseek --model auto`）：不指定任何模型。 */
function isDefaultModel(v: string): boolean {
  const s = v.trim().toLowerCase();
  return s === "auto" || s === "default";
}

/**
 * 启动前落盘 agent 需要的派生配置文件（由 adapter 的 `spawn.prepare` 解释）。
 * 与副本准备分开：`ensureBrainHome` 只在启动/换脑时调，`brain check` 和 worker 每次起进程也要有这份文件。
 */
export function prepareAgent(ag: ResolvedAgent): void {
  try {
    ag.hooks?.spawn?.prepare?.({ agent: ag });
  } catch {
    /* best-effort：派生文件写失败交给 agent 自己的启动错误，不让 daemon 在 spawn 前崩掉 */
  }
}

/** managed 副本准备好后的 adapter 收尾（如 kiro v3 的 permissions.yaml）。 */
export function prepareManagedAgent(ag: ResolvedAgent, configDir: string): void {
  try {
    ag.hooks?.spawn?.prepareManaged?.({ agent: ag, configDir });
  } catch {
    /* best-effort：与 prepareAgent 同一口径 */
  }
}

/**
 * 解析某角色要用的 ACP agent（核心实现，见文件头注释的三级优先级）。
 * 覆盖优先级：环境变量 > 本角色那段自带 > `presets[<agent 名>]` > 内置默认。
 * `ignoreEnv`：命令驱动的切换（`resolvePresetByName`）必须绕开 `WEMIND_BRAIN*`，否则会出现「点了切换、env 却压着它」的假成功。
 */
function resolveAgentCore(
  role: AgentRole,
  cfg: BrainConfig | null,
  opts: {
    ignoreEnv?: boolean;
    dataDir?: string;
    forceKey?: string;
    presetOverride?: AcpAgentPreset;
  } = {},
): ResolvedAgent {
  // `presetOverride` 用于 `agent check <文件>`：那份定义还没安装，但检查必须和安装后走同一套解析。
  // 它同时隐式忽略环境变量与账号覆盖，避免「检查的是 A、跑起来的是 B」。
  const ignoreEnv = opts.ignoreEnv === true || opts.presetOverride !== undefined;
  // 切换命令的 `ignoreEnv` 只隔离「选哪个 agent + 启动参数」；真实配置目录、继承开关等 ambient 覆盖仍应生效。
  // `agent check` 检查的是一份独立定义，必须连这些 ambient 覆盖也一起隔离。
  const definitionOnly = opts.presetOverride !== undefined;
  // `forceKey` 只锁「选哪个 agent」，不锁字段覆盖：`agent show` 要看这个 agent 的最终生效值（含 env 字段覆盖），
  // 但不能被 WEMIND_BRAIN 改成别的 agent。
  const envKey = ignoreEnv || opts.forceKey ? undefined : envKeyFor(role);
  const roleCfg = agentConfigFor(cfg, role);
  const fileKey =
    opts.presetOverride?.name ?? opts.forceKey?.trim().toLowerCase() ?? roleCfg?.agent?.trim();
  const requestedKey = (opts.presetOverride?.name ?? envKey ?? fileKey ?? "auto").toLowerCase();
  const source: ResolvedAgent["source"] = opts.presetOverride
    ? "file"
    : opts.forceKey
      ? "file"
      : envKey
        ? "env"
        : fileKey
          ? "file"
          : "auto";
  const broken =
    opts.presetOverride || requestedKey === "auto"
      ? undefined
      : findBrokenAgentDefinition(requestedKey);

  // 选 agent：auto → 探测第一个可用；未知值 → 标 known:false（结构上退回 kiro 兜底，交启动校验报错）。
  let known = true;
  let key = opts.presetOverride?.name ?? requestedKey;
  if (!opts.presetOverride) {
    if (key === "auto") {
      key = AUTO_PROBE_ORDER.find((k) => presetAvailable(k, cfg)) ?? "kiro";
    } else if (broken || !ACP_AGENT_PRESETS[key]) {
      known = false;
    }
  }
  // 坏定义 / 未知值不能借用另一个 agent 的预设：占位预设只用于填满结构，`agentProblem()` 会先报原因。
  const preset: AcpAgentPreset = opts.presetOverride ??
    ACP_AGENT_PRESETS[key] ?? {
      schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
      name: key,
      bin: key,
      args: [],
    };
  const homeMode = readHomeMode(opts.dataDir ?? DATA_DIR);
  // 按 agent 名存的启动覆盖：无论谁在用这个 agent 都适用（顶层覆盖只属于「写入磁盘那个 agent」，切走后不该跟过去）。
  const presetOv =
    !opts.presetOverride && cfg?.presets && Object.hasOwn(cfg.presets, key)
      ? cfg.presets[key]
      : undefined;

  // roleCfg 的 bin/args/shell/homeEnvVar 是**给该段所写那个 agent** 的启动覆盖；环境变量临时切到别的 agent 时不能沿用（否则会拿 deepseek 的 dsh.cmd 去起 qoder）。
  const overrideCfg = opts.presetOverride
    ? null
    : (envKey || opts.forceKey) &&
        roleCfg?.agent?.trim() &&
        roleCfg.agent.trim().toLowerCase() !== requestedKey
      ? null
      : roleCfg;

  const shellEnv = ignoreEnv ? undefined : process.env.WEMIND_BRAIN_SHELL?.trim();
  const shell =
    shellEnv !== undefined && shellEnv !== ""
      ? shellEnv === "1" || shellEnv.toLowerCase() === "true"
      : (overrideCfg?.shell ?? presetOv?.shell ?? preset.shell ?? false);

  // 二进制：env 覆盖 > (kiro 旧变量) > 本段覆盖 > presets[agent 名] 覆盖 > PATH 解析 > agent 裸名。
  // 经 shell 启动时用裸名（让 shell 从 PATH 解析，避免带空格的全路径在 shell 下出问题）。
  const envBin = ignoreEnv ? undefined : process.env.WEMIND_BRAIN_BIN?.trim();
  const legacyBin = ignoreEnv
    ? undefined
    : preset.hooks?.env?.binOverride?.({ parentEnv: process.env });
  const explicitBin =
    envBin || legacyBin || overrideCfg?.bin?.trim() || presetOv?.bin?.trim() || "";
  const exe = presetExe(preset);
  const binPath = explicitBin ? locateBin(explicitBin) : presetBinPath(preset);
  const bin =
    explicitBin ||
    (shell ? (process.platform === "win32" ? exe : preset.bin) : binPath || preset.bin);
  const available = known && binPath !== null;

  // 继承「记忆/规则/技能」：来源目录与子目录清单按 agent 而异（下沉到 agent），env 可覆盖。
  // 放在 args 之前：kiro 的引擎选择与 v3 的信任参数清洗都要用它。
  const inherit =
    definitionOnly ||
    (process.env.WEMIND_BRAIN_INHERIT ?? process.env.WECHAT_BRAIN_INHERIT ?? "1") !== "0";
  const realHome = definitionOnly
    ? preset.realHome
    : process.env.WEMIND_BRAIN_REAL_HOME?.trim() ||
      process.env.WECHAT_REAL_KIRO_HOME?.trim() ||
      preset.realHome;

  const argsOverride = ignoreEnv ? undefined : process.env.WEMIND_BRAIN_ARGS?.trim();
  const baseArgs = argsOverride
    ? argsOverride.split(/\s+/)
    : overrideCfg?.args && overrideCfg.args.length
      ? overrideCfg.args
      : presetOv?.args && presetOv.args.length
        ? presetOv.args
        : preset.args;
  // 追加参数：与 args 的「整段替换」不同，extraArgs 永远拼在后面（保留预设里的 ACP 模式参数）。
  // 来源优先级同 args：env > 本段（该角色）> presets[agent 名]。
  const extraEnv = ignoreEnv ? undefined : process.env.WEMIND_BRAIN_EXTRA_ARGS?.trim();
  const extraArgs = extraEnv
    ? extraEnv.split(/\s+/)
    : overrideCfg?.extraArgs && overrideCfg.extraArgs.length
      ? overrideCfg.extraArgs
      : presetOv?.extraArgs && presetOv.extraArgs.length
        ? presetOv.extraArgs
        : [];
  let args = [...baseArgs, ...extraArgs];

  // 引擎差异（如 kiro v2/v3 的参数与免审批方式）由 adapter 解释。
  const engineResult = preset.hooks?.engine?.prepareArgs?.({
    definition: preset,
    args,
    realHome,
    binPath,
  });
  if (engineResult) args = engineResult.args;
  const engine = engineResult?.engine;

  // 会话目录隔离等启动前派生文件由 adapter 解释；用户显式给的参数由 hook 自己尊重。
  let sessionPatch: ResolvedAgent["sessionPatch"];
  const spawnPrepared = preset.hooks?.spawn?.prepareArgs?.({
    definition: preset,
    role,
    dataDir: opts.dataDir ?? DATA_DIR,
    args,
    homeMode,
  });
  if (spawnPrepared) {
    args = spawnPrepared.args;
    sessionPatch = spawnPrepared.sessionPatch;
  }

  const homeEnvVar =
    (ignoreEnv ? undefined : process.env.WEMIND_BRAIN_HOME_ENV?.trim()) ||
    overrideCfg?.homeEnvVar?.trim() ||
    presetOv?.homeEnvVar?.trim() ||
    preset.homeEnvVar;

  // 模型：显式覆盖（本段 > presets[agent 名]）优先；`auto`/`default` 或没写 = 跟随默认——
  // 配了 realProfile 的 agent（DSH）从用户真实 profile 读（优先 `- id: acp`，否则 `agent-default-model`；WeMind 只读不写，缺 `- id: acp` 由 `wemind brain` 提示用户补）；
  // 读到的值经 `set_config_option` 下发；读不到时：`auto` = 不下发，没写 = 用内置预设值兜底。
  const rawModel = overrideCfg?.model?.trim() || presetOv?.model?.trim() || "";
  const explicitModel = rawModel && !isDefaultModel(rawModel) ? rawModel : "";
  const derivedModel =
    !explicitModel && preset.realProfile && realHome && inherit
      ? (preset.hooks?.profile?.readDefaultModel?.(realHome, preset.realProfile) ?? null)
      : null;
  const model =
    explicitModel || derivedModel || (isDefaultModel(rawModel) ? undefined : preset.model);
  // 不支持 session/set_config_option 的 agent（gemini）：模型用它自己的 CLI 参数传，进程启动时生效。
  if (preset.modelArg && model) args.push(preset.modelArg, model);
  const dirsEnv = definitionOnly ? undefined : process.env.WEMIND_BRAIN_INHERIT_DIRS?.trim();
  const inheritDirs = dirsEnv
    ? dirsEnv.split(/[,\s]+/).filter(Boolean)
    : (preset.inheritDirs ?? []);

  // 会话模式：预设默认；`WEMIND_ACP_SESSION_MODE=0/false/off` 关闭（让 agent 回到自己的审批流程），
  // 其它非空值 = 覆盖成该 modeId（自定义 agent 用）。环境变量是一次性覆盖，持久值仍以预设为准。
  const modeEnv = definitionOnly ? undefined : process.env.WEMIND_ACP_SESSION_MODE?.trim();
  const modeOff = !!modeEnv && ["0", "false", "off", "no"].includes(modeEnv.toLowerCase());
  const sessionMode = modeOff ? undefined : modeEnv || preset.sessionMode;

  return {
    name: preset.name,
    ...(broken ? { definitionProblem: brokenAgentDefinitionMessage(broken) } : {}),
    bin,
    args,
    homeEnvVar,
    extraConfigFiles: preset.extraConfigFiles ?? [],
    shell,
    inherit,
    realHome,
    inheritDirs,
    inheritFiles: preset.inheritFiles ?? [],
    configSubdir: preset.configSubdir ?? "",
    mcpFormat: resolvedMcpFormat(preset.mcpFormat, preset.hooks),
    mcpConfigFile: preset.mcpConfigFile ?? "settings/mcp.json",
    catalogFile: preset.catalogFile ?? "settings/mcp.json",
    env: preset.env ?? {},
    envDefaults: preset.envDefaults ?? {},
    hooks: preset.hooks,
    adapterSource: preset.adapterSource,
    restore: preset.restore,
    replayOnLoad: preset.replayOnLoad ?? false,
    firstFrameMs: preset.firstFrameMs,
    heartbeatMs: preset.heartbeatMs,
    images: preset.images ?? true,
    credentialFiles: preset.credentialFiles ?? [],
    identityFiles: preset.identityFiles ?? [],
    settingsBase: preset.settingsBase,
    settingsDefaults: preset.settingsDefaults ?? {},
    model,
    modelArg: preset.modelArg,
    realProfile: preset.realProfile,
    acpMcpServers: preset.acpMcpServers ?? false,
    mcpDelivery: preset.mcpDelivery ?? "config",
    sessionMode,
    engine,
    sessionPatch,
    requestedKey,
    source,
    known,
    available,
    binPath,
    requiresBins: preset.requiresBins ?? [],
    binOverridden: !!explicitBin,
  };
}

/** 解析当前要用的**对话大脑**：环境变量 > 账号 brain.json 顶层 > auto。
 *  `dataDir` 只影响 DSH 的 `--patch` 路径；daemon 内默认就是本账号目录，CLI 处理别的账号时由调用方传入 `accountDir(key)`。 */
export function resolveAgent(cfg?: BrainConfig | null, dataDir?: string): ResolvedAgent {
  return resolveAgentCore("brain", cfg ?? null, dataDir ? { dataDir } : {});
}

/** 解析某**角色**要用的 ACP agent：`brain` = 对话大脑（同 resolveAgent），`worker` = 任务 worker（`worker` 段 > 顶层）。 */
export function resolveAgentFor(
  cfg: BrainConfig | null | undefined,
  role: AgentRole,
  dataDir?: string,
): ResolvedAgent {
  return resolveAgentCore(role, cfg ?? null, dataDir ? { dataDir } : {});
}

/** 按名字解析**最终生效值**（含一次性的 env 字段覆盖，但不让 `WEMIND_BRAIN` 改选目标）。 */
export function resolveAgentByName(
  name: string,
  cfg?: BrainConfig | null,
  dataDir?: string,
): ResolvedAgent {
  return resolveAgentCore("brain", cfg ?? null, {
    forceKey: name,
    ...(dataDir ? { dataDir } : {}),
  });
}

/**
 * 把一份尚未安装的定义解析成可 spawn 的 agent，供 `wemind agent check <文件>` 使用。
 * 它刻意绕开环境变量与账号覆盖：检查的必须是用户眼前这份定义，而不是「碰巧生效的另一个」。
 */
export function resolveAgentFromDefinition(
  def: AgentDefinition,
  opts: { dataDir?: string; definitionFile?: string } = {},
): ResolvedAgent {
  return resolveAgentCore("brain", null, {
    ignoreEnv: true,
    presetOverride: presetForDefinition(def, opts.definitionFile),
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
  });
}

/** 全部 agent 名（`auto` 不在其中：它只是「自动探测」的开关）。 */
export function presetNames(): string[] {
  return Object.keys(ACP_AGENT_PRESETS);
}

/** 可作为 agent 名/指令 token 的集合：有效定义、坏定义（用于回可读错误）与 `auto`。 */
export function isAgentName(name: string): boolean {
  const key = (name ?? "").trim().toLowerCase();
  return key === "auto" || isAgentToken(key);
}

/**
 * 按名字解析一个 agent，**绕开环境变量**——供「切换大脑」这类命令使用。
 *
 * 为什么绕开：`WEMIND_BRAIN` 优先级高于 brain.json，命令若也走 env 优先级，会出现「用户点了切换、看着成功，实际还是 env 指的那个」。
 * 命令语义 = 用户此刻的明确意图，应压过一次性环境覆盖（`resolvePresetByName` 的结果由调用方写进 brain.json）。
 * 同理，属于「别的 agent」的启动覆盖不会被沿用；但 `presets[名]` 里按名字存的覆盖会（切走再切回不丢 `--bin`）。
 *
 * 失败返回面向用户的原因（未知 agent / 该 agent 二进制找不到），成功返回可直接 spawn 的 agent。
 */
export function resolvePresetByName(
  name: string,
  cfg?: BrainConfig | null,
  dataDir?: string,
): { ok: true; agent: ResolvedAgent } | { ok: false; problem: string } {
  const key = (name ?? "").trim().toLowerCase();
  if (!key) return { ok: false, problem: "需要指定 agent 名（或 `auto` 重新自动探测）。" };
  const base: BrainConfig = { agent: key, presets: cfg?.presets };
  // 顶层启动覆盖只属于「写入磁盘那个 agent」：目标就是它时带上（例如 `brain set deepseek --bin …` 后切回 deepseek）。
  if (cfg?.agent?.trim().toLowerCase() === key) {
    if (cfg.bin) base.bin = cfg.bin;
    if (cfg.args?.length) base.args = cfg.args;
    if (cfg.extraArgs?.length) base.extraArgs = cfg.extraArgs;
    if (cfg.shell !== undefined) base.shell = cfg.shell;
    if (cfg.homeEnvVar) base.homeEnvVar = cfg.homeEnvVar;
    if (cfg.model) base.model = cfg.model;
  }
  const agent = resolveAgentCore("brain", base, {
    ignoreEnv: true,
    ...(dataDir ? { dataDir } : {}),
  });
  const problem = agentProblem(agent);
  return problem ? { ok: false, problem } : { ok: true, agent };
}

/**
 * 校验解析后的大脑是否可用：可用返回 null，否则返回一句面向用户的说明。
 * 供 daemon 启动校验（早失败、说人话）与 `wemind brain` / `wemind brain check` 复用。
 */
export function agentProblem(ag: ResolvedAgent): string | null {
  if (ag.definitionProblem) return ag.definitionProblem;
  if (!ag.known)
    return `未知 agent「${ag.requestedKey}」。可选：${Object.keys(ACP_AGENT_PRESETS).join("、")}（自定义二进制可用 WEMIND_BRAIN_BIN 或 brain set --bin 指定）`;
  if (ag.requestedKey === "auto" && !ag.available)
    return `自动探测未找到可用的大脑（已试：${AUTO_PROBE_ORDER.join("、")}）。请安装其中之一，或运行 \`wemind brain set <agent 名>\``;
  if (!ag.available) {
    const hint = ag.hooks?.hints?.install?.({
      agentName: ag.name,
      bin: ag.bin,
    });
    if (hint)
      return `找不到大脑「${ag.name}」的适配器「${ag.bin}」。先装适配器：${hint}；装完仍找不到就 \`wemind brain set ${ag.name} --bin "<绝对路径>"\` 指定它。`;
    return `找不到大脑「${ag.name}」的二进制「${ag.bin}」。安装它，或运行 \`wemind brain set <agent 名>\` 切换`;
  }
  // 适配器已装、但它依赖的运行时没装（如 pi-acp 找到了、pi 本体不在 PATH）：
  // 提前说清楚，别等 session/new 才抛一句适配器的内部错误。
  const missingRuntime = ag.requiresBins.filter((b) => !onPathAny(b));
  if (missingRuntime.length) {
    const hint = ag.hooks?.hints?.install?.({
      agentName: ag.name,
      bin: ag.bin,
      requiresBins: ag.requiresBins,
    });
    return `找不到「${ag.name}」需要的运行时「${missingRuntime.join("、")}」。${hint ? `安装：${hint}` : "先安装它，再试。"}`;
  }
  return null;
}

/**
 * 认证失败时按 agent 补一句可执行的建议（`wemind brain check` 与 daemon 日志复用）。
 * Cline 的 ACP 只自动恢复它自己的 3 种登录；自定义 provider 必须靠环境变量——
 * 「重启 daemon」对它没用，所以不能只套用通用的「密钥/鉴权」提示。
 * 其它 agent 返回空串（不改变既有文案）。
 */
export function authHint(agentName: string, message: string): string {
  const preset = ACP_AGENT_PRESETS[agentName];
  return preset?.hooks?.hints?.auth?.({ agentName, message }) ?? "";
}
