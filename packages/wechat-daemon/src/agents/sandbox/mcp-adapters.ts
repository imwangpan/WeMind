import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ResolvedAgent } from "../brain-agents.js";
import {
  parseJsonc,
  readMcpServers,
  toAcpMcpServers,
  withMcpServers,
  type AcpMcpHttpServer,
  type AcpMcpServer,
} from "./agent-mcp.js";
import { parseTomlMcpServers } from "./toml-mcp.js";

export type McpCatalog = Record<string, unknown>;
export type AcpMcpDeclaration = AcpMcpServer | AcpMcpHttpServer;
export type AcpConversion = { servers: AcpMcpDeclaration[]; skipped: string[] };

/**
 * 一种 MCP **文件格式**的适配器：把「这种格式的 MCP 放在哪、长什么样、怎么写、怎么交给 ACP」
 * 集中到一处。brain/worker 沙箱只负责算激活集/排除集，不再按 agent 名或格式分支。
 *
 * 实现按**文件格式**划分，与 agent 名无关（多个 agent 可以共用同一种格式）：
 * - `jsonMcpServers`：顶层 `{ "mcpServers": { 名: {...} } }`
 * - `jsonMcpNested`：嵌套 `{ "mcp": { "servers": { 名: {...} } } }`（与 model 等同文件，默认补 permission:allow）
 * - `tomlMcpServers`：Codex `config.toml` 的 `[mcp_servers.*]`，只读；写入一律视为配置错误
 */
export interface McpAdapter {
  readonly id: "jsonMcpServers" | "jsonMcpNested" | "tomlMcpServers";
  /** Agent 自己会加载、WeMind 改不了的原生 MCP（目前只有 Codex） */
  readonly nativeOwned: boolean;
  /** real/mirror 视图下也要重建设置基底（MCP 与其它设置同文件时，不能直接链接真实文件） */
  readonly rebuildSettingsInView: boolean;
  /** 读真实目录文件里的 MCP 定义（只读；缺失/损坏返回空表） */
  readCatalog(file: string): McpCatalog;
  /** 把「当前有效集合」写进视图/沙箱文件，保留同文件的其它键 */
  writeCatalog(file: string, servers: McpCatalog): void;
  /** 从设置基底里删掉该格式的 MCP 段（`ag.settingsStrip` 之外的那部分） */
  stripSettings(base: McpCatalog): void;
  /** 转成 ACP `session/new|resume` 的 mcpServers */
  toAcp(servers: McpCatalog, exclude?: Iterable<string>): AcpConversion;
  /** 该 Agent 原生加载的 MCP（非原生适配器返回空表） */
  nativeCatalog(file: string): McpCatalog;
  /** `sandbox` 模式下继承「除 MCP 外」的设置；real/mirror 由配置视图链接，不调用 */
  inheritSettings?(ag: ResolvedAgent, realHome: string, targetConfigDir: string): void;
}

/** 可选 MCP 的定义来源文件；`WEMIND_MCP_CATALOG` / `WECHAT_MCP_CATALOG` 可覆盖为任意路径。 */
export function mcpCatalogPath(ag: ResolvedAgent): string {
  return (
    process.env.WEMIND_MCP_CATALOG?.trim() ||
    process.env.WECHAT_MCP_CATALOG?.trim() ||
    path.join(
      ag.realHome || path.join(os.homedir(), ".kiro"),
      ag.catalogFile || "settings/mcp.json",
    )
  );
}

/** 该 Agent 的 MCP 配置文件（相对配置目录的 `mcpConfigFile`）。 */
export function mcpConfigPath(ag: ResolvedAgent, configDir: string): string {
  return path.join(configDir, ag.mcpConfigFile || "settings/mcp.json");
}

