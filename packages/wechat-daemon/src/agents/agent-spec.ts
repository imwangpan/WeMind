import {
  AGENT_ADAPTER_API_VERSION,
  AGENT_DEFINITION_FIELDS,
  AGENT_DEFINITION_SCHEMA_VERSION,
  agentDefinitionJsonSchema,
  type AgentDefinition,
} from "./agent-definition.js";
import { agentsDir } from "./agent-registry.js";

/**
 * `wemind agent spec` 的内容源。
 *
 * 同一份字段表同时产出 Markdown 说明书与 JSON（含 JSON Schema），供人和 agent 读。
 * 探针能自动得到的字段只有协议层结论；文件格式、目录、凭据与启动参数仍要人工补，
 * 这一区分必须写在规格里，否则模型会把「探针跑通了」误读成「定义已经完整」。
 */

type SpecFieldMode = "probe" | "deep" | "manual";

type SpecFieldGuide = {
  mode: SpecFieldMode;
  where: string;
};

const FIELD_GUIDES: Record<string, SpecFieldGuide> = {
  name: {
    mode: "manual",
    where: "由你决定；必须与安装后的文件名一致（<name>.json），且不能是 auto",
  },
  bin: {
    mode: "manual",
    where: "agent 的安装文档 / --help / where.exe <bin>（Windows）/ command -v <bin>",
  },
  binWin: {
    mode: "manual",
    where: "Windows 安装产物；npm shim 常见 .cmd，必须写全名",
  },
  fallbackBinPaths: {
    mode: "manual",
    where: "安装器文档或默认安装目录；只有 PATH 找不到时才需要",
  },
  requiresBins: {
    mode: "manual",
    where: "agent 安装文档的依赖说明（适配器类 agent 往往还需要本体 CLI）",
  },
  args: {
    mode: "manual",
    where: "agent --help 里进入 ACP/stdio 模式的参数；探针不会替你猜参数",
  },
  shell: {
    mode: "manual",
    where: "Windows 上 .cmd/.bat 需要 true；其它平台通常省略",
  },
  homeEnvVar: {
    mode: "manual",
    where: "agent 文档的环境变量表 / 源码里读取的 HOME 类变量",
  },
  realHome: {
    mode: "manual",
    where: "agent 文档的配置目录；首次运行后观察用户目录，或问用户实际安装位置",
  },
  configSubdir: {
    mode: "manual",
    where: "agent 在 homeEnvVar 下实际创建/读取的子目录（如 .gemini）",
  },
  inheritDirs: {
    mode: "manual",
    where: "用户希望跨会话共享的记忆/技能目录；不确定就留空",
  },
  inheritFiles: {
    mode: "manual",
    where: "用户级规则/记忆文件（AGENTS.md、CLAUDE.md 等）",
  },
  extraConfigFiles: {
    mode: "manual",
    where: "agent 在 realHome 之外读取的配置文件；不确定就留空",
  },
  mcpFormat: {
    mode: "manual",
    where: "MCP 配置文件格式；内置只支持 mcpServers / mcp.servers / dshProfileYaml",
  },
  mcpConfigFile: {
    mode: "manual",
    where: "agent 文档里的 MCP 配置路径；探针不读它的配置格式",
  },
  catalogFile: {
    mode: "manual",
    where: "列出用户已有 MCP 的只读来源；通常与 mcpConfigFile 相同或在其附近",
  },
  acpMcpServers: {
    mode: "probe",
    where: "探针用非空 mcpServers 起 session/new；成功只代表「接受」，不代表实际加载",
  },
  mcpDelivery: {
    mode: "probe",
    where: "探针根据 acpMcpServers 给建议：接受 ACP 下发用 acp，否则写配置文件用 config",
  },
  restore: {
    mode: "probe",
    where: "探针读 initialize 的 loadSession/sessionCapabilities.resume，并实际试 load/resume",
  },
  replayOnLoad: {
    mode: "deep",
    where: "探针 --deep 在 load/resume 后观察是否仍有历史帧回放",
  },
  images: {
    mode: "deep",
    where: "探针 --deep --image 发一张 1x1 PNG；只看 initialize 的声明可能会误判",
  },
  sessionMode: {
    mode: "probe",
    where: "探针列出 session/new 的 availableModes/configOptions 候选；选哪个免审批模式要人工确认",
  },
  isolateSessions: {
    mode: "manual",
    where: "需要按账号隔离会话、且 agent 支持对应启动参数时才写；语义由 adapter 解释",
  },
  firstFrameMs: {
    mode: "deep",
    where: "探针 --deep 的首帧耗时；只有慢启动/无 activity 帧时才需要覆盖",
  },
  heartbeatMs: {
    mode: "manual",
    where: "静默期心跳间隔；通常留空，除非 agent 长时间没有帧且有明确实测",
  },
  model: {
    mode: "manual",
    where: "可留空用 agent 默认；需要固定模型时填 session/set_config_option 的值",
  },
  modelArg: {
    mode: "manual",
    where: "agent 不支持 set_config_option 时的 --model 参数名",
  },
  realProfile: {
    mode: "manual",
    where: "DSH 等 profile 类 agent 的真实 profile 名；普通 agent 留空",
  },
  env: {
    mode: "manual",
    where: "managed 下必须强制注入的环境变量；direct 下不生效",
  },
  envDefaults: {
    mode: "manual",
    where: "审批/免确认类默认环境变量；父进程显式设置时优先",
  },
  settingsBase: {
    mode: "manual",
    where: "设置与 MCP 同文件时，managed 要整份复制的设置文件",
  },
  settingsDefaults: {
    mode: "manual",
    where: "managed 副本要补的默认设置键；用户显式设过则保留用户值",
  },
  credentialFiles: {
    mode: "manual",
    where: "登录后产生的凭据文件；看 agent 文档或实际配置目录",
  },
  identityFiles: {
    mode: "manual",
    where: "必须与真实安装一致的机器/账号标识文件",
  },
  kiroEngine: {
    mode: "manual",
    where: "kiro 专用；新定义通常不需要，别为了「看起来完整」而抄",
  },
  notes: {
    mode: "manual",
    where: "给维护者的经验说明；只作文档用途，不改变行为",
  },
};

