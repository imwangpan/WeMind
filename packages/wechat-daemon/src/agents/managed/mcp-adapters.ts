import fs from "node:fs";
import path from "node:path";

import type { ResolvedAgent } from "../brain-agents.js";
import type {
  AgentMcpCatalog,
  AgentMcpConversion,
  AgentMcpDeclaration,
  AgentMcpFormatAdapter,
} from "../agent-adapter.js";
import { writeJsonAtomic } from "../../shared/io/atomic-json.js";
import { parseJsonc, readMcpServers, toAcpMcpServers, withMcpServers } from "./agent-mcp.js";
import { parseDshMcpServers } from "./dsh-mcp.js";
import { parseTomlMcpServers } from "./toml-mcp.js";

export type McpCatalog = AgentMcpCatalog;
export type AcpConversion = AgentMcpConversion;
export type { AgentMcpDeclaration };

/**
 * 一种 MCP **文件格式**的适配器：把「这种格式的 MCP 放在哪、长什么样、怎么写、怎么交给 ACP」
 * 集中到一处。brain/worker 的副本层只负责算激活集/排除集，不再按 agent 名或格式分支。
 *
 * 实现按**文件格式**划分，与 agent 名无关（多个 agent 可以共用同一种格式）：
 * - `jsonMcpServers`：顶层 `{ "mcpServers": { 名: {...} } }`
 * - `jsonMcpNested`：嵌套 `{ "mcp": { "servers": { 名: {...} } } }`（与 model 等同文件，默认补 permission:allow）
 * - `tomlMcpServers`：Codex `config.toml` 的 `[mcp_servers.*]`，只读；写入一律视为配置错误
 * - `dshProfileYaml`：DSH `profiles/<profile>/cordis.patch.yml` 里的 `@deepseek-ai/dsh-mcp-client` 条目，只读
 */
/** 兼容旧名字：外部 adapter 提供的 MCP 格式实现与内置实现同一接口。 */
export type McpAdapter = AgentMcpFormatAdapter;

/** 可选 MCP 的定义来源文件；`WEMIND_MCP_CATALOG` / `WECHAT_MCP_CATALOG` 可覆盖为任意路径。 */
export function mcpCatalogPath(ag: ResolvedAgent): string | null {
  const override = process.env.WEMIND_MCP_CATALOG?.trim() || process.env.WECHAT_MCP_CATALOG?.trim();
  if (override) return override;
  if (!ag.realHome) return null;
  return path.join(ag.realHome, ag.catalogFile || "settings/mcp.json");
}

/** 该 Agent 的 MCP 配置文件（相对配置目录的 `mcpConfigFile`）。 */
export function mcpConfigPath(ag: ResolvedAgent, configDir: string): string {
  return path.join(configDir, ag.mcpConfigFile || "settings/mcp.json");
}

function readJsonRaw(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw new Error(`无法读取 ${file}：${(e as Error)?.message ?? String(e)}`);
  }
}

function readJsonc(file: string): McpCatalog | null {
  try {
    const raw = readJsonRaw(file);
    return raw === null || !raw.trim() ? {} : parseJsonc(raw);
  } catch {
    return null;
  }
}

/** 写入前的严格读取：文件不存在/为空 → `{}`；存在但解析失败 → 抛错（不能拿 `{}` 覆盖掉用户的其它键）。 */
function readJsoncStrict(file: string): McpCatalog {
  const raw = readJsonRaw(file);
  if (raw === null || !raw.trim()) return {};
  const parsed = parseJsonc(raw);
  if (!parsed) {
    throw new Error(`无法解析 ${file}（JSON/JSONC 语法错误）；为避免丢掉其它配置键，本次不写入`);
  }
  return parsed;
}

function readJsonServers(file: string, format: "mcpServers" | "mcp.servers"): McpCatalog {
  return readMcpServers(readJsonc(file), format);
}

function writeJsonServers(
  file: string,
  servers: McpCatalog,
  format: "mcpServers" | "mcp.servers",
  finalize?: (config: McpCatalog) => void,
): void {
  const next = withMcpServers(readJsoncStrict(file), servers, format);
  finalize?.(next);
  writeJsonAtomic(file, next);
}

