/**
 * ACP agent 预设表（数据）。
 *
 * 接一个新 agent 只需要改这个文件：条目描述 agent 的事实（二进制、启动参数、配置目录、能力差异），
 * 不含解析/探测逻辑——那些在 brain-agents.ts。
 */
import path from "node:path";
import os from "node:os";

import { clineCredentialEnv } from "./cline-credentials.js";

export type AcpAgentPreset = {
  name: string;
  bin: string; // PATH 上的二进制名（非 Windows）
  binWin?: string; // Windows 下可执行名（默认在 bin 后加 .exe）
  fallbackBinPaths?: string[]; // PATH 上找不到时的已知安装位置（如官方安装器的固定目录）
  requiresBins?: string[]; // 除 bin 外还必须在 PATH 上解析到的运行时（如 pi-acp 内部 spawn `pi`；只装适配器不够）
  args: string[]; // 进入 ACP 模式的启动参数
  homeEnvVar?: string; // agent 读取其配置/数据目录的环境变量名；指向配置视图（real/mirror）或账号沙箱（sandbox）。留空=不设置（real/mirror 直接用真实 home，WeMind 只读不写）
  /** 配置目录之外、但属于该 agent 的文件（如 Claude Code 的 ~/.claude.json）；target 相对视图根。 */
  extraConfigFiles?: Array<{ source: string; target: string }>;
  shell?: boolean; // 是否经 shell 启动（npx/.cmd/.bat 类适配器在 Windows 需要 true）
  // —— 继承「记忆/规则/技能」配置（让微信大脑与日常使用读到同样内容）——
  realHome?: string; // 该 agent 真实配置目录（生成视图/沙箱继承/配置指纹的来源）。不同 agent 布局不同，故下沉到 agent
  inheritDirs?: string[]; // sandbox 下从 realHome junction 进账号沙箱的「知识/记忆」类子目录（不含 MCP/会话目录）；real/mirror 的视图直接链接整个真实配置目录，不依赖此字段
  inheritFiles?: string[]; // sandbox 下从 realHome 拷进账号沙箱的「单文件」记忆（如 AGENTS.md）；目录式记忆用 inheritDirs。real/mirror 同上不依赖此字段
  // —— 沙箱约定（不同 agent 的配置目录位置与 MCP 文件格式不同）——
  configSubdir?: string; // agent 配置目录相对 home（配置视图根 / sandbox 根）的子路径（kiro 空=根本身；opencode "opencode"）
  mcpFormat?: "mcpServers" | "mcp.servers"; // MCP 定义的 JSON 键路径（默认 mcpServers）
  mcpConfigFile?: string; // MCP 配置文件相对「配置目录」的路径（默认 settings/mcp.json）
  catalogFile?: string; // 可选 MCP 目录来源文件相对 realHome 的路径（默认 settings/mcp.json）；WeMind 始终读真实 home 用于列目录/启动前检查，视图里的副本只给 agent 自己加载
  env?: Record<string, string>; // 额外注入的环境变量（强制；值里 %HOME% → home 目录（视图根 / sandbox 根））
  realEnv?: Record<string, string>; // 没有 homeEnvVar 的 agent 在 real/mirror 下直接用真实 home 时，覆盖 env 里按 %HOME% 拼出来的错误路径（如 CLAUDE_CONFIG_DIR / CLINE_DIR / QODER_CONFIG_DIR）
  envDefaults?: Record<string, string>; // 默认值：父进程已设同名变量时不覆盖。审批类开关（DSH_PERMISSION_MODE / INITIAL_AGENT_MODE）用它，部署方可用环境变量收紧权限
  credentialEnv?: (
    realHome: string | undefined,
    parentEnv: NodeJS.ProcessEnv,
  ) => Record<string, string>; // 从 agent 自己的凭据文件派生环境变量（仅父进程未显式提供时；如 Cline 自定义 provider 的 CLINE_PROVIDER/CLINE_API_KEY）
  // —— 协议/能力差异（按 agent 覆盖；默认保持 kiro/opencode 旧行为）——
  restore?: "load" | "resume"; // 恢复会话的方式：load（默认）或 resume（如 DSH）
  replayOnLoad?: boolean; // session/load|resume 返回后仍会异步回放历史帧（gemini 的 loadSession 里 streamHistory 不 await）：恢复后先等回放帧安静下来再提问，否则历史会被拼进本轮答复
  firstFrameMs?: number; // 首帧超时覆盖（默认 25s；慢启动/committed-only agent 可放宽）
  heartbeatMs?: number; // 静默期心跳间隔覆盖（默认 15s；有 thought/tool/usage 帧的 agent 通常不需要）
  images?: boolean; // 是否接受图片输入（默认 true；DSH 官方 0.2.1-rc.2 为 false）
  credentialFiles?: string[]; // sandbox 下需要从 realHome 同步进账号沙箱的凭据文件（相对配置目录；新者胜）；real/mirror 直接链接真实文件
  identityFiles?: string[]; // sandbox 下必须与 realHome 保持一致的标识文件（相对配置目录；内容不同即覆盖）
  settingsBase?: string; // 以 realHome 下该文件为基底生成视图/沙箱副本（剥离 MCP/插件/自定义供应商并关自动更新）；绝不写真实文件
  settingsStrip?: string[]; // settingsBase 基底里要删掉的键（默认见 DEFAULT_SETTINGS_STRIP；gemini 只删 mcpServers，保留 model/security）
  settingsDefaults?: Record<string, unknown>; // 视图/沙箱 settings.json 的默认键：副本里没有该键时补上（用户显式设过则保留用户的值；只改副本）
  model?: string; // 默认模型值（如 DSH 的 ["deepseek-account","deepseek-flash"]）：经 session/set_config_option（agent 自己的 ACP 接口）在会话建立后下发一次；可用 brain.json / `brain set --model` 覆盖，`auto` = 跟随默认；配了 realProfile 时默认值优先从真实 profile 读
  modelArg?: string; // 不支持 session/set_config_option 的 agent：模型改为追加到启动参数（如 gemini 的 "--model"），不再走 ACP 下发
  realProfile?: string; // 真实 home 里该 agent 的 profile 名（`profiles/<名>/cordis.patch.yml` 是用户/桌面端维护的用户层：沙箱**原样复制**、不追加条目，默认模型从它读——优先 `- id: acp`，否则 `agent-default-model`）；如 DSH 的 "acp"
  mcpViaAcp?: boolean; // MCP 走 ACP session/new|resume 的 mcpServers（不写配置文件；如 DSH）
  sessionMode?: string; // 会话建立/恢复后经 `session/set_mode` 切到的模式 id（agent 自己的 ACP 接口）；用于「免审批」模式：claude-code 的 bypassPermissions、codex 的 agent-full-access。留空=不调用
  kiroEngine?: boolean; // kiro：`acp` 的 v2 / v3 引擎启动参数与免审批方式不同（v2 `--trust-all-tools`；v3 用沙箱 settings/permissions.yaml 的 allow-all）
  isolateSessions?: boolean; // sandbox 下会话持久化 root 用 agent 自己的 `--patch` 指到账号数据目录（DSH：与同沙箱其他 agent 的会话文件分开，见 docs/接入-DeepSeek.md）；real/mirror 用 agent 自己的会话库
};