const CORRECT_EXAMPLE: AgentDefinition = {
  schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
  name: "test-agent",
  bin: "test-agent",
  args: ["--acp"],
  realHome: "~/.test-agent",
  mcpFormat: "mcpServers",
  mcpConfigFile: "settings/mcp.json",
  catalogFile: "settings/mcp.json",
  acpMcpServers: false,
  mcpDelivery: "config",
  restore: "load",
  images: false,
  notes: ["这是示例；真实字段以你的 agent 文档与实测为准。"],
};

const WRONG_EXAMPLE = {
  schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
  name: "test-agent",
  bin: "test-agent",
  args: ["--acp"],
  realhome: "~/.test-agent",
};

function probeLabel(mode: SpecFieldMode): string {
  if (mode === "probe") return "自动";
  if (mode === "deep") return "--deep";
  return "人工";
}

function fieldRows(): Array<{
  key: string;
  required: boolean;
  probe: SpecFieldMode;
  desc: string;
  where: string;
}> {
  return AGENT_DEFINITION_FIELDS.map((field) => {
    const guide = FIELD_GUIDES[field.key];
    return {
      key: field.key,
      required: field.required === true,
      probe: guide?.mode ?? "manual",
      desc: field.desc,
      where: guide?.where ?? "agent 文档 / 源码 / 实际配置文件；探针不能推断",
    };
  });
}

const COMMANDS = {
  spec: "wemind agent spec [--json]",
  probe: "wemind agent probe <bin> [--args <JSON数组|空格分隔>] [--draft] [--deep]",
  checkSchema: "wemind agent check <name|文件.json> --schema",
  check: "wemind agent check <name|文件.json> [--deep]",
  install:
    "wemind agent add <包目录|package.json|定义.json>（复制到 ~/.wemind/.agents/；也可手工保存 <name>.json）",
  remove: "wemind agent remove <name>（只删本机/数据包层；同名内置定义恢复）",
  select: "wemind brain switch <name>（写完不会自动切换；微信里说「切到 <name>」）",
} as const;

/** adapter hook 契约（人读与机器可读都用同一份）。 */
const ADAPTER_HOOKS = [
  ["mcp.*", "自定义 MCP 文件格式的读/写/剥离/ACP 转换"],
  ["settings.inherit", "managed 副本继承非 MCP 设置"],
  [
    "profile.readDefaultModel / copyForManaged / managedFiles / stripManagedWechat / hints",
    "profile 类 agent 的默认模型、副本复制、微信 MCP 清理与用户提示",
  ],
  ["env.derive / binOverride", "从凭据文件派生环境变量；旧版 bin 覆盖变量"],
  ["engine.prepareArgs", "引擎版本探测与启动参数整理"],
  [
    "spawn.prepareArgs / prepare / prepareManaged",
    "启动前派生参数与文件（如会话目录 patch、permissions.yaml）",
  ],
  ["fingerprint.volatile / extraFiles", "配置指纹里要排除的易变文件与额外配置文件"],
  ["paths.sensitive", "附件外发时要额外拦截的敏感路径"],
  ["hints.install / hints.auth / hints.autoProbe", "安装/认证提示与自动探测顺序"],
] as const;

