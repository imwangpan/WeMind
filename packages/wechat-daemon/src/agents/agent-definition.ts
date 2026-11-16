/**
 * Agent 定义（数据面）契约。
 *
 * 把「接入一个新的 ACP agent」从改代码变成加一份数据：这里定义数据面的字段、取值范围与校验，
 * 并让**同一份源**同时驱动运行时校验器（`validateAgentDefinition`）与 JSON Schema（`agentDefinitionJsonSchema`），
 * 避免字段表与文档/校验各写一遍。
 *
 * 不在这里的东西：字段语义的代码解释（引擎探测、profile 读取、凭据派生、启动前文件生成）——
 * 那些属于 adapter hook，见 docs/设计文档/Agent-接入配置化与插件化设计与实现.md。
 *
 * 两条纪律：
 * - **未知字段一律拒绝**。拼错字段名（如 `realhome`）必须报错而不是静默忽略——静默忽略的表现是「接上了但没生效」，
 *   是本项目最难排查的一类故障。同一 `schemaVersion` 内允许新增**可选**字段，所以正常的兼容升级不需要动这个常量。
 * - **版本不匹配 fail-closed**：`schemaVersion` 与实际支持不符时如实报错，不做"尽力解释"，避免静默半生效。
 */
import path from "node:path";

/** 当前定义的数据面版本。新增可选字段不用改它；改字段语义/删字段/改必填性才需要升。 */
export const AGENT_DEFINITION_SCHEMA_VERSION = 1;

/** adapter hook 契约版本（插件声明自己按哪一版契约实现）。 */
export const AGENT_ADAPTER_API_VERSION = 1;

/** MCP 定义的文件格式（内置）：顶层 `mcpServers`、嵌套 `mcp.servers`、DSH 的 profile YAML patch 条目。 */
export type AgentMcpFormat = "mcpServers" | "mcp.servers" | "dshProfileYaml";

export const AGENT_MCP_FORMATS: readonly AgentMcpFormat[] = [
  "mcpServers",
  "mcp.servers",
  "dshProfileYaml",
];

/** 恢复会话的方式：`load`（`session/load`）或 `resume`（`session/resume`，部分 agent 没有 load）。 */
export type AgentRestoreMode = "load" | "resume";

export const AGENT_RESTORE_MODES: readonly AgentRestoreMode[] = ["load", "resume"];

/** 托管 MCP 的投递方式：写 Agent 配置文件，或随 ACP 会话下发。 */
export type AgentMcpDelivery = "config" | "acp";

export const AGENT_MCP_DELIVERIES: readonly AgentMcpDelivery[] = ["config", "acp"];

/**
 * 适配器引用：数据表达不了时（新文件格式解析、凭据派生、引擎版本探测…）指向一个模块。
 * 模块按 `apiVersion` 对应的命名 hook 契约注册实现；插件是逃生舱，不是默认路径。
 */
export type AgentDefinitionAdapter = {
  module: string;
  apiVersion: number;
};

/**
 * 能力结论的探测记录。
 * 探测结论会随 agent 升级漂移（今天 `images:false`、明天支持了），所以要记下时间与当时的 agent 版本。
 */
export type AgentDefinitionProbe = {
  at: string;
  agentVersion?: string;
};

/**
 * Agent 定义（数据面）。
 *
 * **字段含义、取值范围与完整说明在 `AGENT_DEFINITION_FIELDS`（同文件）**：那是唯一事实来源，
 * 并且会原文进入 JSON Schema 与 `wemind agent spec`，所以用户与做自助接入的 agent 看到的就是它。
 * 这里只保留结构与分组——不在两处重复写含义（那会变成第二个真相，且没有守卫能断言它们一致）。
 * 下面按分组逐段列出，分组只表达结构、不承载语义，可以放心对照字段表阅读。
 *
 * `credentialEnv` 不在其中——它是函数值，属于 adapter。
 */
