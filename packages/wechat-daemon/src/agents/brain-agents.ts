import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

import { DATA_DIR } from "@wemind/wechat-ilink-core";
import { agentConfigFor, type AgentRole, type BrainConfig } from "./brain-config.js";
import { readProfileDefaultModel } from "./profile-model.js";
import { ACP_AGENT_PRESETS, DEFAULT_SETTINGS_STRIP, type AcpAgentPreset } from "./brain-presets.js";
import { readEnvSnapshot, mergeEnvSnapshot } from "./config/env-snapshot.js";
import { readHomeMode } from "./config/home-mode.js";

/**
 * ACP agent 与解析。
 *
 * WeMind 的大脑通过**标准 ACP（Agent Client Protocol，JSON-RPC over stdio）**驱动一个 agent CLI。ACP 是通用协议（kiro-cli、gemini-cli 等都支持），因此接入任意兼容 ACP 的 agent 不需要改协议代码——只需告诉我们三件事：① 二进制名；② 进入 ACP 模式的启动参数；③ 该 agent 读取「配置/数据目录」的环境变量名（只在 sandbox 下指向账号沙箱；direct 不设置）。
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

export { ACP_AGENT_PRESETS, DEFAULT_SETTINGS_STRIP } from "./brain-presets.js";
export type { AcpAgentPreset } from "./brain-presets.js";

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
export const AUTO_PROBE_ORDER = [
  "opencode",
  "cline",
  "qoder",
  "gemini",
  "deepseek",
  "kiro",
] as const;

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
  return process.platform === "win32" ? (preset.binWin ?? `${preset.bin}.exe`) : preset.bin;
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
  return presetBinPath(preset, cfg?.presets?.[key.toLowerCase()]?.bin) !== null;
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
  mcpFormat: "mcpServers" | "mcp.servers" | "dshProfileYaml";
  mcpConfigFile: string;
  catalogFile: string;
  env: Record<string, string>;
  /** 预设给的「默认环境变量」：父进程已设同名变量时不覆盖（用于审批类开关，部署方可以收紧）。 */
  envDefaults: Record<string, string>;
  /** 没有 homeEnvVar 的 agent 在非 direct 场景直接用真实 home 时需要覆盖的 env（见 preset 注释）。 */
  /** 从 agent 自己的凭据文件派生环境变量（父进程未显式提供时；如 Cline 自定义 provider）。 */
  credentialEnv?: (
    realHome: string | undefined,
    parentEnv: NodeJS.ProcessEnv,
  ) => Record<string, string>;
  restore?: "load" | "resume";
  /** session/load|resume 返回后还会异步回放历史帧：恢复后先等帧流安静，再开始本轮提问。 */
  replayOnLoad: boolean;
  firstFrameMs?: number;
  heartbeatMs?: number;
  images: boolean;
  credentialFiles: string[];
  identityFiles: string[];
  settingsBase?: string;
  /** settingsBase 基底里要删掉的键（默认 DEFAULT_SETTINGS_STRIP）。 */
  settingsStrip: string[];
  /** sandbox settings.json 的预设默认键（只补缺失键；用户显式设过则保留用户的值）。 */
  settingsDefaults: Record<string, unknown>;
  model?: string;
  /** 模型改为追加到启动参数（agent 不支持 session/set_config_option 时；如 gemini 的 "--model"）。 */
  modelArg?: string;
  realProfile?: string;
  /** 纯能力：Agent 接受 ACP `session/new|resume` 的 `mcpServers`（不代表它不读自己的配置）。 */
  acpMcpServers: boolean;
  /** WeMind 在 sandbox 托管 MCP 时的投递方式：写 Agent 配置文件，或随 ACP 会话下发。 */
  mcpDelivery: "config" | "acp";
  /** 会话建立/恢复后切到的模式 id（`session/set_mode`）；「免审批」用，留空=不调用。 */
  sessionMode?: string;
  /** kiro 是否跑在 v3 引擎（决定启动参数与能否用 v3 的 permissions.yaml 免审批）。 */
  kiroV3?: boolean;
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
 * 组装 spawn 用的环境变量：父进程 env → `homeEnvVar` 指向沙箱（仅 sandbox）→ 从凭据文件派生的 env（父进程未提供时）→ 预设强制 `env`（仅 sandbox）→ 预设 `envDefaults`（父进程已设同名变量时保留父进程的，`skipped` 收集这些键供调用方记日志）。
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
  if (ag.homeEnvVar && !direct) env[ag.homeEnvVar] = home; // 把账号沙箱目录传给 agent（direct 不注入）
  // 从 agent 自己的凭据文件派生（如 Cline 的 CLINE_PROVIDER/CLINE_API_KEY）；helper 内部已保证父进程显式值优先
  for (const [k, v] of Object.entries(ag.credentialEnv?.(ag.realHome, process.env) ?? {})) {
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
 * kiro 的 ACP 引擎：启动参数里的 `--agent-engine` → 真实 `settings/cli.json` 的 `acp.agentEngine` → CLI 主版本 ≥3 的默认 v3 → 其余 v2。
 * 2.37.1 的 `kiro-cli acp --help` 写明「v2 when neither is set」；「CLI ≥3 默认 v3」是**假设/待实测**，只作兜底（防未来大版本把默认切到 v3 后仍带 v2 专属参数 → 握手超时）。
 * `--agent-engine` 还接受 `v1`，未验证，按 v2 处理（保留 v2 参数）；`chat.agentEngine` **不影响** acp（官方文档原话），不能拿它推断。
 * v2 与 v3 的免审批方式不同：v2 是 `--trust-all-tools`（v3 会拒绝这个参数），v3 走 `settings/permissions.yaml` 的 allow-all 规则。
 */
function kiroEngineFromArgs(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--agent-engine=")) return args[i].split("=")[1];
    if (args[i] === "--agent-engine") return args[i + 1];
  }
  return undefined;
}