/** 复制到目标文件时先断开硬链接（否则 copyFileSync 会写穿到真实配置）。 */
export function copyFileIndependent(src: string, dst: string): void {
  try {
    const st = fs.lstatSync(dst);
    if (st.isSymbolicLink() || st.nlink > 1) fs.rmSync(dst, { force: true });
  } catch {
    /* 目标不存在 */
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
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
  readCatalog: (file) => readJsonServers(file, "mcpServers"),
  writeCatalog: (file, servers) => writeJsonServers(file, servers, "mcpServers"),
  stripSettings: (base) => {
    delete base.mcpServers;
  },
  toAcp: (servers, exclude) => toAcpMcpServers(servers, { exclude }),
  nativeCatalog: () => ({}),
};

/** 嵌套 `{ "mcp": { "servers": { ... } } }`。 */
const jsonMcpNestedAdapter: McpAdapter = {
  id: "jsonMcpNested",
  nativeOwned: false,
  readCatalog: (file) => readJsonServers(file, "mcp.servers"),
  writeCatalog: (file, servers) =>
    writeJsonServers(file, servers, "mcp.servers", (config) => {
      // `opencode acp` 不接受 --auto；免审批只能走配置。用户显式设过就保留用户值。
      if (config.permission === undefined) config.permission = "allow";
    }),
  stripSettings: (base) => {
    delete base.mcp;
  },
  toAcp: (servers, exclude) => toAcpMcpServers(servers, { exclude }),
  nativeCatalog: () => ({}),
};

/** TOML `[mcp_servers.*]`，只读。 */
const tomlMcpServersAdapter: McpAdapter = {
  id: "tomlMcpServers",
  nativeOwned: true,
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

/** DSH profile YAML：MCP 是 patch 列表里的 `@deepseek-ai/dsh-mcp-client` 条目。只读。 */
const dshProfileYamlAdapter: McpAdapter = {
  id: "dshProfileYaml",
  nativeOwned: true,
  readCatalog: (file) => {
    try {
      return parseDshMcpServers(fs.readFileSync(file, "utf-8"));
    } catch {
      return {};
    }
  },
  writeCatalog: () => {
    throw new Error(
      "DSH 的 MCP 写在 profile YAML 里，WeMind 只读：请让 Agent 自己处理，或改用 ACP 下发",
    );
  },
  stripSettings: () => {
    /* profile YAML 不是 settingsBase */
  },
  toAcp: (servers, exclude) => toAcpMcpServers(servers, { exclude }),
  nativeCatalog: (file) => dshProfileYamlAdapter.readCatalog(file),
};

export const MCP_ADAPTERS = {
  jsonMcpServers: jsonMcpServersAdapter,
  jsonMcpNested: jsonMcpNestedAdapter,
  tomlMcpServers: tomlMcpServersAdapter,
  dshProfileYaml: dshProfileYamlAdapter,
} as const;

/** 按 Agent 的配置格式选写入/设置继承适配器；原生只读格式（TOML / DSH profile）不参与写回。 */
export function mcpAdapterFor(ag: ResolvedAgent): McpAdapter {
  if (ag.hooks?.mcp) return ag.hooks.mcp;
  if (ag.mcpFormat === "dshProfileYaml") {
    return dshProfileYamlAdapter;
  }
  if (path.extname(ag.catalogFile ?? "").toLowerCase() === ".toml") {
    return tomlMcpServersAdapter;
  }
  return ag.mcpFormat === "mcp.servers" ? jsonMcpNestedAdapter : jsonMcpServersAdapter;
}

/** 按实际目录文件后缀读定义（`WEMIND_MCP_CATALOG` 可把目录指到 TOML）。 */
export function mcpAdapterForFile(ag: ResolvedAgent, file: string): McpAdapter {
  if (ag.hooks?.mcp) return ag.hooks.mcp;
  if (ag.mcpFormat === "dshProfileYaml") {
    return /\.ya?ml$/i.test(file) ? dshProfileYamlAdapter : jsonMcpServersAdapter;
  }
  return path.extname(file).toLowerCase() === ".toml" ? tomlMcpServersAdapter : mcpAdapterFor(ag);
}