export type AgentDefinition = {
  /** 定义的数据面版本：见 `AGENT_DEFINITION_SCHEMA_VERSION`（不匹配则 fail-closed）。 */
  schemaVersion: number;

  // —— 身份与启动 ——
  name: string;
  bin: string;
  binWin?: string;
  fallbackBinPaths?: string[];
  requiresBins?: string[];
  args: string[];
  shell?: boolean;

  // —— 目录与继承 ——
  homeEnvVar?: string;
  realHome?: string;
  configSubdir?: string;
  inheritDirs?: string[];
  inheritFiles?: string[];
  extraConfigFiles?: string[];

  // —— MCP ——
  mcpFormat?: string;
  mcpConfigFile?: string;
  catalogFile?: string;
  acpMcpServers?: boolean;
  mcpDelivery?: AgentMcpDelivery;

  // —— 会话与能力 ——
  restore?: AgentRestoreMode;
  replayOnLoad?: boolean;
  images?: boolean;
  sessionMode?: string;
  isolateSessions?: boolean;

  // —— 超时与心跳 ——
  firstFrameMs?: number;
  heartbeatMs?: number;

  // —— 模型 ——
  model?: string;
  modelArg?: string;
  realProfile?: string;

  // —— 环境 ——
  env?: Record<string, string>;
  envDefaults?: Record<string, string>;

  // —— 副本设置（仅 managed 生效）——
  settingsBase?: string;
  settingsDefaults?: Record<string, unknown>;
  credentialFiles?: string[];
  identityFiles?: string[];

  // —— 引擎差异 ——
  kiroEngine?: boolean;

  // —— 说明 ——
  /** 给维护者看的说明（一段一条）；JSON 没有注释，这批"为什么这么写"的经验放这里。 */
  notes?: string[];

  // —— 插件与探测 ——
  adapter?: AgentDefinitionAdapter;
  probe?: AgentDefinitionProbe;
};

export const AGENT_NAME_PATTERN = /^(?!auto$)[a-z0-9][a-z0-9._-]*$/;

/** 可安全拼成 `<name>.json` / `adapters/<name>/` 的 agent 名。 */
export function isSafeAgentName(name: string): boolean {
  return AGENT_NAME_PATTERN.test(name);
}

/**
 * 编译期守卫：`AgentDefinition` 的每个数据字段都必须在这里出现一次，漏一个就编译不过。
 * （`schemaVersion` / `adapter` / `probe` 不是"数据字段"，单独处理。）
 */
const DEFINITION_DATA_KEYS: Record<
  Exclude<keyof AgentDefinition, "schemaVersion" | "adapter" | "probe">,
  true
> = {
  // 分组与顺序与 AgentDefinition 类型、AGENT_DEFINITION_FIELDS 完全一致（改一处要三处一起改）。
  // —— 身份与启动 ——
  name: true,
  bin: true,
  binWin: true,
  fallbackBinPaths: true,
  requiresBins: true,
  args: true,
  shell: true,
  // —— 目录与继承 ——
  homeEnvVar: true,
  realHome: true,
  configSubdir: true,
  inheritDirs: true,
  inheritFiles: true,
  extraConfigFiles: true,
  // —— MCP ——
  mcpFormat: true,
  mcpConfigFile: true,
  catalogFile: true,
  acpMcpServers: true,
  mcpDelivery: true,
  // —— 会话与能力 ——
  restore: true,
  replayOnLoad: true,
  images: true,
  sessionMode: true,
  isolateSessions: true,
  // —— 超时与心跳 ——
  firstFrameMs: true,
  heartbeatMs: true,
  // —— 模型 ——
  model: true,
  modelArg: true,
  realProfile: true,
  // —— 环境 ——
  env: true,
  envDefaults: true,
  // —— 副本设置（仅 managed 生效）——
  settingsBase: true,
  settingsDefaults: true,
  credentialFiles: true,
  identityFiles: true,
  // —— 引擎差异 ——
  kiroEngine: true,
  // —— 说明 ——
  notes: true,
};

/** 数据字段名（校验器与 JSON Schema 的键集来源）。 */
export type AgentDefinitionDataKey = keyof typeof DEFINITION_DATA_KEYS;