function kiroEngineFromSettings(realHome: string | undefined): string | undefined {
  if (!realHome) return undefined;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(realHome, "settings", "cli.json"), "utf-8"));
    const v = j?.["acp.agentEngine"];
    return typeof v === "string" ? v.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

const kiroMajorCache = new Map<string, number | null>();
/** `kiro-cli --version` 的主版本（只探一次；找不到/超时/解析失败都按 null，调用方回退 v2）。 */
function kiroCliMajor(binPath: string | null): number | null {
  if (!binPath) return null;
  if (kiroMajorCache.has(binPath)) return kiroMajorCache.get(binPath) ?? null;
  let major: number | null = null;
  try {
    const r = spawnSync(binPath, ["--version"], {
      encoding: "utf-8",
      timeout: 5_000,
      windowsHide: true,
    });
    const m = /(?:^|\s)(\d+)\.\d+\.\d+/.exec(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
    if (m) major = Number(m[1]);
  } catch {
    /* 找不到/超时：按未知处理 */
  }
  kiroMajorCache.set(binPath, major);
  return major;
}

function resolveKiroV3(
  args: readonly string[],
  realHome: string | undefined,
  binPath: string | null,
): boolean {
  const fromArgs = kiroEngineFromArgs(args);
  if (fromArgs) return fromArgs.toLowerCase() === "v3";
  const fromSettings = kiroEngineFromSettings(realHome);
  if (fromSettings) return fromSettings === "v3";
  return (kiroCliMajor(binPath) ?? 0) >= 3;
}

/** v3 拒绝 v2 专属的整会话信任参数；v3 的免审批改由 sandbox `settings/permissions.yaml` 承担。 */
function stripKiroV2TrustArgs(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--trust-all-tools" || a === "-a") continue;
    if (a === "--trust-tools") {
      i++;
      continue;
    }
    if (a.startsWith("--trust-tools=")) continue;
    kept.push(a);
  }
  return kept;
}

/** DSH 会话持久化目录（账号数据目录内，按角色分开；与 kiro/pi 共用的沙箱根隔离开）。
 *  `dataDir` 允许调用方显式指定账号目录：CLI 进程里的 `DATA_DIR` 是**默认账号**的目录，不能拿来替别的账号解析（`brain check`/`list`/`stop` 会用到）。 */
function dshSessionPatchFor(role: AgentRole, dataDir: string): { file: string; root: string } {
  const dir = path.join(dataDir, "agent-sessions", "deepseek");
  return {
    file: path.join(dir, `session-root-${role}.patch.yml`),
    root: path.join(dir, role),
  };
}

/**
 * 启动前落盘 agent 需要的派生配置文件（DSH 的 session-root patch）。
 * 与沙箱准备分开：`ensureBrainHome` 只在启动/换脑时调，`brain check` 和 worker 每次起进程也要有这份文件。
 */
