import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { agentConfigFor, type AgentRole, type BrainConfig } from "./brain-config.js";

/**
 * ACP agent 预设与解析。
 *
 * WeMind 的大脑通过**标准 ACP（Agent Client Protocol，JSON-RPC over stdio）**驱动一个 agent CLI。ACP 是通用协议（kiro-cli、gemini-cli 等都支持），因此接入任意兼容 ACP 的 agent 不需要改协议代码——只需告诉我们三件事：① 二进制名；② 进入 ACP 模式的启动参数；③ 该 agent 读取「配置/数据目录」的环境变量名（我们把它指向 brain 沙箱）。
 *
 * 选择与覆盖（优先级从高到低）：
 *  ① 环境变量（一次性覆盖；临时试别的 agent 用它，别写进 profile）：
 *  - `WEMIND_BRAIN`            选「对话大脑」预设（默认 `auto`：自动探测已安装的预设，见 AUTO_PROBE_ORDER）
 *  - `WEMIND_WORKER_BRAIN`     选「任务 worker」预设（未设则回落 `WEMIND_BRAIN`；与文件侧 `worker ?? 顶层` 的回退规则对称）
 *  - `WEMIND_BRAIN_BIN`        覆盖二进制（绝对路径或 PATH 上的名字）
 *  - `WEMIND_BRAIN_ARGS`       覆盖启动参数（空格分隔）
 *  - `WEMIND_BRAIN_HOME_ENV`   覆盖「配置目录环境变量名」
 *  - `WEMIND_BRAIN_SHELL`      是否经 shell 启动（1/true）
 *  - `WEMIND_BRAIN_INHERIT`    是否继承真实配置目录的记忆/规则（默认 1；0 关闭）
 *  - `WEMIND_BRAIN_REAL_HOME`  覆盖被继承的真实配置目录（默认取预设 realHome）
 *  - `WEMIND_BRAIN_INHERIT_DIRS` 覆盖继承的子目录清单（逗号/空格分隔）
 *  - `KIRO_CLI_BIN`            旧的 kiro 专用覆盖（仅 kiro 预设、且未设 WEMIND_BRAIN_BIN 时仍生效）
 *  ② 账号级持久配置（`<数据目录>/brain.json`，见 brain-config.ts）：顶层 = 对话大脑，`worker` 段 = 任务 worker（缺省跟随顶层）；每段可带 `agent` / `bin` / `args` / `shell` / `homeEnvVar`，另有按 agent 名存启动覆盖的 `presets` 段。写入磁盘后任何入口重启都能复现，切换用 `wemind brain set <agent 名>`。
 *  ③ `auto`（未配置时的兜底）：按 AUTO_PROBE_ORDER 取第一个二进制可解析的预设；一个都没有则标记 unavailable，由启动校验明确报错（不再「静默跑起来、第一条消息才炸」）。
 *  另：未知的 `WEMIND_BRAIN` 值不再静默回退 kiro，而是 `known:false`，交由启动校验报错。
 *
 * 角色（role）：同一份预设表既是「对话大脑」也是「任务 worker」的来源；`resolveAgent()` = 对话大脑，
 * `resolveAgentFor(cfg, "worker")` = 任务 worker。命令驱动的切换用 `resolvePresetByName()` —— 它**绕开环境变量**，
 * 否则用户点了切换、env 却压着它，会出现「看着成功、实际没生效」。
 */

