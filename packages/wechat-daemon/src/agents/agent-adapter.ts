/**
 * Agent adapter（插件）契约。
 *
 * 定义是纯数据；只有数据表达不了的东西才走这里：文件格式、启动前派生文件、引擎差异、凭据派生、提示文案。
 * 契约版本由定义里的 `adapter.apiVersion` 声明，不匹配 **fail-closed**——外部产物与 daemon 更新节奏独立，
 * 「不认识的 hook 忽略」会表现成「接上了但没生效」，比直接报错更难排查。
 *
 * 三条边界（刻意不开放）：
 * - 会话恢复/回合帧/静默等待：brain / worker / brain check 三处共用，开放后最容易出现「终端能用、微信不能用」；
 * - `session/request_permission` 与任何反向请求：权限应答必须三处同一实现；
 * - MCP 的安全清单本身（微信条目剥离、UNC/数据流拦截、敏感文件 denylist）：插件只能补自己的格式/路径，不能替换这些闸。
 */
import type { AgentDefinition } from "./agent-definition.js";
import type { AgentRole } from "./brain-config.js";
import type { AcpMcpHttpServer, AcpMcpServer } from "./managed/agent-mcp.js";

export type AgentMcpCatalog = Record<string, unknown>;

/** ACP `session/new|resume` 能接受的 MCP 声明（与连接层同一类型）。 */
export type AgentMcpDeclaration = AcpMcpServer | AcpMcpHttpServer;

export type AgentMcpConversion = { servers: AgentMcpDeclaration[]; skipped: string[] };

/**
 * 一种 MCP **文件格式**的适配器。与 agent 名无关：多个 agent 可以共用同一种格式。
 * 内置四种实现在 `managed/mcp-adapters.ts`；外部 adapter 可以提供自己的实现。
 */
export interface AgentMcpFormatAdapter {
  readonly id: string;
  /** Agent 自己会加载、WeMind 改不了的真实配置文件（Codex TOML、DSH profile YAML）。 */
  readonly nativeOwned: boolean;
  readCatalog(file: string): AgentMcpCatalog;
  writeCatalog(file: string, servers: AgentMcpCatalog): void;
  /** 从设置基底里删掉该格式的 MCP 段。 */
  stripSettings(base: AgentMcpCatalog): void;
  /** 转成 ACP `session/new|resume` 的 mcpServers。 */
  toAcp(servers: AgentMcpCatalog, exclude?: Iterable<string>): AgentMcpConversion;
  /** 该 Agent 原生加载的 MCP（非原生适配器返回空表）。 */
  nativeCatalog(file: string): AgentMcpCatalog;
}

/**
 * hook 能看到的 agent 字段。用最小结构而不是整个 `ResolvedAgent`：
 * 外部插件只该依赖稳定字段，内部解析细节（binPath/available 等）不进入契约。
 */
export type AgentAdapterAgent = {
  name: string;
  bin: string;
  args: string[];
  realHome?: string;
  realProfile?: string;
  extraConfigFiles: string[];
  mcpFormat: string;
  mcpDelivery: "config" | "acp";
  acpMcpServers: boolean;
  requiresBins: string[];
  /** `engine.prepareArgs` 的结论（如 kiro 的 v2/v3）。 */
  engine?: string;
  /** `spawn.prepareArgs` 声明的启动前文件。 */
  sessionPatch?: { file: string; root: string };
};

/** `paths.sensitive` 只需要这几个字段（attachments 里拿到的是定义，不启动进程）。 */
export type AgentAdapterPathAgent = Pick<
  AgentAdapterAgent,
  "name" | "realHome" | "realProfile" | "extraConfigFiles"
>;