function readJsonc(file: string): McpCatalog | null {
  try {
    return parseJsonc(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function readJsonServers(file: string, format: "kiro" | "opencode"): McpCatalog {
  return readMcpServers(readJsonc(file), format);
}

function writeJsonServers(
  file: string,
  servers: McpCatalog,
  format: "kiro" | "opencode",
  finalize?: (config: McpCatalog) => void,
): void {
  const next = withMcpServers(readJsonc(file) ?? {}, servers, format);
  finalize?.(next);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf-8");
}

function readTomlServers(file: string): McpCatalog {
  try {
    return parseTomlMcpServers(fs.readFileSync(file, "utf-8")).mcpServers;
  } catch {
    return {};
  }
}

/** 顶层 `{ "mcpServers": { ... } }`。 */
const jsonMcpServersAdapter: McpAdapter = {
  id: "jsonMcpServers",
  nativeOwned: false,
  rebuildSettingsInView: false,
  readCatalog: (file) => readJsonServers(file, "kiro"),
  writeCatalog: (file, servers) => writeJsonServers(file, servers, "kiro"),
  stripSettings: (base) => {
    delete base.mcpServers;
  },
  toAcp: (servers, exclude) => toAcpMcpServers(servers, { exclude }),
  nativeCatalog: () => ({}),
  inheritSettings: (_ag, realHome, targetConfigDir) => {
    const realSettings = path.join(realHome, "settings");
    const targetSettings = path.join(targetConfigDir, "settings");
    try {
      fs.mkdirSync(targetSettings, { recursive: true });
    } catch {
      /* ignore */
    }
    let names: string[] = [];
    try {
      names = fs.readdirSync(realSettings);
    } catch {
      /* 真实配置目录不存在：没有可继承的 settings */
    }
    for (const name of names) {
      if (name === "mcp.json") continue; // MCP 必须由激活集/全量集权威生成
      try {
        const src = path.join(realSettings, name);
        if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(targetSettings, name));
      } catch {
        /* best-effort */
      }
    }
  },
};

/** 嵌套 `{ "mcp": { "servers": { ... } } }`。 */
const jsonMcpNestedAdapter: McpAdapter = {
  id: "jsonMcpNested",
  nativeOwned: false,
  rebuildSettingsInView: true,
  readCatalog: (file) => readJsonServers(file, "opencode"),
  writeCatalog: (file, servers) =>
    writeJsonServers(file, servers, "opencode", (config) => {
      // `opencode acp` 不接受 --auto；免审批只能走配置。用户显式设过就保留用户值。
      if (config.permission === undefined) config.permission = "allow";
    }),
  stripSettings: (base) => {
    delete base.mcp;
  },
  toAcp: (servers, exclude) => toAcpMcpServers(servers, { exclude }),
  nativeCatalog: () => ({}),
  inheritSettings: (ag, realHome, targetConfigDir) => {
    const src = ["opencode.json", "opencode.jsonc"]
      .map((name) => path.join(realHome, name))
      .find((file) => fs.existsSync(file));
    if (!src) return;
    let parsed: McpCatalog | null = null;
    try {
      const raw = fs.readFileSync(src, "utf-8");
      parsed = src.endsWith(".jsonc") ? parseJsonc(raw) : (JSON.parse(raw) as McpCatalog);
    } catch {
      return;
    }
    if (!parsed) return;
    delete parsed.mcp; // MCP 由激活集/全量集权威覆盖
    const file = mcpConfigPath(ag, targetConfigDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2), "utf-8");
  },
};

/** TOML `[mcp_servers.*]`，只读。 */
const tomlMcpServersAdapter: McpAdapter = {
  id: "tomlMcpServers",
  nativeOwned: true,
  rebuildSettingsInView: false,
  readCatalog: readTomlServers,
  writeCatalog: () => {
    throw new Error("TOML 形式的 MCP 配置只读：请让 Agent 自己加载，或改用 ACP 下发");
  },
  stripSettings: () => {
    /* TOML 适配器不参与 settingsBase */
  },
  toAcp: (servers, exclude) => toAcpMcpServers(servers, { exclude }),
  nativeCatalog: readTomlServers,
};

export const MCP_ADAPTERS = {
  jsonMcpServers: jsonMcpServersAdapter,
  jsonMcpNested: jsonMcpNestedAdapter,
  tomlMcpServers: tomlMcpServersAdapter,
} as const;

/** 按 Agent 的配置格式选写入/设置继承适配器；TOML 且走 ACP 的 Agent 用只读适配器。 */
export function mcpAdapterFor(ag: ResolvedAgent): McpAdapter {
  if (ag.mcpViaAcp && path.extname(ag.catalogFile ?? "").toLowerCase() === ".toml") {
    return tomlMcpServersAdapter;
  }
  // 预设里的 mcpFormat 是历史命名（"kiro"/"opencode"），含义只是 JSON 键路径的形状。
  return ag.mcpFormat === "opencode" ? jsonMcpNestedAdapter : jsonMcpServersAdapter;
}

/** 按实际目录文件后缀读定义（`WEMIND_MCP_CATALOG` 可把目录指到 TOML）。 */
export function mcpAdapterForFile(ag: ResolvedAgent, file: string): McpAdapter {
  return path.extname(file).toLowerCase() === ".toml" ? tomlMcpServersAdapter : mcpAdapterFor(ag);
}