/** 字段的取值形状。每种 `kind` 在校验器与 JSON Schema 里各有一处映射，不要在别处再判类型。 */
type AgentDefinitionFieldKind =
  | { kind: "string"; nonEmpty?: boolean; pattern?: string }
  | { kind: "boolean" }
  | { kind: "stringArray" }
  | { kind: "stringRecord" }
  | { kind: "jsonObject" }
  | { kind: "positiveInt" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "openEnum"; known: readonly string[]; requiresAdapter?: boolean };

type AgentDefinitionField = {
  key: AgentDefinitionDataKey;
  kind: AgentDefinitionFieldKind;
  required?: boolean;
  /**
   * 该字段是数据、但**语义**要靠 adapter 的代码解释（不是纯数据）。
   * 标出来是为了让 `agent spec` 与后续的守卫能说清"哪些字段改了数据也没用、得配 adapter"。
   */
  codeInterpreted?: boolean;
  desc: string;
};

/**
 * 数据字段表（唯一事实来源）。
 * 加字段的顺序：先加到 `AgentDefinition` 与 `DEFINITION_DATA_KEYS`，再加到这里——漏了会被单测断言抓住。
 */
export const AGENT_DEFINITION_FIELDS: readonly AgentDefinitionField[] = [
  // —— 身份与启动 ——
  {
    key: "name",
    kind: { kind: "string", nonEmpty: true, pattern: AGENT_NAME_PATTERN.source },
    required: true,
    desc: "agent 名（同时用作定义文件名、brain.json 键与微信指令里的名字）：小写字母/数字开头，后接小写字母、数字、`.`、`_`、`-`；`auto` 是自动探测开关，不能作为名字",
  },
  {
    key: "bin",
    kind: { kind: "string", nonEmpty: true },
    required: true,
    desc: "PATH 上的二进制名（非 Windows）",
  },
  {
    key: "binWin",
    kind: { kind: "string", nonEmpty: true },
    desc: "Windows 下的可执行名（只有 .cmd 时必须写全，如 dsh.cmd）",
  },
  { key: "fallbackBinPaths", kind: { kind: "stringArray" }, desc: "PATH 上找不到时的已知安装位置" },
  {
    key: "requiresBins",
    kind: { kind: "stringArray" },
    desc: "除 bin 外还必须在 PATH 上解析到的运行时（适配器内部会 spawn 它）",
  },
  {
    key: "args",
    kind: { kind: "stringArray" },
    required: true,
    desc: "进入 ACP 模式的启动参数（允许空数组）",
  },
  {
    key: "shell",
    kind: { kind: "boolean" },
    desc: "是否经 shell 启动（.cmd/.bat/npx 类适配器在 Windows 需要 true）",
  },
  // —— 目录与继承 ——
  {
    key: "homeEnvVar",
    kind: { kind: "string" },
    desc: "agent 读取配置/数据目录的环境变量名（managed 下指向副本；留空=不设置）",
  },
  {
    key: "realHome",
    kind: { kind: "string", nonEmpty: true },
    desc: "agent 真实配置目录（副本继承、配置指纹、危险路径判断的来源）",
  },
  {
    key: "configSubdir",
    kind: { kind: "string" },
    desc: "agent 配置目录相对 managed 根的子路径（留空=根目录本身）",
  },
  {
    key: "inheritDirs",
    kind: { kind: "stringArray" },
    desc: "managed 下 junction 进账号副本的知识/记忆类子目录",
  },
  {
    key: "inheritFiles",
    kind: { kind: "stringArray" },
    desc: "managed 下拷进账号副本的单文件记忆（如 AGENTS.md）",
  },
  {
    key: "extraConfigFiles",
    kind: { kind: "stringArray" },
    desc: "配置目录之外、但属于该 agent 的文件（只读：目录/指纹/微信 MCP 检查用）",
  },
  // —— MCP ——
  {
    key: "mcpFormat",
    kind: { kind: "openEnum", known: AGENT_MCP_FORMATS, requiresAdapter: true },
    desc: "MCP 定义的文件格式；内置只支持 mcpServers / mcp.servers / dshProfileYaml，自定义格式需要 adapter",
  },
  {
    key: "mcpConfigFile",
    kind: { kind: "string", nonEmpty: true },
    desc: "MCP 配置文件相对配置目录的路径",
  },
  {
    key: "catalogFile",
    kind: { kind: "string", nonEmpty: true },
    desc: "MCP 目录来源文件相对 realHome 的路径（WeMind 只读）",
  },
  {
    key: "acpMcpServers",
    kind: { kind: "boolean" },
    desc: "该 agent 接受 ACP session/new|resume 的 mcpServers（能力声明）",
  },
  {
    key: "mcpDelivery",
    kind: { kind: "enum", values: AGENT_MCP_DELIVERIES },
    desc: "托管 MCP 的投递方式：写 Agent 配置文件（config）或随 ACP 会话下发（acp）",
  },
  // —— 会话与能力 ——
  {
    key: "restore",
    kind: { kind: "enum", values: AGENT_RESTORE_MODES },
    desc: "恢复会话的方式：load / resume（都没有则退化为新建，由客户端兜底）",
  },
  {
    key: "replayOnLoad",
    kind: { kind: "boolean" },
    desc: "load/resume 返回后仍异步回放历史：恢复后先等帧流安静再提问",
  },
  { key: "images", kind: { kind: "boolean" }, desc: "是否接受图片输入（默认 true）" },
  {
    key: "sessionMode",
    kind: { kind: "string" },
    desc: "会话建立/恢复后经 session/set_mode 切到的模式 id（留空=不调用）",
  },
  {
    key: "isolateSessions",
    kind: { kind: "boolean" },
    codeInterpreted: true,
    desc: "managed 下把会话持久化 root 指到账号数据目录（启动前文件生成的语义由 adapter 解释）",
  },
  // —— 超时与心跳 ——
  { key: "firstFrameMs", kind: { kind: "positiveInt" }, desc: "首帧超时覆盖（毫秒）" },
  { key: "heartbeatMs", kind: { kind: "positiveInt" }, desc: "静默期心跳间隔覆盖（毫秒）" },
  // —— 模型 ——
  {
    key: "model",
    kind: { kind: "string" },
    desc: "默认模型值（经 session/set_config_option 在会话建立后下发一次）",
  },
  {
    key: "modelArg",
    kind: { kind: "string" },
    desc: "不支持 set_config_option 时，模型改为追加到启动参数（如 --model）",
  },
  {
    key: "realProfile",
    kind: { kind: "string" },
    codeInterpreted: true,
    desc: "真实 home 里的 profile 名（该 agent 的 profile 读写语义由 adapter 解释）",
  },
  // —— 环境 ——
  {
    key: "env",
    kind: { kind: "stringRecord" },
    desc: "managed 下强制注入的环境变量（值里 %HOME% → 副本根）",
  },
  {
    key: "envDefaults",
    kind: { kind: "stringRecord" },
    desc: "默认环境变量：父进程已设同名变量时以父进程为准（审批类开关用）",
  },
  // —— 副本设置（仅 managed 生效）——
  {
    key: "settingsBase",
    kind: { kind: "string", nonEmpty: true },
    desc: "managed 下整份复制进副本的设置文件（只剥 MCP 段并关自动更新）",
  },
  {
    key: "settingsDefaults",
    kind: { kind: "jsonObject" },
    desc: "managed 副本设置文件的缺省键（用户显式设过则保留用户的值）",
  },
  {
    key: "credentialFiles",
    kind: { kind: "stringArray" },
    desc: "managed 下从 realHome 同步进副本的凭据文件（相对配置目录，新者胜）",
  },
  {
    key: "identityFiles",
    kind: { kind: "stringArray" },
    desc: "managed 下必须与 realHome 一致的标识文件（内容不同即覆盖）",
  },
  // —— 引擎差异 ——
  {
    key: "kiroEngine",
    kind: { kind: "boolean" },
    codeInterpreted: true,
    desc: "kiro v2/v3 引擎差异（启动参数与免审批方式的语义由 adapter 解释）",
  },
  // —— 说明 ——
  {
    key: "notes",
    kind: { kind: "stringArray" },
    desc: "给维护者的说明（一段一条：为什么这么写、踩过什么坑）；只作文档用途，不改变行为，`wemind agent show` 会打印",
  },
];

