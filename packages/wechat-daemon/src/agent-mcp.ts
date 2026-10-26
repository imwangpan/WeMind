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

// ---- ACP 传输：把 catalog 条目转成 session/new 的 mcpServers（mcpViaAcp 预设用） ----

/** ACP `session/new` 的 stdio MCP 声明（env 是 `{name,value}[]`，与 kiro/opencode 的 map 不同）。 */
export type AcpMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};

/** ACP `session/new` 的 HTTP MCP 声明（官方 DSH 已广告 http:true；SSE 不支持）。 */
export type AcpMcpHttpServer = {
  name: string;
  type: "http";
  url: string;
  headers: Array<{ name: string; value: string }>;
};

function envEntries(map: unknown): Array<{ name: string; value: string }> {
  if (!isObj(map)) return [];
  return Object.entries(map)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([name, v]) => ({ name, value: String(v) }));
}

/** 该 catalog 条目能否转成 ACP 声明（addMcp 加载前的预校验也用它）。 */
export function isConvertibleToAcp(entry: unknown): boolean {
  if (!isObj(entry)) return false;
  if (typeof entry.command === "string" && entry.command) return true; // kiro local
  if (Array.isArray(entry.command) && typeof entry.command[0] === "string" && entry.command[0])
    return true; // opencode local
  if (typeof entry.url === "string" && entry.url) return true; // remote/http
  return false;
}

/**
 * 把 catalog 的 server 定义表转成 ACP `mcpServers`（stdio / HTTP）。
 * - kiro `{ command, args, env }` → stdio；
 * - opencode `{ type:"local", command:[...], environment }` → stdio（拆 command[0]/args）；
 * - `{ url }`（kiro 远程 / opencode remote）→ HTTP（SSE 不被 ACP 支持，无法从定义识别，由服务端拒绝）。
 * 返回转换结果与**被跳过的名字**（结构不认识/明显残缺）——调用方记日志，避免坏条目把整个 session 拖挂。
 */
export function toAcpMcpServers(
  servers: Record<string, unknown>,
  opts: { exclude?: Iterable<string> } = {},
): { servers: Array<AcpMcpServer | AcpMcpHttpServer>; skipped: string[] } {
  const exclude = new Set(opts.exclude ?? []);
  const out: Array<AcpMcpServer | AcpMcpHttpServer> = [];
  const skipped: string[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (exclude.has(name)) continue;
    if (!isObj(entry)) {
      skipped.push(name);
      continue;
    }
    // opencode local：command 是数组
    if (Array.isArray(entry.command)) {
      const cmd = entry.command[0];
      if (typeof cmd !== "string" || !cmd) {
        skipped.push(name);
        continue;
      }
      out.push({
        name,
        command: cmd,
        args: entry.command.slice(1).map(String),
        env: envEntries(entry.environment ?? entry.env),
      });
      continue;
    }
    // kiro local：command 是字符串
    if (typeof entry.command === "string" && entry.command) {
      out.push({
        name,
        command: entry.command,
        args: Array.isArray(entry.args) ? entry.args.map(String) : [],
        env: envEntries(entry.env),
      });
      continue;
    }
    // 远程：url → HTTP（header 兼容 map 与 {name,value}[] 两种写法）
    if (typeof entry.url === "string" && entry.url) {
      const rawHeaders = entry.headers;
      const headers = isObj(rawHeaders)
        ? envEntries(rawHeaders)
        : Array.isArray(rawHeaders)
          ? rawHeaders
              .filter(
                (h): h is { name: string; value: string } =>
                  isObj(h) && typeof (h as any).name === "string",
              )
              .map((h) => ({
                name: String((h as any).name),
                value: String((h as any).value ?? ""),
              }))
          : [];
      out.push({ name, type: "http", url: entry.url, headers });
      continue;
    }
    skipped.push(name);
  }
  return { servers: out, skipped };
}