/** 机器可读版本：字段、JSON Schema、命令与示例一次给全。 */
export function agentSpecJson(): Record<string, unknown> {
  return {
    schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
    adapterApiVersion: AGENT_ADAPTER_API_VERSION,
    adapterHooks: ADAPTER_HOOKS.map(([name, desc]) => ({ name, desc })),
    definitionDir: agentsDir(),
    commands: COMMANDS,
    fields: fieldRows(),
    jsonSchema: agentDefinitionJsonSchema(),
    examples: {
      correct: CORRECT_EXAMPLE,
      wrong: WRONG_EXAMPLE,
      wrongWhy:
        "realhome 是未知字段（正确写法 realHome）；未知字段整份拒绝，避免拼错后静默不生效。",
    },
    probeNotes: [
      "探针默认只做 initialize + session/new（可按需试 load/resume），不发真实 prompt。",
      "--deep 才会发一条真实 prompt；它会花钱，并可能把测试对话写进 agent 的会话历史。",
      "--image 需要配合 --deep，用来验证图片输入；只看 initialize 的能力声明可能会误判。",
      "探针成功只代表协议层可用；realHome / mcpFormat / 凭据/继承清单等仍需人工补。",
    ],
  };
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** 人读版本：给用户或大脑直接照着做，不需要先解析 JSON。 */
export function agentSpecMarkdown(): string {
  const rows = fieldRows();
  const lines = [
    `# WeMind agent 定义规格（schemaVersion ${AGENT_DEFINITION_SCHEMA_VERSION}）`,
    "",
    `定义目录：\`${agentsDir()}\`。文件名必须与 \`name\` 完全一致；同名会整条覆盖内置定义（不做字段合并）。`,
    "",
    "## 自助接入流程",
    "",
    "1. 先跑 `wemind agent probe <bin> --args <进入 ACP 的参数> --draft`，拿到协议层草稿。",
    "2. 按下面的字段表补 `realHome`、`mcpFormat`、`mcpConfigFile`、凭据/继承清单等探针推不出的字段。",
    "3. 保存到临时文件，先跑 `wemind agent check <文件> --schema` 修 schema；再跑 `wemind agent check <文件>` 做真实握手。",
    "4. 握手通过后用 `wemind agent add <包目录|文件.json>` 安装（或手工保存到定义目录），再运行 `wemind agent list` / `wemind brain switch <name>`。",
    "5. **不要替用户自动切换大脑**；完成后回一句「要切过去就说『切到 <name>』」。",
    "",
    "探针默认不发真实 prompt；只有显式 `--deep` 才会花钱并可能写入 agent 的会话历史。",
    "",
    "## 字段表",
    "",
    "| 字段 | 必填 | 探针 | 说明 | 去哪里找 / 怎么填 |",
    "|:---|:---:|:---:|:---|:---|",
  ];
  for (const row of rows) {
    lines.push(
      `| \`${row.key}\` | ${row.required ? "是" : "否"} | ${probeLabel(row.probe)} | ${escapeCell(row.desc)} | ${escapeCell(row.where)} |`,
    );
  }
  lines.push(
    "",
    "## 正确示例",
    "",
    "```json",
    JSON.stringify(CORRECT_EXAMPLE, null, 2),
    "```",
    "",
    "## 错误示例",
    "",
    "```json",
    JSON.stringify(WRONG_EXAMPLE, null, 2),
    "```",
    "",
    "`realhome` 是未知字段（正确写法 `realHome`）。未知字段会整份拒绝，避免拼错后静默不生效。",
    "",
    "## 校验、安装与选择",
    "",
    `- 只校验数据：\`${COMMANDS.checkSchema}\``,
    `- 校验 + 真实握手：\`${COMMANDS.check}\`（\`--deep\` 再发一条真实 prompt）`,
    `- 安装：${COMMANDS.install}`,
    `- 移除：${COMMANDS.remove}`,
    `- 选择：${COMMANDS.select}`,
    "",
    "## adapter 插件（数据表达不了时才用）",
    "",
    "`adapter` 指向一个模块（包名、绝对路径或以 `./` 开头的相对路径），模块默认导出 `{ apiVersion: 1, ...hooks }`。",
    `契约版本不匹配、未知 hook、模块无法解析都 fail-closed。可用 hook：`,
    "",
    ...ADAPTER_HOOKS.map(([name, desc]) => `- \`${name}\`：${desc}`),
    "",
    "**永不开放**：会话恢复策略、回合帧处理、静默等待、`session/request_permission` 应答与任何反向请求；这些由 WeMind 统一实现。",
    "自定义 `mcpFormat` 必须在 adapter 里提供 `mcp` 实现；内置格式只有 `mcpServers` / `mcp.servers` / `dshProfileYaml`。",
    "用 `wemind agent add <包目录|package.json|定义.json>` 安装时，包根可放 `wemind-agent.json`，或在 `package.json` 的 `wemind.definition` / `wemind.definitions` 里声明；相对路径的 adapter 会被复制到定义目录。",
    "",
    "## 边界",
    "",
    "- `adapter` 会执行代码；安装即授权。`agent list` / `agent show` 会显示来源，`agent add` 会提示哪些定义带代码。",
    "- 外部模块随 daemon 进程加载；运行期不联网拉取。ESM 插件由 CLI/daemon 启动时预加载，新增/修改后运行 `wemind config reload`。",
    "- 未知字段、版本不匹配、文件名与 `name` 不一致都 fail-closed；错误会给出字段路径与修法。",
    "- 定义写好不会自动切换大脑；用户明确要求切换时才执行 `wemind brain switch` 或让用户在微信里说「切到 <name>」。",
    "",
    "机器可读版本（含 JSON Schema）：`wemind agent spec --json`。",
  );
  return lines.join("\n");
}
