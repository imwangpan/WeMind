/**
 * 只读解析 Codex `config.toml` 里的 `[mcp_servers.*]`：
 * - 目的只有一个：让 `加载/列出` 能看到 Codex 原生 MCP 的名字与定义，并转成 ACP `mcpServers`。
 * - **不是通用 TOML 实现**：支持字符串、字符串数组、内联表、`[mcp_servers.x.env]` 子表、带引号的键；
 *   其它值（日期、浮点、数组表 `[[...]]`、多行字符串）跳过，不影响其余条目。
 * - **永远不写回 TOML**；Codex 的配置文件由 Codex 自己维护（WeMind 只读）。
 */

type TomlTable = Record<string, unknown>;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 去掉行内注释：`#` 只在字符串外才算注释。 */
function stripComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (quote === '"' && ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

/** 在字符串/嵌套之外找分隔符（`=` 或 `,`）。 */
function indexOfTopLevel(s: string, target: string): number {
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (quote === '"' && ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (depth === 0 && ch === target) return i;
  }
  return -1;
}

/** 按顶层逗号切分；空段丢弃。 */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let rest = s;
  for (;;) {
    const i = indexOfTopLevel(rest, ",");
    if (i < 0) {
      if (rest.trim()) out.push(rest.trim());
      return out;
    }
    const head = rest.slice(0, i).trim();
    if (head) out.push(head);
    rest = rest.slice(i + 1);
  }
}

/** 点分键：`a.b."c.d"` → [a, b, c.d]。 */
function splitDotted(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (quote === '"' && ch === "\\") {
        buf += ch + (s[++i] ?? "");
      } else if (ch === quote) {
        quote = null;
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ".") {
      out.push(buf.trim());
      buf = "";
    } else buf += ch;
  }
  out.push(buf.trim());
  return out.filter(Boolean);
}

function parseString(s: string): string | null {
  const quote = s[0];
  if (quote !== '"' && quote !== "'") return null;
  const end = s.lastIndexOf(quote);
  if (end <= 0) return null;
  const body = s.slice(1, end);
  if (quote === "'") return body;
  return body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m, esc: string) => {
    if (esc[0] === "u") return String.fromCharCode(parseInt(esc.slice(1), 16));
    return (
      ({ n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" } as Record<string, string>)[esc] ?? esc
    );
  });
}

function parseValue(raw: string): unknown {
  const s = raw.trim();
  if (!s) return "";
  if (s.startsWith('"') || s.startsWith("'")) return parseString(s) ?? "";
  if (s.startsWith("[")) {
    const end = s.lastIndexOf("]");
    return end < 0 ? [] : splitTopLevel(s.slice(1, end)).map(parseValue);
  }
  if (s.startsWith("{")) {
    const end = s.lastIndexOf("}");
    const obj: TomlTable = {};
    if (end < 0) return obj;
    for (const pair of splitTopLevel(s.slice(1, end))) {
      const eq = indexOfTopLevel(pair, "=");
      if (eq < 0) continue;
      const key = splitDotted(pair.slice(0, eq).trim()).join(".");
      if (key) obj[key] = parseValue(pair.slice(eq + 1));
    }
    return obj;
  }
  if (s === "true") return true;
  if (s === "false") return false;
  const n = Number(s);
  return s !== "" && Number.isFinite(n) ? n : s;
}

function ensureTable(root: TomlTable, parts: string[]): TomlTable {
  let cur = root;
  for (const part of parts) {
    if (!isObj(cur[part])) cur[part] = {};
    cur = cur[part] as TomlTable;
  }
  return cur;
}

/** 值还没写完（多行数组/内联表）：括号或字符串没闭合。 */
function hasUnclosed(s: string): boolean {
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (quote === '"' && ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
  }
  return depth > 0 || quote !== null;
}

/** 解析全文，返回 `{ mcpServers }`（与 kiro 格式对齐，交给 `readMcpServers` 直接消费）。 */
export function parseTomlMcpServers(text: string): { mcpServers: Record<string, unknown> } {
  const root: TomlTable = {};
  let table: TomlTable = root;
  let pending = "";
  for (const raw of text.split(/\r?\n/)) {
    const joined = pending ? `${pending}\n${stripComment(raw)}` : stripComment(raw);
    pending = "";
    const line = joined.trim();
    if (!line) continue;
    // 多行数组/内联表：先攒到闭合再解析（Codex 的 args 经常一行一个）。
    if (hasUnclosed(line)) {
      pending = joined;
      continue;
    }
    if (line.startsWith("[[") || line.startsWith("[")) {
      // 数组表（[[x]]）MCP 定义用不到；普通表切当前写入位置
      if (line.startsWith("[[")) continue;
      const close = line.lastIndexOf("]");
      if (close < 0) continue;
      table = ensureTable(root, splitDotted(line.slice(1, close).trim()));
      continue;
    }
    const eq = indexOfTopLevel(line, "=");
    if (eq < 0) continue;
    const parts = splitDotted(line.slice(0, eq).trim());
    if (!parts.length) continue;
    const value = parseValue(line.slice(eq + 1));
    const parent = ensureTable(table, parts.slice(0, -1));
    parent[parts[parts.length - 1]] = value;
  }
  const servers = root.mcp_servers;
  return { mcpServers: isObj(servers) ? servers : {} };
}