/** 校验问题：`path` 用点号定位（如 `args[1]` / `env.PATH`），便于直接回给用户或模型。 */
export type AgentDefinitionProblem = { path: string; message: string };

export type AgentDefinitionValidation =
  | { ok: true; value: AgentDefinition }
  | { ok: false; problems: AgentDefinitionProblem[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 校验单个数据字段；返回问题列表（空=通过）。 */
function validateField(
  field: AgentDefinitionField,
  value: unknown,
  hasAdapter: boolean,
): AgentDefinitionProblem[] {
  const { key, kind } = field;
  switch (kind.kind) {
    case "string": {
      if (typeof value !== "string") return [{ path: key, message: "应为字符串" }];
      if (kind.nonEmpty && value === "") return [{ path: key, message: "不能是空字符串" }];
      if (kind.pattern && !new RegExp(kind.pattern).test(value))
        return [{ path: key, message: `应为 ${kind.pattern} 形式（${field.desc}）` }];
      return [];
    }
    case "boolean":
      return typeof value === "boolean" ? [] : [{ path: key, message: "应为 true / false" }];
    case "positiveInt":
      return typeof value === "number" && Number.isInteger(value) && value > 0
        ? []
        : [{ path: key, message: "应为正整数（毫秒）" }];
    case "enum":
      return typeof value === "string" && kind.values.includes(value)
        ? []
        : [{ path: key, message: `只能是 ${kind.values.join(" / ")}` }];
    case "openEnum":
      if (typeof value !== "string") return [{ path: key, message: "应为字符串" }];
      if (kind.known.includes(value)) return [];
      if (kind.requiresAdapter && !hasAdapter)
        return [
          {
            path: key,
            message: `未知的取值「${value}」：内置只支持 ${kind.known.join(" / ")}，自定义格式需要 adapter`,
          },
        ];
      return [];
    case "stringArray":
      if (!Array.isArray(value)) return [{ path: key, message: "应为字符串数组" }];
      return value.flatMap((item, i) =>
        typeof item === "string" && item !== ""
          ? []
          : [{ path: `${key}[${i}]`, message: "应为非空字符串" }],
      );
    case "stringRecord": {
      if (!isPlainObject(value)) return [{ path: key, message: "应为字符串到字符串的对象" }];
      const problems: AgentDefinitionProblem[] = [];
      for (const [k, v] of Object.entries(value)) {
        if (k === "") problems.push({ path: `${key}（空键）`, message: "键不能是空字符串" });
        if (typeof v !== "string") problems.push({ path: `${key}.${k}`, message: "值应为字符串" });
      }
      return problems;
    }
    case "jsonObject":
      return isPlainObject(value) ? [] : [{ path: key, message: "应为对象" }];
  }
}

/** 校验 adapter 引用；`undefined` 表示没写（合法）。 */
function validateAdapter(raw: unknown): AgentDefinitionProblem[] {
  if (!isPlainObject(raw))
    return [{ path: "adapter", message: "应为对象（{ module, apiVersion }）" }];
  const problems: AgentDefinitionProblem[] = [];
  const module = raw.module;
  if (typeof module !== "string" || module === "")
    problems.push({ path: "adapter.module", message: "应为非空字符串（包名或模块路径）" });
  const apiVersion = raw.apiVersion;
  if (typeof apiVersion !== "number" || !Number.isInteger(apiVersion))
    problems.push({ path: "adapter.apiVersion", message: "应为整数（hook 契约版本）" });
  else if (apiVersion !== AGENT_ADAPTER_API_VERSION)
    problems.push({
      path: "adapter.apiVersion",
      message: `本版本只支持 hook 契约 ${AGENT_ADAPTER_API_VERSION}（这份 adapter 声明的是 ${apiVersion}）`,
    });
  for (const k of Object.keys(raw))
    if (k !== "module" && k !== "apiVersion")
      problems.push({
        path: `adapter.${k}`,
        message: "未知字段（adapter 只接受 module / apiVersion）",
      });
  return problems;
}

/** 校验探测记录；`undefined` 表示没写（合法）。 */
function validateProbe(raw: unknown): AgentDefinitionProblem[] {
  if (!isPlainObject(raw)) return [{ path: "probe", message: "应为对象（{ at, agentVersion? }）" }];
  const problems: AgentDefinitionProblem[] = [];
  const at = raw.at;
  if (typeof at !== "string" || at === "")
    problems.push({ path: "probe.at", message: "应为非空字符串（探测时间）" });
  else if (!isProbeTimestamp(at))
    problems.push({
      path: "probe.at",
      message: `应为 ISO 8601 时间：「${at}」（如 2026-11-16T10:00:00Z）`,
    });
  const agentVersion = raw.agentVersion;
  if (agentVersion !== undefined && (typeof agentVersion !== "string" || agentVersion === ""))
    problems.push({ path: "probe.agentVersion", message: "应为非空字符串" });
  for (const k of Object.keys(raw))
    if (k !== "at" && k !== "agentVersion")
      problems.push({ path: `probe.${k}`, message: "未知字段（probe 只接受 at / agentVersion）" });
  return problems;
}

const PROBE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isProbeTimestamp(value: string): boolean {
  return PROBE_TIMESTAMP_RE.test(value) && !Number.isNaN(Date.parse(value));
}

type RelativePathMode = "safe" | "parent-file" | "segment";

function relativePathProblem(
  pathName: string,
  value: string,
  mode: RelativePathMode,
): AgentDefinitionProblem | null {
  if (value.startsWith("~")) return { path: pathName, message: "应为相对路径（不能以 ~ 开头）" };
  if (
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.startsWith("/") ||
    value.startsWith("\\")
  )
    return { path: pathName, message: "应为相对路径（不能是绝对路径）" };

  if (mode === "segment") {
    if (value === "." || value === ".." || /[\\/]/.test(value))
      return { path: pathName, message: "应为单段名称（不能包含目录分隔符或 ..）" };
    return null;
  }

  const normalized = value.replaceAll("\\", "/");
  if (mode === "parent-file" && normalized.startsWith("../")) {
    const rest = normalized.slice(3);
    if (!rest || rest.includes("/") || rest === ".." || rest === ".")
      return {
        path: pathName,
        message: "最多允许引用 realHome 的同级单个文件（形如 ../name.json）",
      };
    return null;
  }
  if (normalized.split("/").includes(".."))
    return { path: pathName, message: "不能包含 ..（不得逃出 agent 配置目录）" };
  return null;
}

function validateRelativePathFields(raw: Record<string, unknown>): AgentDefinitionProblem[] {
  const problems: AgentDefinitionProblem[] = [];
  const single: Array<[string, RelativePathMode]> = [
    ["mcpConfigFile", "safe"],
    ["catalogFile", "parent-file"],
    ["settingsBase", "safe"],
    ["realProfile", "segment"],
  ];
  for (const [key, mode] of single) {
    const value = raw[key];
    if (typeof value !== "string") continue;
    const problem = relativePathProblem(key, value, mode);
    if (problem) problems.push(problem);
  }
  for (const key of ["inheritDirs", "inheritFiles", "credentialFiles", "identityFiles"]) {
    const value = raw[key];
    if (!Array.isArray(value)) continue;
    value.forEach((item, i) => {
      if (typeof item !== "string") return;
      const problem = relativePathProblem(`${key}[${i}]`, item, "safe");
      if (problem) problems.push(problem);
    });
  }
  return problems;
}

function validateCrossFieldRequirements(raw: Record<string, unknown>): AgentDefinitionProblem[] {
  if (typeof raw.realHome === "string" && raw.realHome.trim() !== "") return [];
  const needsRealHome = [
    "inheritDirs",
    "inheritFiles",
    "mcpFormat",
    "mcpConfigFile",
    "catalogFile",
    "settingsBase",
    "credentialFiles",
    "identityFiles",
    "realProfile",
  ].filter((key) => raw[key] !== undefined);
  if (needsRealHome.length === 0) return [];
  return [
    {
      path: "realHome",
      message: `使用 ${needsRealHome.join(" / ")} 时必须同时提供 realHome（这些路径都相对于它）`,
    },
  ];
}

/**
 * 校验一份 agent 定义。**一次报全所有问题**（不是遇到第一个就返回）——写定义的人/模型需要一轮就知道全部要修的地方。
 * 未知字段、类型不符、版本不符都会让整份定义不通过（fail-closed），不做"忽略坏字段继续跑"。
 */
export function validateAgentDefinition(raw: unknown): AgentDefinitionValidation {
  if (!isPlainObject(raw))
    return { ok: false, problems: [{ path: "(root)", message: "定义应是一个 JSON 对象" }] };

  const problems: AgentDefinitionProblem[] = [];
  const dataKeys = DEFINITION_DATA_KEYS as Record<string, true>;
  const knownKeys = new Set<string>([
    ...Object.keys(dataKeys),
    "schemaVersion",
    "adapter",
    "probe",
  ]);

  for (const k of Object.keys(raw))
    if (!knownKeys.has(k))
      problems.push({ path: k, message: "未知字段（字段名区分大小写；可用字段见定义规格）" });

  const schemaVersion = raw.schemaVersion;
  if (schemaVersion === undefined)
    problems.push({
      path: "schemaVersion",
      message: `缺少 schemaVersion（当前为 ${AGENT_DEFINITION_SCHEMA_VERSION}）`,
    });
  else if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion))
    problems.push({ path: "schemaVersion", message: "应为整数" });
  else if (schemaVersion !== AGENT_DEFINITION_SCHEMA_VERSION)
    problems.push({
      path: "schemaVersion",
      message: `本版本只支持 schemaVersion ${AGENT_DEFINITION_SCHEMA_VERSION}（这份定义声明的是 ${schemaVersion}，需要更新的 WeMind）`,
    });

  const adapterProblems = raw.adapter === undefined ? [] : validateAdapter(raw.adapter);
  const probeProblems = raw.probe === undefined ? [] : validateProbe(raw.probe);
  const hasRequiredAdapterFields = adapterProblems.length === 0 && raw.adapter !== undefined;

  for (const field of AGENT_DEFINITION_FIELDS) {
    const value = raw[field.key];
    if (value === undefined) {
      if (field.required) problems.push({ path: field.key, message: "必填字段缺失" });
      continue;
    }
    problems.push(...validateField(field, value, hasRequiredAdapterFields));
  }

  problems.push(
    ...adapterProblems,
    ...probeProblems,
    ...validateRelativePathFields(raw),
    ...validateCrossFieldRequirements(raw),
  );
  if (problems.length > 0) return { ok: false, problems };

  // 只按字段表复制已知键：即使输入里带了 `__proto__` 之类的键也进不来（未知键上面已经拒绝）。
  const value: Record<string, unknown> = { schemaVersion: raw.schemaVersion };
  for (const field of AGENT_DEFINITION_FIELDS) {
    const v = raw[field.key];
    if (v !== undefined) value[field.key] = v;
  }
  if (raw.adapter !== undefined) value.adapter = raw.adapter;
  if (raw.probe !== undefined) value.probe = raw.probe;
  return { ok: true, value: value as AgentDefinition };
}

