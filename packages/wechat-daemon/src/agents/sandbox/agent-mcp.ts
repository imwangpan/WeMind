/**
 * MCP 配置的「格式」适配：不同 ACP agent 把 MCP server 定义放在不同文件、不同键路径里。
 * 本模块只做纯数据的组织/解析（无文件 IO），便于单测；沙箱层（mcp-sandbox.ts、worker-sandbox.ts）负责写入磁盘。
 *
 * 取值是 JSON 里的**键路径**，与 agent 名无关：
 * - `mcpServers`：`{ "mcpServers": { 名: {command,args,env} } }`
 * - `mcp.servers`：`{ "mcp": { "servers": { 名: {type,command,environment} } } }`（与 model 等共处一文件）
 */
export type McpFormat = "mcpServers" | "mcp.servers";

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 永久禁用的 MCP 名字（规范化后比较：大小写、前后空白不算差异）。 */
export const FORBIDDEN_MCP_NAMES: ReadonlySet<string> = new Set(["wechat"]);

/** 名字规范化：` " Wechat "` 与 `wechat` 是同一个条目。 */
export function normalizeMcpName(name: string): string {
  return name.trim().toLowerCase();
}

export function isForbiddenMcpName(name: string): boolean {
  return FORBIDDEN_MCP_NAMES.has(normalizeMcpName(name));
}

/**
 * 一条 MCP 定义是不是微信 MCP：名字之外再看命令/参数/URL/env。
 * 只按名字（`wechat`）拦不住改名后的同一条目——它仍会启动 `wemind-mcp`、拿同一个 bot token 长轮询，与 daemon 抢消息。
 * brain 与 worker 共用（worker 的排除集同样是「按名字 + 按定义」两道）。
 */
export function isWechatMcpServer(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  const parts: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string") parts.push(v.trim().toLowerCase());
  };
  push(e.command);
  if (Array.isArray(e.command)) for (const x of e.command) push(x);
  if (Array.isArray(e.args)) for (const x of e.args) push(x);
  push(e.url);
  // 远程桥：`http://127.0.0.1:8787/wechat` 也是同一个入口（按路径段匹配，不匹配查询串）
  if (typeof e.url === "string") {
    try {
      const pathname = new URL(e.url).pathname.toLowerCase();
      if (pathname.split("/").some((seg) => seg === "wechat" || seg === "wemind-mcp")) {
        return true;
      }
    } catch {
      /* 不是合法 URL：前面已按整串匹配过 */
    }
  }
  // 通过 env 间接指定二进制（`BIN=wemind-mcp`）：定义本身看不出来，但同样会起第二个 poller
  const env = e.env ?? e.environment;
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const v of Object.values(env as Record<string, unknown>)) push(v);
  }
  return parts.some((p) => /wemind-mcp|@wemind\/wechat-mcp/.test(p));
}

/** 名字 + 定义两道合一（brain/worker/overlay 共用同一个判定）。 */
export function forbiddenMcpServer(name: string, entry: unknown): boolean {
  return isForbiddenMcpName(name) || isWechatMcpServer(entry);
}

/**
 * 从任意配置片段里找微信 MCP（overlay 写入前的校验用）：
 * 既看 `mcpServers`/`mcp.servers` 里的名字，也看任何位置出现的可识别定义（含数组里的定义）。
 * 返回人类可读的路径列表，空数组表示干净。
 */
export function findForbiddenMcpEntries(value: unknown): string[] {
  const hits: string[] = [];
  const containers = new Set(["mcpservers", "servers"]);
  const walk = (node: unknown, at: string, inServers: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${at}[${i}]`, inServers));
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (isWechatMcpServer(obj)) {
      hits.push(at || "(root)");
      return;
    }
    for (const [key, child] of Object.entries(obj)) {
      const norm = normalizeMcpName(key);
      const path2 = at ? `${at}.${key}` : key;
      if (norm === "mcp") {
        walk(child, path2, false);
        continue;
      }
      if (containers.has(norm) && child && typeof child === "object" && !Array.isArray(child)) {
        for (const [name, def] of Object.entries(child as Record<string, unknown>)) {
          if (forbiddenMcpServer(name, def)) hits.push(`${path2}.${name}`);
          else walk(def, `${path2}.${name}`, true);
        }
        continue;
      }
      if (inServers && child && typeof child === "object" && forbiddenMcpServer(key, child)) {
        hits.push(path2);
        continue;
      }
      walk(child, path2, inServers);
    }
  };
  walk(value, "", false);
  return [...new Set(hits)];
}

export function readMcpServers(obj: unknown, format: McpFormat): Record<string, unknown> {
  if (!isObj(obj)) return {};
  const servers =
    format === "mcp.servers"
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
  if (format === "mcp.servers") {
    const mcp: Record<string, unknown> = isObj(base.mcp) ? { ...(base.mcp as object) } : {};
    mcp.servers = servers;
    base.mcp = mcp;
  } else {
    base.mcpServers = servers;
  }
  return base;
}

/**
 * 宽松解析 JSONC（去 // 与块注释、去尾随逗号）。用于用户可能带注释的配置：opencode.jsonc、Gemini 的 settings.json（它自己用 strip-json-comments）；失败返回 null（调用方按「无配置」处理，不抛）。
 */
export function parseJsonc(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* 继续做宽松清洗 */
  }
  try {
    const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(text)));
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 字符串感知地去掉行注释与块注释：字符串里的同形文本是数据，不能删（手写正则版会改坏 `"x // y"`）。 */
function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      out += c;
      i++;
      while (i < text.length) {
        const ch = text[i];
        out += ch;
        i++;
        if (ch === "\\") {
          if (i < text.length) out += text[i++]; // 转义字符连同下一个字符原样保留
        } else if (ch === '"') break;
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 字符串感知地去掉尾随逗号（字符串里的 `,}` / `,]` 原样保留）。 */
function stripTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      out += c;
      i++;
      while (i < text.length) {
        const ch = text[i];
        out += ch;
        i++;
        if (ch === "\\") {
          if (i < text.length) out += text[i++];
        } else if (ch === '"') break;
      }
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

// ---- ACP 传输：把 catalog 条目转成 session/new 的 mcpServers（acpMcpServers 的 agent 用） ----

/** ACP `session/new` 的 stdio MCP 声明（env 是 `{name,value}[]`，与 kiro/opencode 的 map 不同）。 */
export type AcpMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};

/** ACP `session/new` 的 HTTP MCP 声明（官方 DSH 已声明 http:true；SSE 不支持）。 */
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