export type AcpAgentPreset = {
  name: string;
  bin: string; // PATH 上的二进制名（非 Windows）
  binWin?: string; // Windows 下可执行名（默认在 bin 后加 .exe）
  fallbackBinPaths?: string[]; // PATH 上找不到时的已知安装位置（如官方安装器的固定目录）
  args: string[]; // 进入 ACP 模式的启动参数
  homeEnvVar?: string; // agent 读取其配置/数据目录的环境变量名；指向 brain 沙箱。留空=不设置
  shell?: boolean; // 是否经 shell 启动（npx/.cmd/.bat 类适配器在 Windows 需要 true）
  // —— 继承「记忆/规则/技能」配置（让微信大脑与日常使用读到同样内容）——
  realHome?: string; // 该 agent 真实配置目录（被继承的来源）。不同 agent 布局不同，故下沉到预设
  inheritDirs?: string[]; // 从 realHome junction 进沙箱的「知识/记忆」类子目录（不含 MCP/会话目录）
  inheritFiles?: string[]; // 从 realHome 拷进沙箱配置目录的「单文件」记忆（如 AGENTS.md；目录式记忆用 inheritDirs）
  // —— 沙箱约定（不同 agent 的配置目录位置与 MCP 文件格式不同）——
  configSubdir?: string; // agent 配置目录相对沙箱根的子路径（kiro 空=沙箱根；opencode "opencode"）
  mcpFormat?: "kiro" | "opencode"; // MCP 配置文件的组织格式（默认 kiro）
  mcpConfigFile?: string; // MCP 配置文件相对「配置目录」的路径（默认 settings/mcp.json）
  catalogFile?: string; // 可选 MCP 目录来源文件相对 realHome 的路径（默认 settings/mcp.json）
  env?: Record<string, string>; // 额外注入的环境变量；值里 %HOME% → 沙箱根目录
  // —— 协议/能力差异（按 agent 覆盖；默认保持 kiro/opencode 旧行为）——
  restore?: "load" | "resume"; // 恢复会话的方式：load（默认）或 resume（如 DSH）
  firstFrameMs?: number; // 首帧超时覆盖（默认 25s；慢启动/committed-only agent 可放宽）
  heartbeatMs?: number; // 静默期心跳间隔覆盖（默认 15s；有 thought/tool/usage 帧的 agent 通常不需要）
  images?: boolean; // 是否接受图片输入（默认 true；DSH 官方 0.2.1-rc.2 为 false）
  credentialFiles?: string[]; // 需要从 realHome 同步进沙箱的凭据文件（相对配置目录；新者胜）
  identityFiles?: string[]; // 必须与 realHome 保持一致的标识文件（相对配置目录；内容不同即覆盖）
  settingsBase?: string; // 以 realHome 下该文件为基底生成沙箱设置（剥离 MCP/插件/自定义供应商并关自动更新）
  model?: string; // 需要 session/set_config_option 选择的模型值（如 DSH 的 ["deepseek-account","deepseek-flash"]）
  mcpViaAcp?: boolean; // MCP 走 ACP session/new|resume 的 mcpServers（不写配置文件；如 DSH）
};

/**
 * 已知 ACP agent 预设。
 * - `kiro` 为默认且**已实测**。
 * - 其余均为**示例（未实测）**：参数/包名以各自官方为准，接入前请核对（见 docs/接入其它-ACP-Agent.md）。
 * - 区别两类：① **原生 ACP**（CLI 自带 ACP 模式，直接起，如 kiro、gemini）；② **需适配器**（CLI 本身不说 ACP，要起一个适配器进程，如 Claude Code、Codex）。
 */