/** 把问题列表拼成可直接展示的文案（CLI / 微信回执共用）。 */
export function formatAgentDefinitionProblems(
  problems: readonly AgentDefinitionProblem[],
): string[] {
  return problems.map((p) => `${p.path}: ${p.message}`);
}

function fieldToJsonSchema(field: AgentDefinitionField): Record<string, unknown> {
  const { kind } = field;
  const desc = field.codeInterpreted
    ? `${field.desc}（语义由 adapter 解释：这个字段光写数据不会生效）`
    : field.desc;
  switch (kind.kind) {
    case "string": {
      const s: Record<string, unknown> = { type: "string", description: desc };
      if (kind.nonEmpty) s.minLength = 1;
      if (kind.pattern) s.pattern = kind.pattern;
      return s;
    }
    case "boolean":
      return { type: "boolean", description: desc };
    case "positiveInt":
      return { type: "integer", minimum: 1, description: desc };
    case "enum":
      return { enum: kind.values, description: desc };
    case "openEnum":
      return { type: "string", description: `${desc}（内置：${kind.known.join(" / ")}）` };
    case "stringArray":
      return { type: "array", items: { type: "string", minLength: 1 }, description: desc };
    case "stringRecord":
      return {
        type: "object",
        propertyNames: { minLength: 1 },
        additionalProperties: { type: "string" },
        description: desc,
      };
    case "jsonObject":
      return { type: "object", description: desc };
  }
}