export function prepareAgent(ag: ResolvedAgent): void {
  const patch = ag.sessionPatch;
  if (!patch) return;
  try {
    fs.mkdirSync(patch.root, { recursive: true });
    fs.mkdirSync(path.dirname(patch.file), { recursive: true });
    // DSH 的 patch 是 YAML 列表；JSON.stringify 给双引号字符串，Windows 反斜杠也能正确转义。
    const body = `- id: session-persistence-jsonl\n  config:\n    root: ${JSON.stringify(patch.root)}\n`;
    if (!fs.existsSync(patch.file) || fs.readFileSync(patch.file, "utf-8") !== body)
      fs.writeFileSync(patch.file, body, "utf-8");
  } catch {
    /* best-effort：写不了就让 agent 自己报错（缺 --patch 文件比静默换目录更容易诊断） */
  }
}

/** kiro v3 的免审批默认（等价于 v2 的 `--trust-all-tools`）：sandbox settings/permissions.yaml 缺失时补上。 */
export function ensureKiroV3Permissions(ag: ResolvedAgent, settingsDir: string): void {
  if (!ag.kiroV3) return;
  try {
    const dst = path.join(settingsDir, "permissions.yaml");
    if (fs.existsSync(dst)) return; // 沙箱里已有（或用户已同步）就尊重用户的规则
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(dst, "rules:\n  - capability: all\n    effect: allow\n", "utf-8");
  } catch {
    /* best-effort */
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
  opts: { ignoreEnv?: boolean; dataDir?: string } = {},
): ResolvedAgent {
  const envKey = opts.ignoreEnv ? undefined : envKeyFor(role);
  const roleCfg = agentConfigFor(cfg, role);
  const fileKey = roleCfg?.agent?.trim();
  const requestedKey = (envKey || fileKey || "auto").toLowerCase();
  const source: ResolvedAgent["source"] = envKey ? "env" : fileKey ? "file" : "auto";

  // 选 agent：auto → 探测第一个可用；未知值 → 标 known:false（结构上退回 kiro 兜底，交启动校验报错）。
  let known = true;
  let key = requestedKey;
  if (key === "auto") {
    key = AUTO_PROBE_ORDER.find((k) => presetAvailable(k, cfg)) ?? "kiro";
  } else if (!ACP_AGENT_PRESETS[key]) {
    known = false;
    key = "kiro";
  }
  const preset = ACP_AGENT_PRESETS[key];
  const homeMode = readHomeMode(opts.dataDir ?? DATA_DIR);
  // 按 agent 名存的启动覆盖：无论谁在用这个 agent 都适用（顶层覆盖只属于「写入磁盘那个 agent」，切走后不该跟过去）。
  const presetOv = cfg?.presets?.[key];

  // roleCfg 的 bin/args/shell/homeEnvVar 是**给该段所写那个 agent** 的启动覆盖；环境变量临时切到别的 agent 时不能沿用（否则会拿 deepseek 的 dsh.cmd 去起 qoder）。
  const overrideCfg =
    envKey && roleCfg?.agent?.trim() && roleCfg.agent.trim().toLowerCase() !== requestedKey
      ? null
      : roleCfg;

  const shellEnv = opts.ignoreEnv ? undefined : process.env.WEMIND_BRAIN_SHELL?.trim();
  const shell =
    shellEnv !== undefined && shellEnv !== ""
      ? shellEnv === "1" || shellEnv.toLowerCase() === "true"
      : (overrideCfg?.shell ?? presetOv?.shell ?? preset.shell ?? false);

  // 二进制：env 覆盖 > (kiro 旧变量) > 本段覆盖 > presets[agent 名] 覆盖 > PATH 解析 > agent 裸名。
  // 经 shell 启动时用裸名（让 shell 从 PATH 解析，避免带空格的全路径在 shell 下出问题）。
  const envBin = opts.ignoreEnv ? undefined : process.env.WEMIND_BRAIN_BIN?.trim();
  const kiroBin =
    opts.ignoreEnv || preset.name !== "kiro" ? undefined : process.env.KIRO_CLI_BIN?.trim();
  const explicitBin = envBin || kiroBin || overrideCfg?.bin?.trim() || presetOv?.bin?.trim() || "";
  const exe = presetExe(preset);
  const binPath = explicitBin ? locateBin(explicitBin) : presetBinPath(preset);
  const bin =
    explicitBin ||
    (shell ? (process.platform === "win32" ? exe : preset.bin) : binPath || preset.bin);
  const available = known && binPath !== null;

  // 继承「记忆/规则/技能」：来源目录与子目录清单按 agent 而异（下沉到 agent），env 可覆盖。
  // 放在 args 之前：kiro 的引擎选择与 v3 的信任参数清洗都要用它。
  const inherit =
    (process.env.WEMIND_BRAIN_INHERIT ?? process.env.WECHAT_BRAIN_INHERIT ?? "1") !== "0";
  const realHome =
    process.env.WEMIND_BRAIN_REAL_HOME?.trim() ||
    process.env.WECHAT_REAL_KIRO_HOME?.trim() ||
    preset.realHome;

  const argsOverride = opts.ignoreEnv ? undefined : process.env.WEMIND_BRAIN_ARGS?.trim();
  const baseArgs = argsOverride
    ? argsOverride.split(/\s+/)
    : overrideCfg?.args && overrideCfg.args.length
      ? overrideCfg.args
      : presetOv?.args && presetOv.args.length
        ? presetOv.args
        : preset.args;
  // 追加参数：与 args 的「整段替换」不同，extraArgs 永远拼在后面（保留预设里的 ACP 模式参数）。
  // 来源优先级同 args：env > 本段（该角色）> presets[agent 名]。
  const extraEnv = opts.ignoreEnv ? undefined : process.env.WEMIND_BRAIN_EXTRA_ARGS?.trim();
  const extraArgs = extraEnv
    ? extraEnv.split(/\s+/)
    : overrideCfg?.extraArgs && overrideCfg.extraArgs.length
      ? overrideCfg.extraArgs
      : presetOv?.extraArgs && presetOv.extraArgs.length
        ? presetOv.extraArgs
        : [];
  let args = [...baseArgs, ...extraArgs];

  // kiro：v3 删掉 v2 专属信任参数并显式声明引擎；v2 保持原样（`--trust-all-tools`）。
  const kiroV3 = preset.kiroEngine ? resolveKiroV3(args, realHome, binPath) : false;
  if (kiroV3) {
    args = stripKiroV2TrustArgs(args);
    if (!kiroEngineFromArgs(args)) args.push("--agent-engine", "v3");
  }

  // 会话目录隔离：agent 的 `--patch` 指向账号数据目录下的 per-role 文件（DSH）。
  // 用户自己显式给了 `--patch` 就尊重用户，不追加第二个。
  let sessionPatch: ResolvedAgent["sessionPatch"];
  if (preset.isolateSessions && homeMode === "sandbox" && !args.includes("--patch")) {
    sessionPatch = dshSessionPatchFor(role, opts.dataDir ?? DATA_DIR);
    args.push("--patch", sessionPatch.file);
  }

  const homeEnvVar =
    (opts.ignoreEnv ? undefined : process.env.WEMIND_BRAIN_HOME_ENV?.trim()) ||
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
      ? readProfileDefaultModel(realHome, preset.realProfile)
      : null;
  const model =
    explicitModel || derivedModel || (isDefaultModel(rawModel) ? undefined : preset.model);
  // 不支持 session/set_config_option 的 agent（gemini）：模型用它自己的 CLI 参数传，进程启动时生效。
  if (preset.modelArg && model) args.push(preset.modelArg, model);
  const dirsEnv = process.env.WEMIND_BRAIN_INHERIT_DIRS?.trim();
  const inheritDirs = dirsEnv
    ? dirsEnv.split(/[,\s]+/).filter(Boolean)
    : (preset.inheritDirs ?? []);

  // 会话模式：预设默认；`WEMIND_ACP_SESSION_MODE=0/false/off` 关闭（让 agent 回到自己的审批流程），
  // 其它非空值 = 覆盖成该 modeId（自定义 agent 用）。环境变量是一次性覆盖，持久值仍以预设为准。
  const modeEnv = process.env.WEMIND_ACP_SESSION_MODE?.trim();
  const modeOff = !!modeEnv && ["0", "false", "off", "no"].includes(modeEnv.toLowerCase());
  const sessionMode = modeOff ? undefined : modeEnv || preset.sessionMode;

  return {
    name: preset.name,
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
    mcpFormat: preset.mcpFormat ?? "mcpServers",
    mcpConfigFile: preset.mcpConfigFile ?? "settings/mcp.json",
    catalogFile: preset.catalogFile ?? "settings/mcp.json",
    env: preset.env ?? {},
    envDefaults: preset.envDefaults ?? {},
    credentialEnv: preset.credentialEnv,
    restore: preset.restore,
    replayOnLoad: preset.replayOnLoad ?? false,
    firstFrameMs: preset.firstFrameMs,
    heartbeatMs: preset.heartbeatMs,
    images: preset.images ?? true,
    credentialFiles: preset.credentialFiles ?? [],
    identityFiles: preset.identityFiles ?? [],
    settingsBase: preset.settingsBase,
    settingsStrip: preset.settingsStrip ?? DEFAULT_SETTINGS_STRIP,
    settingsDefaults: preset.settingsDefaults ?? {},
    model,
    modelArg: preset.modelArg,
    realProfile: preset.realProfile,
    acpMcpServers: preset.acpMcpServers ?? false,
    mcpDelivery: preset.mcpDelivery ?? "config",
    sessionMode,
    kiroV3,
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

/** 全部 agent 名（`auto` 不在其中：它只是「自动探测」的开关）。 */
export function presetNames(): string[] {
  return Object.keys(ACP_AGENT_PRESETS);
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
 * 适配器类 agent 的安装指引：找不到适配器二进制时**直接给出可粘贴的命令**。
 * 口径：**适配器一律全局安装**（daemon 常驻、worker 每条任务起进程；npx 每次冷启动要联网现下、版本不可复现）。
 */
const ADAPTER_INSTALL_HINT: Record<string, string> = {
  "claude-code":
    "`npm i -g @agentclientprotocol/claude-agent-acp`（装完得到 claude-agent-acp；Windows 上是 claude-agent-acp.cmd；**需 Node ≥22**）",
  codex:
    "`npm i -g @agentclientprotocol/codex-acp`（装完得到 codex-acp；Windows 上是 codex-acp.cmd）",
  pi: "`npm i -g pi-acp`（装完得到 pi-acp；Windows 上是 pi-acp.cmd）；另需 `npm i -g @earendil-works/pi-coding-agent` 提供 pi 本体，并在终端里先登录/配好模型",
};

/**
 * 校验解析后的大脑是否可用：可用返回 null，否则返回一句面向用户的说明。
 * 供 daemon 启动校验（早失败、说人话）与 `wemind brain` / `wemind brain check` 复用。
 */
export function agentProblem(ag: ResolvedAgent): string | null {
  if (!ag.known)
    return `未知 agent「${ag.requestedKey}」。可选：${Object.keys(ACP_AGENT_PRESETS).join("、")}（自定义二进制可用 WEMIND_BRAIN_BIN 或 brain set --bin 指定）`;
  if (ag.requestedKey === "auto" && !ag.available)
    return `自动探测未找到可用的大脑（已试：${AUTO_PROBE_ORDER.join("、")}）。请安装其中之一，或运行 \`wemind brain set <agent 名>\``;
  if (!ag.available) {
    const hint = ADAPTER_INSTALL_HINT[ag.name];
    if (hint)
      return `找不到大脑「${ag.name}」的适配器「${ag.bin}」。先装适配器：${hint}；装完仍找不到就 \`wemind brain set ${ag.name} --bin "<绝对路径>"\` 指定它。`;
    return ag.name === "deepseek"
      ? `找不到 DeepSeek 的「${ag.bin}」。桌面端通常有 dsh.cmd；把它的绝对路径传给 \`wemind brain set deepseek --bin "<...>\\dsh.cmd"\``
      : ag.name === "qoder"
        ? `找不到 Qoder CLI 的「${ag.bin}」。官方安装会放在 ~/.qoder/bin/qodercli/ 并加入 PATH；确认后重开终端，或 \`wemind brain set qoder --bin "<...>\\qodercli.exe"\``
        : ag.name === "cline"
          ? `找不到 Cline CLI 的「${ag.bin}」。安装：\`npm i -g cline\`（Node 20+），装完后重开终端；或用 \`wemind brain set cline --bin "<...>\\cline.cmd"\``
          : `找不到大脑「${ag.name}」的二进制「${ag.bin}」。安装它，或运行 \`wemind brain set <agent 名>\` 切换`;
  }
  // 适配器已装、但它依赖的运行时没装（如 pi-acp 找到了、pi 本体不在 PATH）：
  // 提前说清楚，别等 session/new 才抛一句适配器的内部错误。
  const missingRuntime = ag.requiresBins.filter((b) => !onPathAny(b));
  if (missingRuntime.length) {
    const hint = ADAPTER_INSTALL_HINT[ag.name];
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
  if (agentName !== "cline") return "";
  if (!/authentication required|authenticate|unauthorized|not authenticated/i.test(message))
    return "";
  return "Cline 的 ACP 只自动恢复 cline / cline-pass / openai-codex 三种登录；用自定义 provider（如 openai-compatible）时，请在启动 wemind 的环境里设置 CLINE_PROVIDER 与 CLINE_API_KEY（设置后重启一次 daemon）。";
}