export const ACP_AGENT_PRESETS: Record<string, AcpAgentPreset> = {
  // —— 原生 ACP ——
  kiro: {
    name: "kiro",
    bin: "kiro-cli",
    binWin: "kiro-cli.exe",
    args: ["acp", "--trust-all-tools"],
    homeEnvVar: "KIRO_HOME",
    realHome: path.join(os.homedir(), ".kiro"),
    inheritDirs: ["steering", "memories", "skills", "agents", "powers", "tasks", "extensions"],
  },
  // Gemini CLI 实验性 ACP（未实测，flag 以官方为准）。注：Gemini 的「记忆」是 ~/.gemini/GEMINI.md 等文件而非目录，与 kiro 的目录式不同，故未预置 inheritDirs；需要时按其布局用 WEMIND_BRAIN_REAL_HOME/_INHERIT_DIRS 配置或填此处。
  gemini: {
    name: "gemini",
    bin: "gemini",
    binWin: "gemini.cmd",
    args: ["--experimental-acp"],
    homeEnvVar: "GEMINI_CLI_HOME",
    shell: true,
  },
  // OpenCode：原生 ACP（`opencode acp`）。
  // - Windows 上是 npm shim（PATH 只有 opencode.cmd），故 shell:true + 裸名 binWin。
  // - 配置目录走 XDG_CONFIG_HOME（指向沙箱 → 配置落在 <沙箱>/opencode/），可真正替换默认 global 目录实现隔离；（OPENCODE_CONFIG_DIR 只「追加」不替换 global，无法隔离，故不用它。）
  // - MCP 配置文件是 opencode.json 的 mcp.servers（格式与 kiro 的 settings/mcp.json 不同）。
  // - 记忆/技能为目录式 skills/agents/commands + 单文件 AGENTS.md。
  // 详见 docs/接入-OpenCode.md（含 M1 实测）。
  opencode: {
    name: "opencode",
    bin: "opencode",
    binWin: "opencode",
    args: ["acp"],
    shell: true,
    homeEnvVar: "XDG_CONFIG_HOME",
    realHome: path.join(os.homedir(), ".config", "opencode"),
    inheritDirs: ["skills", "agents", "commands"],
    inheritFiles: ["AGENTS.md"],
    configSubdir: "opencode",
    mcpFormat: "opencode",
    mcpConfigFile: "opencode.json",
    catalogFile: "opencode.json",
    env: { OPENCODE_DISABLE_PROJECT_CONFIG: "1" }, // 不从 cwd 祖先目录发现用户 opencode.json
  },
  // DeepSeek Harness（官方 ACP profile）。
  // - 桌面端自带 `dsh.cmd`（只有 .cmd，没有无扩展名 dsh），故 binWin 必须写全；
  // - DSH_HOME 指向 brain 沙箱；`.credentials.yaml` 由沙箱同步（桌面登录态，对应 deepseek-account 路由）；
  // - 无 session/load，用 session/resume；image:false（收图需上层拦截）；
  // - 默认模型路由是 deepseek-official（需 API key），这里显式选 deepseek-account 才能复用桌面登录。
  // 详见 docs/接入-DeepSeek.md（含 0.2.1-rc.2 真机实测）。
  deepseek: {
    name: "deepseek",
    bin: "dsh",
    binWin: "dsh.cmd",
    args: ["--profile", "acp"],
    shell: true,
    homeEnvVar: "DSH_HOME",
    realHome: path.join(os.homedir(), ".dsh"),
    inheritDirs: ["skills"],
    inheritFiles: ["AGENTS.md"],
    credentialFiles: [".credentials.yaml"],
    restore: "resume",
    firstFrameMs: 60_000,
    heartbeatMs: 60_000,
    images: false,
    model: '["deepseek-account","deepseek-flash"]',
    mcpViaAcp: true, // 不写 mcp.json；激活集转成 ACP mcpServers 传给 session/new|resume
  },

  // Qoder CLI（官方原生 ACP，qodercli 1.1.78 实测）。
  // - 直接起 qodercli.exe：`qoder` 是分发器（cmd → powershell → qodercli），多一层管道且会与 IDE 命令混淆；
  // - QODER_CONFIG_DIR 指向 <沙箱>/qoder：与 Qoder Desktop 共用的 ~/.qoder 绝不写入；
  // - 登录态要 .auth/user + .auth/machine_id 两个文件（只带 user 会 Authentication required）；
  // - MCP 在 settings.json 的 mcpServers（与其它设置同文件），改后需重启进程 → 加载/卸载 MCP 的 restart 已覆盖；
  // - --yolo 下工具调用不发反向请求；capabilities 有 load/resume/image；
  // - providers（BYOK，含明文密钥）与 model 不继承，见 docs/接入-Qoder.md §5。
  qoder: {
    name: "qoder",
    bin: "qodercli",
    binWin: "qodercli.exe",
    // 官方安装器的固定位置；pm2/服务里 PATH 可能不含它，故直接兜底
    fallbackBinPaths:
      process.platform === "win32"
        ? [path.join(os.homedir(), ".qoder", "bin", "qodercli", "qodercli.exe")]
        : [],
    args: ["--acp", "--yolo"],
    env: { QODER_CONFIG_DIR: `%HOME%${path.sep}qoder` },
    realHome: path.join(os.homedir(), ".qoder"),
    // memory/ 是 Qoder agent 的用户画像/偏好记忆（实测存在），与日常使用共用一份（junction）；skills/agents/commands/AGENTS.md 在 Qoder 1.1.78 的本机不存在 → 当前为空操作，保留以便上游新增后自动生效
    inheritDirs: ["memory", "skills", "agents", "commands"],
    inheritFiles: ["AGENTS.md"],
    configSubdir: "qoder",
    mcpFormat: "kiro",
    mcpConfigFile: "settings.json",
    catalogFile: "settings.json",
    settingsBase: "settings.json",
    credentialFiles: [".auth/user"],
    identityFiles: [".auth/machine_id"],
  },

  // —— 需适配器（CLI 不原生支持 ACP，经第三方适配器桥接；未实测）——
  // Claude Code：Zed 官方适配器 @zed-industries/claude-code-acp（npx 运行；需 Claude Code 登录/ANTHROPIC_API_KEY）
  "claude-code": {
    name: "claude-code",
    bin: "npx",
    binWin: "npx.cmd",
    args: ["-y", "@zed-industries/claude-code-acp"],
    shell: true,
  },
  // Codex：社区适配器 codex-acp（agentclientprotocol/codex-acp，需自行安装其二进制；Codex 本身暂不原生支持 ACP）
  codex: { name: "codex", bin: "codex-acp", binWin: "codex-acp.exe", args: [] },
};