/**
 * 由同一份字段表生成 JSON Schema（`agent spec --json` 用它，编辑器自动补全也用它）。
 * 关键约束都在里面：`additionalProperties: false`（未知字段拒绝）、必填项、
 * 以及"自定义 `mcpFormat` 必须同时给 adapter"这类**条件必填**——所以校验器与 schema 不会各说一套。
 */
export function agentDefinitionJsonSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    schemaVersion: {
      type: "integer",
      const: AGENT_DEFINITION_SCHEMA_VERSION,
      description: "定义的数据面版本",
    },
  };
  const required: string[] = ["schemaVersion"];
  /**
   * 条件必填（自定义 `mcpFormat` 必须同时给 adapter）用 `anyOf` 表达，而不是 `if` / `then`：
   * 两者等价——"要么给了 adapter，要么 `mcpFormat` 是内置值或缺省"——而 `anyOf` 是纯标准关键字，
   * 也避开 lint 对 `then` 属性的告警（仓库里不加任何 lint 豁免）。
   * 每个需要条件的字段一组，多组之间用 `allOf` 叠加，避免"任一组满足即可"的语义漂移。
   */
  const requirementGroups: Record<string, unknown>[][] = [];

  for (const field of AGENT_DEFINITION_FIELDS) {
    properties[field.key] = fieldToJsonSchema(field);
    if (field.required) required.push(field.key);
    if (field.kind.kind === "openEnum" && field.kind.requiresAdapter)
      requirementGroups.push([
        { required: ["adapter"] },
        { properties: { [field.key]: { enum: field.kind.known } } },
      ]);
  }

  const relativePattern = "^(?!(?:[A-Za-z]:)?[/\\\\])(?!.*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$)).+$";
  for (const key of ["mcpConfigFile", "settingsBase"])
    (properties[key] as Record<string, unknown>).pattern = relativePattern;
  (properties.catalogFile as Record<string, unknown>).pattern = "^(?:\\.\\./)?[^/\\\\]+$";
  (properties.realProfile as Record<string, unknown>).pattern = "^(?!\\.{1,2}$)[^/\\\\]+$";
  for (const key of ["inheritDirs", "inheritFiles", "credentialFiles", "identityFiles"])
    (properties[key] as Record<string, unknown>).items = {
      type: "string",
      minLength: 1,
      pattern: relativePattern,
    };

  for (const key of [
    "inheritDirs",
    "inheritFiles",
    "mcpFormat",
    "mcpConfigFile",
    "catalogFile",
    "settingsBase",
    "credentialFiles",
    "identityFiles",
    "realProfile",
  ])
    requirementGroups.push([{ not: { required: [key] } }, { required: ["realHome"] }]);

  properties.adapter = {
    type: "object",
    additionalProperties: false,
    required: ["module", "apiVersion"],
    properties: {
      module: { type: "string", minLength: 1, description: "模块说明符（包名或路径）" },
      apiVersion: {
        type: "integer",
        const: AGENT_ADAPTER_API_VERSION,
        description: "hook 契约版本",
      },
    },
    description: "数据表达不了时的代码逃生舱",
  };
  properties.probe = {
    type: "object",
    additionalProperties: false,
    required: ["at"],
    properties: {
      at: {
        type: "string",
        minLength: 1,
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$",
        description: "探测时间（ISO 8601，如 2026-11-16T10:00:00Z）",
      },
      agentVersion: {
        type: "string",
        minLength: 1,
        description: "探测时的 agent 版本（结论漂移时用来判断是否要重探）",
      },
    },
    description: "能力结论的探测记录",
  };

  const schema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "WeMind agent definition",
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
  if (requirementGroups.length === 1) schema.anyOf = requirementGroups[0];
  else if (requirementGroups.length > 1)
    schema.allOf = requirementGroups.map((group) => ({ anyOf: group }));
  return schema;
}