export type AgentAdapter = {
  /** 必须等于 `AGENT_ADAPTER_API_VERSION`。 */
  apiVersion: number;

  /** 自定义 MCP 文件格式。定义里的 `mcpFormat` 不是内置三种时，必须提供。 */
  mcp?: AgentMcpFormatAdapter;

  settings?: {
    /** managed 下继承「非 MCP」设置。替换各 MCP 格式里的按文件名特判。 */
    inherit?(ctx: { agent: AgentAdapterAgent; realHome: string; targetConfigDir: string }): void;
  };

  profile?: {
    /** 从 agent 自己的 profile 读默认模型（只读，不合成配置）。 */
    readDefaultModel?(realHome: string, profile: string): string | null;
    /** 把真实 profile 用户层复制进 managed 副本；返回被剔除的条目名。 */
    copyForManaged?(ctx: {
      agent: AgentAdapterAgent;
      realHome: string;
      profile: string;
      targetHome: string;
      stripAllMcp: boolean;
    }): string[];
    /** 副本里属于 profile 的文件（供微信 MCP 检查和指纹）。 */
    managedFiles?(ctx: { agent: AgentAdapterAgent; base: string }): readonly string[];
    /** 就地剔除副本 profile 文件里的微信 MCP 条目；返回被剔除的条目名。 */
    stripManagedWechat?(file: string): string[];
    /** 缺配置/模型过期时给用户的可执行提示。 */
    hints?(
      realHome: string,
      profile: string,
    ): { override?: string | null; model?: string | null } | undefined;
  };

  env?: {
    /** 从 agent 自己的凭据文件派生环境变量（父进程显式值永远优先）。 */
    derive?(ctx: { realHome?: string; parentEnv: NodeJS.ProcessEnv }): Record<string, string>;
    /** 额外的「旧版 bin 覆盖」环境变量；只影响启动哪个二进制。 */
    binOverride?(ctx: { parentEnv: NodeJS.ProcessEnv }): string | undefined;
    /** 给 `agent show --explain` 展示用的变量名。 */
    binOverrideNames?: readonly string[];
  };

  engine?: {
    /**
     * 引擎探测与参数整理。返回的 `engine` 是稳定的引擎 id（如 kiro 的 v2/v3），
     * `args` 是最终启动参数。不能做除只读探测外的副作用。
     */
    prepareArgs?(ctx: {
      definition: AgentDefinition;
      args: string[];
      realHome?: string;
      binPath: string | null;
    }): { args: string[]; engine?: string } | undefined;
  };

  spawn?: {
    /** 解析期生成附加参数与需要随后落盘的文件（如 DSH 的 `--patch`）。 */
    prepareArgs?(ctx: {
      definition: AgentDefinition;
      role: AgentRole;
      dataDir: string;
      args: string[];
      homeMode: "direct" | "managed";
    }): { args: string[]; sessionPatch?: { file: string; root: string } } | undefined;
    /** 启动前落盘 `prepareArgs` 声明的文件。 */
    prepare?(ctx: { agent: AgentAdapterAgent }): void;
    /** managed 副本准备好后（如 kiro v3 的 permissions.yaml）。 */
    prepareManaged?(ctx: { agent: AgentAdapterAgent; configDir: string }): void;
  };

  fingerprint?: {
    /** 由 agent 高频写入、不能参与配置指纹的文件/目录名。 */
    volatile?: readonly string[];
    /** 除 settings/catalog/extraConfigFiles 外还要参与指纹的文件（如 profile 目录一层）。 */
    extraFiles?(ctx: { agent: AgentAdapterAgent; base: string }): readonly string[];
  };

  paths?: {
    /** 额外敏感路径（绝对路径或目录）；attachments 会按 realpath 判断是否命中。 */
    sensitive?(ctx: { agent: AgentAdapterPathAgent }): readonly string[];
  };

  hints?: {
    /** 找不到二进制/运行时时的安装指引。 */
    install?(ctx: {
      agentName: string;
      bin: string;
      requiresBins?: readonly string[];
    }): string | undefined;
    /** 认证失败时追加的建议。 */
    auth?(ctx: { agentName: string; message: string }): string | undefined;
    /** `auto` 探测顺序（数字小的优先）；不写 = 不参与自动探测。 */
    autoProbe?: number;
  };
};

/** 外部模块允许导出的顶层键（未知键 fail-closed，防拼错 hook 名）。 */
export const AGENT_ADAPTER_HOOKS = [
  "apiVersion",
  "mcp",
  "settings",
  "profile",
  "env",
  "engine",
  "spawn",
  "fingerprint",
  "paths",
  "hints",
] as const;

export type AgentAdapterHookName = (typeof AGENT_ADAPTER_HOOKS)[number];