/** settingsBase 的默认剥离清单：MCP 必须由视图/沙箱的 curated 激活集权威决定（防 wechat 回环）；插件/自定义供应商可能自带 MCP 或明文密钥；model 可能指向已剥离的供应商。 */
export const DEFAULT_SETTINGS_STRIP = ["mcpServers", "enabledPlugins", "providers", "model"];

/**
 * 已知 ACP agent。
 * - 内置 10 个预设都**至少过了探针级实测**（kiro / opencode / deepseek / qoder / cline / gemini 另有真机使用或 E2E 记录）。
 * - 包名/参数/ACP 能力仍随上游版本变化：升级 agent 后按 docs/接入其它-ACP-Agent.md 复验；自定义 agent 需自行核对官方参数。
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
    kiroEngine: true,
  },
  // Gemini CLI（原生 ACP，0.66.0 已实测）。`--acp` 取代已弃用的 `--experimental-acp`；`--approval-mode yolo` 自动批准所有工具调用（与 `--yolo` 互斥，二选一）；`--skip-trust` 信任当前工作区——**未信任的目录会把 yolo 静默降回 default，并且连 MCP 都不加载**（用户级 server 也被抑制），所以必须带上（或用 GEMINI_CLI_TRUST_WORKSPACE=true）。
  // - 视图/沙箱：`GEMINI_CLI_HOME` 指向视图根/沙箱根，Gemini 的配置目录是 `<它>/.gemini`（实测），故 configSubdir=".gemini"；`~/.gemini` 的 skills/ 与 GEMINI.md 是它的全局技能与记忆。
  // - MCP：读配置目录 settings.json 的 `mcpServers`（kiro 格式）。ACP `session/new` 的 mcpServers 实测也能用，但 `initialize` 只声明 http/sse、不声明 acp——走它自己的配置文件更稳。
  // - 设置：以真实 settings.json 为基底（保留 model / security / ui），只剥 `mcpServers`（MCP 必须来自视图/沙箱 curated，防 wechat 回环），并关自动更新。认证走 `security.auth.selectedType`；API key 用户同步 `.env`（GEMINI_API_KEY / GOOGLE_GEMINI_BASE_URL），Google 登录用户同步 `oauth_creds.json` + `google_accounts.json`——settings 镜像了 `oauth-personal` 却缺 token 时，它会卡在登录流程、连 ACP initialize 都不回。
  // - 模型：不支持 `session/set_config_option`（-32601），`--model` 走启动参数（modelArg）；默认不传，跟随 settings.json 的 model.name。
  // - 恢复：loadSession=true、强杀后 session/load 能接回上下文；但 load 返回后它还会**异步回放历史**（streamHistory 不 await），replayOnLoad 让恢复后先等回放结束。
  // - `session/close` 未实现（-32601，WeMind 不调用）；图片实测可收；工具调用 0 反向请求。
  gemini: {
    name: "gemini",
    bin: "gemini",
    binWin: "gemini.cmd",
    args: ["--acp", "--approval-mode", "yolo", "--skip-trust"],
    homeEnvVar: "GEMINI_CLI_HOME",
    realHome: path.join(os.homedir(), ".gemini"),
    configSubdir: ".gemini", // GEMINI_CLI_HOME 是「家目录」，Gemini 在它下面建 .gemini/
    inheritDirs: ["skills"],
    inheritFiles: ["GEMINI.md"],
    mcpFormat: "mcpServers",
    mcpConfigFile: "settings.json",
    catalogFile: "settings.json",
    settingsBase: "settings.json",
    settingsStrip: ["mcpServers"],
    credentialFiles: [".env", "oauth_creds.json", "google_accounts.json"],
    modelArg: "--model",
    replayOnLoad: true,
    shell: true,
  },
  // GitHub Copilot CLI（原生 ACP，1.0.107 探针实测）。
  // - COPILOT_HOME 指向配置视图/sandbox；sandbox 下只同步 config.json 登录元数据、skills 与 copilot-instructions.md，不继承用户 MCP/插件/hooks；real/mirror 的视图会剔除微信 MCP（真实文件不动）。
  // - 用户 MCP 目录是 ~/.copilot/mcp-config.json；stdio MCP 经 session/new 实测可调用（尽管 initialize 只声明 http/sse）。
  // - --allow-all-tools 免除工具审批，但不启用 --allow-all 的路径/URL 放宽；默认 auto 不探测，避免「已安装但未登录」导致误选。
  copilot: {
    name: "copilot",
    bin: "copilot",
    binWin: "copilot.cmd",
    args: ["--acp", "--no-auto-update", "--allow-all-tools"],
    shell: true,
    homeEnvVar: "COPILOT_HOME",
    realHome: path.join(os.homedir(), ".copilot"),
    inheritDirs: ["skills"],
    inheritFiles: ["copilot-instructions.md"],
    credentialFiles: ["config.json"],
    catalogFile: "mcp-config.json",
    mcpViaAcp: true,
  },
  // OpenCode：原生 ACP（`opencode acp`）。
  // - Windows 上是 npm shim（PATH 只有 opencode.cmd），故 shell:true + 裸名 binWin。
  // - 配置目录走 XDG_CONFIG_HOME（指向视图根/sandbox 根 → 配置落在 <视图>/opencode 或 <沙箱>/opencode/），可真正替换默认 global 目录实现隔离；（OPENCODE_CONFIG_DIR 只「追加」不替换 global，无法隔离，故不用它。）
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
    mcpFormat: "mcp.servers",
    mcpConfigFile: "opencode.json",
    catalogFile: "opencode.json",
    env: { OPENCODE_DISABLE_PROJECT_CONFIG: "1" }, // 不从 cwd 祖先目录发现用户 opencode.json
  },
  // DeepSeek Harness（官方 ACP profile）。
  // - 桌面端自带 `dsh.cmd`（只有 .cmd，没有无扩展名 dsh），故 binWin 必须写全；
  // - DSH_HOME 指向配置视图/账号沙箱；`.credentials.yaml` 在 sandbox 下由账号沙箱同步（real/mirror 的视图直接链接真实文件）；
  // - 无 session/load，用 session/resume；image:false（收图需上层拦截）；
  // - **模型：跟着用户自己 dsh 的配置走（WeMind 只读；real 链接、sandbox 复制，不替 agent 合成配置）。** 桌面端或用户自己的配置工具把 provider 目录与默认模型写进 `~/.dsh/profiles/<profile>/cordis.patch.yml`。
  //   `dsh --profile acp` 的 ACP 桥插件（`@deepseek-ai/dsh-acp`）默认模型写死在它**自己的 bundle patch**里：`- id: acp` 的
  //   `config: { provider: deepseek-official, model: deepseek-v4-flash }`；profile 用户层只覆盖 `llm-pi-ai` / `agent-default-model` / `web-search-deepseek`，
  //   `- id: acp` 要靠**用户自己**补（插件 README：a later patch can replace that row's complete config）——这就是
  //   「agent-default-model 写着用户的默认、session/new 仍报 deepseek-official、一 prompt 就 no API key」的原因（2026-10-29 拆开 app.asar 核实）。
  //   所以 `realProfile: "acp"`：real 模式把整个 `profiles/` 链接真实 home；sandbox 模式才**原样复制**真实 profile 用户层（否则沙箱是空壳 `[]`，连用户自己的 provider 路由都没有；不追加条目），
  //   缺 `- id: acp` 时由 `wemind brain` 提示用户补到真实 profile（`acpOverrideHint`）；不少配置工具只写 `agent-default-model` / `web-search-deepseek`，`- id: acp` 仍要用户单独补。
  //   默认模型从这份配置读（优先 `- id: acp`，否则 `agent-default-model`）→ 用户日常用哪个模型，微信大脑就用哪个。
  // - 读不到时回退到下面的 `model`（deepseek-account/deepseek-flash：rc.2 的账号登录兜底；rc.3 已从模型目录移除，真被用到时只记 WARN，不拖垮回合）；
  //   显式换模型用 `wemind brain set deepseek --model "…"`，`--model auto` = 跟随真实 profile 的默认。
  //   `set_config_option`（agent 自己的 ACP 接口）在会话建立后按同一个值下发一次：幂等，也是显式覆盖的通道。
  // - 走哪个 provider、需要什么凭据/依赖（如自建网关是否在运行），都由用户的 DSH 配置自己决定；WeMind 只跟随 `- id: acp`（否则 `agent-default-model`）的值。
  // 详见 docs/接入-DeepSeek.md（含 0.2.1-rc.2 / 0.2.1-rc.3 真机实测）。
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
    realProfile: "acp",
    model: '["deepseek-account","deepseek-flash"]',
    mcpViaAcp: true, // 不写 mcp.json；激活集转成 ACP mcpServers 传给 session/new|resume
    isolateSessions: true, // `--patch` 把 session-persistence-jsonl.root 指到账号数据目录（见 docs/接入-DeepSeek.md）
    // 免审批：DSH 没有启动 flag，也没有会话级权限配置项；`DSH_PERMISSION_MODE` 是官方 bundle 读的默认值来源
    // （文档正文未收录，升级后若失效见 docs/接入-DeepSeek.md），取值 danger-full-access = 绕过文件沙箱、不产生提权请求。
    // 注意 `approval.policy: never` 是「不问并拒绝」，不能单独拿来放行——这里只用 danger-full-access。
    // 放在 envDefaults：daemon 进程里显式设了同名变量（如 workspace-write）时以用户为准（可收紧）。
    envDefaults: { DSH_PERMISSION_MODE: "danger-full-access" },
  },

  // Qoder CLI（官方原生 ACP，qodercli 1.1.78 实测）。
  // - 直接起 qodercli.exe：`qoder` 是分发器（cmd → powershell → qodercli），多一层管道且会与 IDE 命令混淆；
  // - QODER_CONFIG_DIR 指向视图/sandbox 的 qoder 子目录；real/mirror 下没有可重定向目录时 WeMind **只读** ~/.qoder（绝不写 settings.json）；
  // - 没有配置目录环境变量 → real/mirror 无法生成视图，微信侧 MCP/overlay 对该 agent 不生效（会告警），要生效请用 sandbox；
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
    realEnv: { QODER_CONFIG_DIR: "%HOME%" },
    realHome: path.join(os.homedir(), ".qoder"),
    // memory/ 是 Qoder agent 的用户画像/偏好记忆（实测存在），与日常使用共用一份（junction）；skills/agents/commands/AGENTS.md 在 Qoder 1.1.78 的本机不存在 → 当前为空操作，保留以便上游新增后自动生效
    inheritDirs: ["memory", "skills", "agents", "commands"],
    inheritFiles: ["AGENTS.md"],
    configSubdir: "qoder",
    mcpFormat: "mcpServers",
    mcpConfigFile: "settings.json",
    catalogFile: "settings.json",
    settingsBase: "settings.json",
    credentialFiles: [".auth/user"],
    identityFiles: [".auth/machine_id"],
  },

  // Cline CLI（官方原生 ACP，cline 3.0.74 实测；`cline-acp` 适配器已归档，官方让直接用 `cline --acp`）。
  // - `CLINE_DIR` 指到 <视图根或沙箱根>/cline（不用根目录：大脑 cwd 可能就是它，避免把 agent 自己的配置目录当工作区）；
  // - 登录态：ACP 只自动恢复它自己的 3 种登录（cline / cline-pass / openai-codex，读 data/settings/providers.json）；
  //   自定义/API-key provider（如 openai-compatible）必须由 daemon 进程环境提供 CLINE_PROVIDER + CLINE_API_KEY，
  //   否则 session/new 直接 `-32000 Authentication required`（Cline 不会去看 lastUsedProvider）；
  // - MCP：data/settings/cline_mcp_settings.json（{mcpServers}，与 kiro 同格式）；视图/沙箱用 CLINE_MCP_SETTINGS_PATH 指到
  //   <视图或沙箱>/cline/mcp.json，真实文件不动。real/mirror 下没有视图时**连 mcp.json 也不写**（只读真实配置）；
  // - 免审批：`--auto-approve true`（Cline 自己文档给的 ACP 启动开关）；WeMind 侧权限应答器仍默认拒绝权限请求；
  // - 能力：loadSession / images 可用，重启后 session/load 能接回上下文；session/close 未实现（-32601，WeMind 不调用）。
  cline: {
    name: "cline",
    bin: "cline",
    binWin: "cline.cmd",
    args: ["--acp", "--auto-approve", "true"],
    shell: true,
    // 3.0.74 实测：initialize 声明 image:true，但 ACP prompt 的 de() 只保留 text 块（image 被直接丢弃），
    // 模型只会看到「用户发来一张图片」的文字提示。按「实际不支持」处理，让 daemon 友好拒绝而不是让模型猜。
    images: false,
    env: {
      CLINE_DIR: `%HOME%${path.sep}cline`,
      CLINE_DATA_DIR: `%HOME%${path.sep}cline${path.sep}data`,
      CLINE_MCP_SETTINGS_PATH: `%HOME%${path.sep}cline${path.sep}mcp.json`,
    },
    realEnv: {
      CLINE_DIR: "%HOME%",
      CLINE_DATA_DIR: `%HOME%${path.sep}data`,
      CLINE_MCP_SETTINGS_PATH: `%HOME%${path.sep}mcp.json`,
    },
    realHome: path.join(os.homedir(), ".cline"),
    // 用户级规则/技能/agent 定义与日常 Cline 共用一份；hooks/plugins 不继承（插件可自带 MCP，沙箱不允许 wechat 之外的意外入口）
    inheritDirs: ["rules", "skills", "agents"],
    configSubdir: "cline",
    mcpFormat: "mcpServers",
    mcpConfigFile: "mcp.json",
    catalogFile: "data/settings/cline_mcp_settings.json",
    // providers.json：登录态（OAuth / API-key）；models.json：provider 的模型目录缓存——
    // 缺它时 Cline 的 session/new 会回退到 gpt-4o（自定义 provider 下 prompt 直接报「knows no model "gpt-4o"」）
    credentialFiles: ["data/settings/providers.json", "data/settings/models.json"],
    // 自定义/API-key provider：Cline ACP 不读 providers.json 的 lastUsedProvider，按官方 ACP 逃生口补 env
    // （父进程显式设了 CLINE_PROVIDER/CLINE_API_KEY 时完全不接管；OAuth 条目没有 apiKey，返回空）
    credentialEnv: clineCredentialEnv,
  },

  // —— 需适配器（CLI 不原生支持 ACP，经官方/第三方适配器桥接）——
  // pi coding agent（@earendil-works/pi-coding-agent）经社区适配器 pi-acp 接入：适配器 spawn `pi --mode rpc`，在 ACP 与 pi RPC 之间桥接。
  // 2026-10-30 探针 + 2026-11-01 复跑（pi-acp 0.0.34 + pi 1.4.0，见 docs/接入-pi.md）：
  // - session/load 原生支持（强杀后上下文接上）；image:true；首帧 0–3ms；有 thought/tool 帧；无反向请求——pi 默认不做逐次工具审批（官方 security.md 明说），无需 yolo flag / sessionMode；
  // - 模型跟随用户 pi 配置（settings.json 的 defaultProvider/defaultModel；sandbox 下随凭据原样同步，real/mirror 链接真实目录）；覆盖用 `wemind brain set pi --model "<provider>/<model>"`（session/set_config_option 的 configId 就叫 model）；
  // - MCP：pi 读 <PI_CODING_AGENT_DIR>/mcp.json（`pi mcp list` 实测；不是 settings/mcp.json），格式与 kiro 相同 {mcpServers:{名:{command,args,env}}}；不设 mcpViaAcp（pi-acp 只把 mcpServers 存进会话、从不读取）；
  // - 适配器只是桥：真正进程是 PATH 上的 pi 本体（requiresBins 会在缺 pi 时提前报错，而不是等 session/new 才炸）。
  // - 适配器的会话映射表固定写在真实 home 的 ~/.pi/pi-acp/session-map.json（不随视图/沙箱走）：跨账号共享的只是 id→会话文件的映射，会话本体仍在各自 home（real/mirror 是真实 ~/.pi/agent/sessions，sandbox 是账号沙箱副本）的 sessions/ 下。
  // - 适配器类不参与 auto 探测（装好适配器 ≠ 已登录/配好模型），用 `wemind brain set|switch pi` 显式选用。
  pi: {
    name: "pi",
    bin: "pi-acp",
    binWin: "pi-acp.cmd", // npm 全局 shim 只有 .cmd，onPath 按精确文件名判定
    requiresBins: ["pi"], // pi-acp 内部 spawn `pi --mode rpc`；只装适配器不够
    args: [],
    shell: true,
    homeEnvVar: "PI_CODING_AGENT_DIR", // pi 的配置目录 env（默认 ~/.pi/agent）→ 指向视图根/沙箱根
    realHome: path.join(os.homedir(), ".pi", "agent"),
    inheritDirs: ["skills"],
    inheritFiles: ["AGENTS.md"], // pi 读 <agent-dir>/AGENTS.md 作跨目录全局指令
    // 原样同步：默认模型/供应商（settings.json）、登录态（auth.json）、自定义供应商与模型目录（models*.json，可能含网关地址/密钥）
    credentialFiles: ["settings.json", "auth.json", "models.json", "models-store.json"],
    // pi-acp 把 pi 的启动信息（## Context / ## Skills …）当作 agent_message_chunk 发出来，那是给人看的启动信息，进微信回复就是噪声。
    // pi 自己的 `quietStartup: true` 关掉它（docs/settings.md）；写进视图/沙箱副本，用户显式设过就保留用户的值。
    settingsDefaults: { quietStartup: true },
    // pi 的 MCP 是 <agent-dir>/mcp.json（不是 settings/mcp.json）；kiro 格式与 pi 兼容
    mcpConfigFile: "mcp.json",
    catalogFile: "mcp.json",
  },
  // Claude Code：官方 ACP 适配器 @agentclientprotocol/claude-agent-acp（bin: claude-agent-acp；**Node ≥22**）。
  // - **全局安装，不用 npx**（口径同 codex）：daemon 常驻、worker 每条任务起进程，npx 每次冷启动都要问 registry/现下包，离线不可用且版本漂移；
  //   `npm i -g @agentclientprotocol/claude-agent-acp`。适配器自带 @anthropic-ai/claude-agent-sdk（含平台原生二进制）；
  //   若装的时候漏了 optional 依赖（native binary not found），可用 CLAUDE_CODE_EXECUTABLE 指向本机已装的 claude 二进制。
  // - 免审批：适配器**不解析** --dangerously-skip-permissions 之类 CLI flag；会话建立/恢复后走 `session/set_mode {modeId:"bypassPermissions"}`（见 sessionMode）。
  //   以 root 运行且未设 IS_SANDBOX=1 时该模式不可用——会话回包的 availableModes 里没有它，applyAcpSessionMode 会跳过并记日志。
  // - 沙箱：CLAUDE_CONFIG_DIR 指向 <BRAIN_HOME>/claude（实测会把 ~/.claude.json 一起搬进该目录，用户级 mcpServers 不会漏进大脑）；
  //   real/mirror 没有视图时 CLAUDE_CONFIG_DIR=~，**CLAUDE.md/skills 与 ~/.claude.json 一律只读**，微信侧 overlay/MCP 不生效；
  //   CLAUDE.md/skills/agents/commands 与日常使用共享；OAuth 登录态 .credentials.json 在 sandbox 下同步进账号沙箱（real/mirror 链接真实文件）。
  //   **不复制 settings.json**：它常含网关 token（env），按 §4.9 密钥由 daemon 进程环境提供；需要网关时设 ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL。
  // - MCP：走 ACP session/new|load 的 mcpServers（mcpViaAcp），不写配置文件；目录取真实 ~/.claude.json 的 mcpServers（`catalogFile` 用 `..` 回到 home）。
  //   探针实测 stdio MCP 可用（尽管 initialize 的 mcpCapabilities 只声明 http/sse——能力字段不可信的又一例）。
  // - 2026-10-30 探针实测（claude-agent-acp 0.99.1 / Claude Code 2.1.314，Windows）：
  //   loadSession ✅、sessionCapabilities.resume/close/delete/fork/list ✅、image ✅、stdio MCP ✅、bypassPermissions 下 0 反向请求；
  //   重启后 session/load 上下文保留；session/new ~1.2s、首帧 ~2ms、首段正文 ~8–12s。真机微信单轮 E2E 已过（2026-10-31）；详见 docs/接入-ClaudeCode.md（重启续聊/MCP/任务待复测）。
  "claude-code": {
    name: "claude-code",
    bin: "claude-agent-acp",
    binWin: "claude-agent-acp.cmd",
    args: [],
    shell: true,
    env: { CLAUDE_CONFIG_DIR: `%HOME%${path.sep}claude` },
    realEnv: { CLAUDE_CONFIG_DIR: "%HOME%" },
    realHome: path.join(os.homedir(), ".claude"),
    inheritDirs: ["skills", "agents", "commands"],
    inheritFiles: ["CLAUDE.md"],
    configSubdir: "claude",
    // 真实 ~/.claude.json 与 realHome 同级；path.join 后得到 ~/.claude/../.claude.json
    catalogFile: path.join("..", ".claude.json"),
    extraConfigFiles: [{ source: path.join(os.homedir(), ".claude.json"), target: ".claude.json" }],
    credentialFiles: [".credentials.json"],
    mcpViaAcp: true,
    sessionMode: "bypassPermissions",
  },
  // Codex：需适配器（Codex CLI 本身不说 ACP）。适配器是 npm 包 `@agentclientprotocol/codex-acp`（bin: codex-acp；
  // ACP 项目维护，非 OpenAI 官方）。npm latest 2.6.0（2026-11-11）；本预设的实测基线是 2.6.0（2026-11-12 全量复测通过），升级后重跑探针。
  // - **全局安装，不用 npx**（口径同 claude-code）：daemon 常驻、worker 每条任务起进程，npx 每次冷启动都要问 registry/现下包，离线不可用且版本漂移；
  //   `npm i -g @agentclientprotocol/codex-acp`。适配器自带 @openai/codex 依赖（含平台原生二进制，约 100MB）；
  //   想复用本机已装的 Codex 可装适配器时加 --omit=optional 并设 CODEX_PATH=<codex.exe 绝对路径>（适配器官方支持的环境变量）。
  // - Windows 上 npm 全局安装产出的是 codex-acp.cmd（**无 .exe**），故 binWin 写 .cmd + shell（.cmd 必须经 shell，§4.6）；standalone 二进制用 --bin 指定。
  // - codex-acp **不解析** CLI 参数（codex 的 --yolo/--full-auto 都不适用）；免审批走 ACP `session/set_mode {modeId:"agent-full-access"}`
  //   （= approval never + sandbox danger-full-access），并同时用 README 记录的环境变量 INITIAL_AGENT_MODE 兜底（旧版本无 set_mode 时仍生效）。
  // - 认证走 Codex 自己（ChatGPT 登录或 OPENAI_API_KEY）；已有 ~/.codex/config.toml 直接沿用——适配器不读 WeMind 沙箱，故无 homeEnvVar。
  // - MCP：**支持客户端提供的 stdio MCP server**（2026-11-12 复测 codex-acp 2.5.0 与 2.6.0：session/new 传 stdio mcpServers，
  //   模型实际调用 fake_ping 并返回 FAKE_PONG）。旧结论「mcpCapabilities.acp=false = 不支持 stdio」是误读：
  //   `acp` 指 MCP-over-ACP 传输，stdio 是 ACP 的基础传输，不靠这个字段声明。故开 mcpViaAcp。
  //   Codex 自己的 ~/.codex/config.toml 仍会被 Codex 原生加载；同名 server 由 Codex 自身条目优先，适配器会跳过客户端重复项。
  //   微信侧额外 MCP 可走 overlay 的 mcp.extra；WeMind **只读解析** config.toml 的 `[mcp_servers.*]`（列目录 + 启动前检查 wechat），绝不写回，也无法替它 unload。
  // - 2026-10-30 探针实测（codex-acp 2.5.0 / Codex CLI 0.165，Windows）：
  //   loadSession ✅、promptCapabilities.image ✅、session/set_mode ✅、session/set_config_option(model) ✅、session/load 后上下文保留、
  //   工具调用 0 反向请求（只收到无 id 的 _auth/status_update 通知）；首帧 ~20ms、首字 3–4s、带图整轮 ~24s。
  //   真机 E2E 已通过（2026-11-01：worker 与 brain 通道均通）；详见 docs/接入-Codex.md。
  codex: {
    name: "codex",
    bin: "codex-acp",
    binWin: "codex-acp.cmd",
    args: [],
    shell: true,
    envDefaults: { INITIAL_AGENT_MODE: "agent-full-access" },
    sessionMode: "agent-full-access",
    // Codex 的真实配置目录（生成视图/配置指纹/危险路径判断的来源；homeEnvVar 为空，不传给适配器）。
    // catalogFile 指向 config.toml：WeMind 只读解析其中的 [mcp_servers.*]（列目录 + 启动前检查 wechat），绝不写回；原生 MCP 由 Codex 自己加载。
    realHome: path.join(os.homedir(), ".codex"),
    catalogFile: "config.toml",
    mcpViaAcp: true,
    // 回合可能跑几十秒（实测带图的回合 ~24s），且适配器会发 thought / tool_call / usage 帧；心跳放长，少占微信连发额度（约 10 条/用户）。
    heartbeatMs: 60_000,
  },
};
