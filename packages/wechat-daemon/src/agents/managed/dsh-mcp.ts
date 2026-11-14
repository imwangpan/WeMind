import type { McpCatalog } from "./mcp-adapters.js";

/**
 * DSH 的 MCP 定义不是独立 JSON，而是写在 profile 用户层的 YAML patch 列表里：
 *
 * ```yaml
 * - id: mcp-github
 *   name: "@deepseek-ai/dsh-mcp-client"
 *   config:
 *     serverName: github
 *     transport: stdio
 *     command: npx
 *     args: ["-y", "@modelcontextprotocol/server-github"]
 * ```
 *
 * 这里只做**只读解析**与「复制进副本前剥离」两件事，绝不写回真实文件。
 * 不引入 YAML 依赖：只认 DSH 这几类字段，容忍块式/flow 式写法；解析不了就当没有。
 */

type Block = { start: number; end: number; indent: number; header: string };

/** 扫描 YAML 列表项（任意缩进）。块在下一个缩进不大于自己的列表项处结束。 */
function listBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-\s+(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = /^(\s*)-\s+/.exec(lines[j]);
      if (next && next[1].length <= indent) {
        end = j;
        break;
      }
    }
    out.push({ start: i, end, indent, header: m[2] });
  }
  return out;
}

/** 去掉行尾注释（字符串里的 # 不算）。 */
function stripComment(raw: string): string {
  let quote = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i);
  }
  return raw;
}

function unquote(raw: string): string {
  const s = stripComment(raw).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\(["'\\])/g, "$1");
  }
  return s;
}

function scalar(lines: string[], key: string): string {
  const re = new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*(.+)$`);
  for (const line of lines) {
    const m = re.exec(line);
    if (m) return unquote(m[1]);
  }
  return "";
}

function flowList(raw: string): string[] {
  const s = stripComment(raw).trim();
  if (!s.startsWith("[") || !s.endsWith("]")) return [];
  const body = s.slice(1, -1);
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      cur += c;
      if (c === "\\") {
        if (i + 1 < body.length) cur += body[++i];
      } else if (c === quote) {
        quote = "";
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ",") {
      if (cur.trim()) out.push(unquote(cur));
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(unquote(cur));
  return out;
}

function listValue(lines: string[], key: string): string[] {
  for (let i = 0; i < lines.length; i++) {
    const m = new RegExp(`^(\\s*)${key}:\\s*(.*)$`).exec(lines[i]);
    if (!m) continue;
    const inline = m[2].trim();
    if (inline) return flowList(inline);
    const indent = m[1].length;
    const out: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const deeper = (/^\s*/.exec(line) ?? [""])[0].length;
      if (deeper <= indent) break;
      const item = /^\s*-\s+(.+)$/.exec(line);
      if (item) out.push(unquote(item[1]));
    }
    return out;
  }
  return [];
}

function mapValue(lines: string[], key: string): Record<string, string> {
  for (let i = 0; i < lines.length; i++) {
    const m = new RegExp(`^(\\s*)${key}:\\s*(#.*)?$`).exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const out: Record<string, string> = {};
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const deeper = (/^\s*/.exec(line) ?? [""])[0].length;
      if (deeper <= indent) break;
      const pair = /^\s*([A-Za-z_][\w.-]*):\s*(.+)$/.exec(line);
      if (pair) out[pair[1]] = unquote(pair[2]);
    }
    return out;
  }
  return {};
}

function blockBody(lines: string[], block: Block): string[] {
  return lines.slice(block.start, block.end);
}

function isDshMcpBody(body: string[]): boolean {
  return body.some((line) => /name:\s*['"]?@deepseek-ai\/dsh-mcp-client/.test(line));
}

function serverFromBlock(lines: string[], block: Block): { name: string; def: unknown } | null {
  const body = blockBody(lines, block);
  const id = scalar(body, "id");
  const name = scalar(body, "serverName") || id.replace(/^mcp-/, "");
  if (!name) return null;
  const command = scalar(body, "command");
  const url = scalar(body, "url");
  const transport = scalar(body, "transport").toLowerCase();
  if (command) {
    return {
      name,
      def: {
        command,
        args: listValue(body, "args"),
        env: mapValue(body, "env"),
      },
    };
  }
  if (url || transport === "http" || transport === "sse") {
    return { name, def: { url, headers: mapValue(body, "headers") } };
  }
  return { name, def: null };
}

/** 读 profile 里全部 DSH MCP 定义（按 serverName 去重，后者胜）。 */
export function parseDshMcpServers(text: string): McpCatalog {
  const lines = text.split(/\r?\n/);
  const out: McpCatalog = {};
  for (const block of listBlocks(lines)) {
    if (!/^id:\s*/.test(block.header)) continue; // 只认真正的条目，别把包着它的 `- insert:` 当成 MCP
    const body = blockBody(lines, block);
    if (!isDshMcpBody(body)) continue;
    const server = serverFromBlock(lines, block);
    if (server && server.def) out[server.name] = server.def;
  }
  return out;
}

/**
 * 按谓词剥掉 YAML 列表项；`insert:` 父项变空时一并删掉，避免留下非法 YAML。
 * 谓词返回要记录的条目名（null 表示保留）。供 DSH 的 MCP 剥离与通用「微信 MCP」检测共用。
 */
export function stripDshEntries(
  text: string,
  match: (body: string[]) => string | null,
): { text: string; removed: string[] } {
  const lines = text.split(/\r?\n/);
  const removed: string[] = [];
  const drop = new Set<number>();
  for (const block of listBlocks(lines)) {
    const body = blockBody(lines, block);
    const label = match(body);
    if (label === null) continue;
    removed.push(label);
    for (let i = block.start; i < block.end; i++) drop.add(i);
  }
  if (!removed.length) return { text, removed };
  let out = lines.filter((_, i) => !drop.has(i));
  // 递归清掉变空的 `- insert:` 父项（子项都删完时它只剩一个键，不合法）。
  for (;;) {
    const blocks = listBlocks(out);
    const empty = blocks.find((b) => {
      if (!/^insert:\s*(#.*)?$/.test(b.header)) return false;
      return blockBody(out, b)
        .slice(1)
        .every((line) => !line.trim() || /^\s*#/.test(line));
    });
    if (!empty) break;
    out = [...out.slice(0, empty.start), ...out.slice(empty.end)];
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let body = out.join(eol);
  if (/(\r\n|\n)$/.test(text) && !body.endsWith(eol)) body += eol;
  return { text: body, removed };
}

/** 剥掉所有 DSH MCP 条目（brain managed 默认空、worker 由 ACP 注入全量时用）。 */
export function stripAllDshMcpEntries(text: string): { text: string; removed: string[] } {
  return stripDshEntries(text, (body) => {
    if (!/^\s*-\s+id:/.test(body[0] ?? "")) return null; // 不把 `- insert:` 父项当成 MCP
    if (!isDshMcpBody(body)) return null;
    const block: Block = { start: 0, end: body.length, indent: 0, header: "" };
    const server = serverFromBlock(body, block);
    return server?.name || scalar(body, "id") || "mcp";
  });
}
