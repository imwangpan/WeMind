/**
 * MCP 配置的「格式」适配：不同 ACP agent 把 MCP server 定义放在不同文件、不同结构里。
 * 本模块只做纯数据的组织/解析（无文件 IO），便于单测；沙箱模块负责落盘。
 *
 * - `kiro`：独立文件 `settings/mcp.json`，结构 `{ "mcpServers": { 名: {command,args,env} } }`
 * - `opencode`：主配置 `opencode.json`，结构 `{ "mcp": { "servers": { 名: {type,command,environment} } } }`（与 model 等共处一文件）
 */
export type McpFormat = "kiro" | "opencode";

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 从配置对象读出 server 定义表（按格式）；缺失/异常一律返回空表。 */
export function readMcpServers(obj: unknown, format: McpFormat): Record<string, unknown> {
  if (!isObj(obj)) return {};
  const servers =
    format === "opencode"
      ? isObj((obj as any).mcp)
        ? (obj as any).mcp.servers
        : undefined
      : (obj as any).mcpServers;
  return isObj(servers) ? servers : {};
}

/** 把 server 定义表写回配置对象（按格式），返回**新对象**（不改原对象），并保留其它键（如 opencode 的 model）。 */
export function withMcpServers(
  obj: unknown,
  servers: Record<string, unknown>,
  format: McpFormat,
): Record<string, unknown> {
  const base: Record<string, unknown> = isObj(obj) ? { ...obj } : {};
  if (format === "opencode") {
    const mcp: Record<string, unknown> = isObj(base.mcp) ? { ...(base.mcp as object) } : {};
    mcp.servers = servers;
    base.mcp = mcp;
  } else {
    base.mcpServers = servers;
  }
  return base;
}

/**
 * 宽松解析 JSONC（去 // 与块注释、去尾随逗号）。仅用于把用户可能带注释的
 * opencode.jsonc 读成对象；失败返回 null（调用方按「无配置」处理，不抛）。
 */
export function parseJsonc(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* 继续做宽松清洗 */
  }
  try {
    const cleaned = text
      .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释
      .replace(/(^|[^:])\/\/.*$/gm, "$1") // 行注释（避开 http:// 里的 //）
      .replace(/,(\s*[}\]])/g, "$1"); // 尾随逗号
    const parsed = JSON.parse(cleaned);
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