function onPath(exe: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  return null;
}

/**
 * `auto` 的探测顺序：按序取第一个「二进制能在 PATH 上解析到」的预设。
 * 只收纳**原生 ACP 且二进制可直接判定**的预设——适配器类（`claude-code` 走 `npx`、`codex` 走 `codex-acp`）不参与自动探测（`npx` 几乎总在 PATH 上，会把它们误选出来）。
 */
export const AUTO_PROBE_ORDER = ["kiro", "opencode", "gemini", "deepseek", "qoder"] as const;

/** 预设在该平台的「可执行文件名」（用于 PATH 探测）。 */
function presetExe(preset: AcpAgentPreset): string {
  return process.platform === "win32" ? (preset.binWin ?? `${preset.bin}.exe`) : preset.bin;
}

/**
 * 预设的二进制是否能在 PATH 上解析到（只判定、不启动）。
 * 传入 cfg 时，`presets[名].bin` 里存的绝对路径也算「可用」——否则桌面端 DSH 这种「装了但不在 PATH」的预设，auto 探测会白白跳过它。
 */
export function presetAvailable(key: string, cfg?: BrainConfig | null): boolean {
  const preset = ACP_AGENT_PRESETS[key];
  if (!preset) return false;
  const ovBin = cfg?.presets?.[key.toLowerCase()]?.bin;
  if (ovBin) return locateBin(ovBin) !== null;
  return onPath(presetExe(preset)) !== null;
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

/** daemon 因「大脑配置错误」退出时用的退出码；看护进程据此停止自动重启（配置错误需人工修，重拉无益）。 */
export const BRAIN_CONFIG_EXIT_CODE = 78;

export type ResolvedAgent = {
  name: string;
  bin: string;
  args: string[];
  homeEnvVar?: string;
  shell: boolean;
  inherit: boolean;
  realHome?: string;
  inheritDirs: string[];
  inheritFiles: string[];
  configSubdir: string;
  mcpFormat: "kiro" | "opencode";
  mcpConfigFile: string;
  catalogFile: string;
  env: Record<string, string>;
  restore?: "load" | "resume";
  firstFrameMs?: number;
  heartbeatMs?: number;
  images: boolean;
  credentialFiles: string[];
  identityFiles: string[];
  settingsBase?: string;
  model?: string;
  mcpViaAcp: boolean;
  /** 请求的原始值（来自 env / brain.json / 缺省 `auto`）。 */
  requestedKey: string;
  /** `requestedKey` 的来源。 */
  source: "env" | "file" | "auto";
  /** `requestedKey` 是否为已知预设（未知 → false，不再静默回退 kiro）。 */
  known: boolean;
  /** 二进制是否解析到了实际文件（找不到 → false）。 */
  available: boolean;
  /** 解析到的二进制绝对路径（`available` 时才有）。 */
  binPath: string | null;
};

/** 该角色「选预设」的环境变量：worker 先看 `WEMIND_WORKER_BRAIN`，未设则回落 `WEMIND_BRAIN`。 */
function envKeyFor(role: AgentRole): string | undefined {
  const key =
    role === "worker"
      ? process.env.WEMIND_WORKER_BRAIN?.trim() || process.env.WEMIND_BRAIN?.trim()
      : process.env.WEMIND_BRAIN?.trim();
  return key || undefined;
}

/**
 * 解析某角色要用的 ACP agent（核心实现，见文件头注释的三级优先级）。
 * 覆盖优先级：环境变量 > 本角色那段自带 > `presets[<agent 名>]` > 预设默认。
 * `ignoreEnv`：命令驱动的切换（`resolvePresetByName`）必须绕开 `WEMIND_BRAIN*`，否则会出现「点了切换、env 却压着它」的假成功。
 */
function resolveAgentCore(
  role: AgentRole,
  cfg: BrainConfig | null,
  opts: { ignoreEnv?: boolean } = {},
): ResolvedAgent {
  const envKey = opts.ignoreEnv ? undefined : envKeyFor(role);
  const roleCfg = agentConfigFor(cfg, role);
  const fileKey = roleCfg?.agent?.trim();
  const requestedKey = (envKey || fileKey || "auto").toLowerCase();
  const source: ResolvedAgent["source"] = envKey ? "env" : fileKey ? "file" : "auto";

  // 选预设：auto → 探测第一个可用；未知值 → 标 known:false（结构上退回 kiro 兜底，交启动校验报错）。
  let known = true;
  let key = requestedKey;
  if (key === "auto") {
    key = AUTO_PROBE_ORDER.find((k) => presetAvailable(k, cfg)) ?? "kiro";
  } else if (!ACP_AGENT_PRESETS[key]) {
    known = false;
    key = "kiro";
  }
  const preset = ACP_AGENT_PRESETS[key];
  // 按 agent 名存的启动覆盖：无论谁在用这个 agent 都适用（顶层覆盖只属于「写入磁盘那个 agent」，切走后不该跟过去）。
  const presetOv = cfg?.presets?.[key];

  // roleCfg 的 bin/args/shell/homeEnvVar 是**给该段所写那个 agent** 的启动覆盖；环境变量临时切到别的预设时不能沿用（否则会拿 deepseek 的 dsh.cmd 去起 qoder）。
  const overrideCfg =
    envKey && roleCfg?.agent?.trim() && roleCfg.agent.trim().toLowerCase() !== requestedKey
      ? null
      : roleCfg;

  const shellEnv = opts.ignoreEnv ? undefined : process.env.WEMIND_BRAIN_SHELL?.trim();
  const shell =
    shellEnv !== undefined && shellEnv !== ""
      ? shellEnv === "1" || shellEnv.toLowerCase() === "true"
      : (overrideCfg?.shell ?? presetOv?.shell ?? preset.shell ?? false);

  // 二进制：env 覆盖 > (kiro 旧变量) > 本段覆盖 > presets[agent 名] 覆盖 > PATH 解析 > 预设裸名。
  // 经 shell 启动时用裸名（让 shell 从 PATH 解析，避免带空格的全路径在 shell 下出问题）。
  const envBin = opts.ignoreEnv ? undefined : process.env.WEMIND_BRAIN_BIN?.trim();
  const kiroBin =
    opts.ignoreEnv || preset.name !== "kiro" ? undefined : process.env.KIRO_CLI_BIN?.trim();
  const explicitBin = envBin || kiroBin || overrideCfg?.bin?.trim() || presetOv?.bin?.trim() || "";
  const exe = presetExe(preset);
  const binPath = explicitBin
    ? locateBin(explicitBin)
    : (onPath(exe) ?? (preset.fallbackBinPaths ?? []).find((p) => fs.existsSync(p)) ?? null);
  const bin =
    explicitBin ||
    (shell ? (process.platform === "win32" ? exe : preset.bin) : binPath || preset.bin);
  const available = known && binPath !== null;

  const argsOverride = opts.ignoreEnv ? undefined : process.env.WEMIND_BRAIN_ARGS?.trim();
  const args = argsOverride
    ? argsOverride.split(/\s+/)
    : overrideCfg?.args && overrideCfg.args.length
      ? overrideCfg.args
      : presetOv?.args && presetOv.args.length
        ? presetOv.args
        : preset.args;

  const homeEnvVar =
    (opts.ignoreEnv ? undefined : process.env.WEMIND_BRAIN_HOME_ENV?.trim()) ||
    overrideCfg?.homeEnvVar?.trim() ||
    presetOv?.homeEnvVar?.trim() ||
    preset.homeEnvVar;

  // 继承「记忆/规则/技能」：来源目录与子目录清单按 agent 而异（下沉到预设），env 可覆盖
  const inherit =
    (process.env.WEMIND_BRAIN_INHERIT ?? process.env.WECHAT_BRAIN_INHERIT ?? "1") !== "0";
  const realHome =
    process.env.WEMIND_BRAIN_REAL_HOME?.trim() ||
    process.env.WECHAT_REAL_KIRO_HOME?.trim() ||
    preset.realHome;
  const dirsEnv = process.env.WEMIND_BRAIN_INHERIT_DIRS?.trim();
  const inheritDirs = dirsEnv
    ? dirsEnv.split(/[,\s]+/).filter(Boolean)
    : (preset.inheritDirs ?? []);

  return {
    name: preset.name,
    bin,
    args,
    homeEnvVar,
    shell,
    inherit,
    realHome,
    inheritDirs,
    inheritFiles: preset.inheritFiles ?? [],
    configSubdir: preset.configSubdir ?? "",
    mcpFormat: preset.mcpFormat ?? "kiro",
    mcpConfigFile: preset.mcpConfigFile ?? "settings/mcp.json",
    catalogFile: preset.catalogFile ?? "settings/mcp.json",
    env: preset.env ?? {},
    restore: preset.restore,
    firstFrameMs: preset.firstFrameMs,
    heartbeatMs: preset.heartbeatMs,
    images: preset.images ?? true,
    credentialFiles: preset.credentialFiles ?? [],
    identityFiles: preset.identityFiles ?? [],
    settingsBase: preset.settingsBase,
    model: preset.model,
    mcpViaAcp: preset.mcpViaAcp ?? false,
    requestedKey,
    source,
    known,
    available,
    binPath,
  };
}

/** 解析当前要用的**对话大脑**：环境变量 > 账号 brain.json 顶层 > auto。 */
export function resolveAgent(cfg?: BrainConfig | null): ResolvedAgent {
  return resolveAgentCore("brain", cfg ?? null);
}

/** 解析某**角色**要用的 ACP agent：`brain` = 对话大脑（同 resolveAgent），`worker` = 任务 worker（`worker` 段 > 顶层）。 */
export function resolveAgentFor(
  cfg: BrainConfig | null | undefined,
  role: AgentRole,
): ResolvedAgent {
  return resolveAgentCore(role, cfg ?? null);
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
): { ok: true; agent: ResolvedAgent } | { ok: false; problem: string } {
  const key = (name ?? "").trim().toLowerCase();
  if (!key) return { ok: false, problem: "需要指定 agent 名（或 `auto` 重新自动探测）。" };
  const base: BrainConfig = { agent: key, presets: cfg?.presets };
  // 顶层启动覆盖只属于「写入磁盘那个 agent」：目标就是它时带上（例如 `brain set deepseek --bin …` 后切回 deepseek）。
  if (cfg?.agent?.trim().toLowerCase() === key) {
    if (cfg.bin) base.bin = cfg.bin;
    if (cfg.args?.length) base.args = cfg.args;
    if (cfg.shell !== undefined) base.shell = cfg.shell;
    if (cfg.homeEnvVar) base.homeEnvVar = cfg.homeEnvVar;
  }
  const agent = resolveAgentCore("brain", base, { ignoreEnv: true });
  const problem = agentProblem(agent);
  return problem ? { ok: false, problem } : { ok: true, agent };
}

/**
 * 校验解析后的大脑是否可用：可用返回 null，否则返回一句面向用户的说明。
 * 供 daemon 启动校验（早失败、说人话）与 `wemind brain` / `wemind brain check` 复用。
 */
export function agentProblem(ag: ResolvedAgent): string | null {
  if (!ag.known)
    return `未知 agent「${ag.requestedKey}」。可选：${Object.keys(ACP_AGENT_PRESETS).join("、")}（自定义二进制可用 WEMIND_BRAIN_BIN 或 brain set --bin 指定）`;
  if (ag.requestedKey === "auto" && !ag.available)
    return `自动探测未找到可用的大脑（已试：${AUTO_PROBE_ORDER.join("、")}）。请安装其中之一，或运行 \`wemind brain set <agent 名>\``;
  if (!ag.available)
    return ag.name === "deepseek"
      ? `找不到 DeepSeek 的「${ag.bin}」。桌面端通常有 dsh.cmd；把它的绝对路径传给 \`wemind brain set deepseek --bin "<...>\\dsh.cmd"\``
      : ag.name === "qoder"
        ? `找不到 Qoder CLI 的「${ag.bin}」。官方安装会放在 ~/.qoder/bin/qodercli/ 并加入 PATH；确认后重开终端，或 \`wemind brain set qoder --bin "<...>\\qodercli.exe"\``
        : `找不到大脑「${ag.name}」的二进制「${ag.bin}」。安装它，或运行 \`wemind brain set <agent 名>\` 切换`;
  return null;
}
