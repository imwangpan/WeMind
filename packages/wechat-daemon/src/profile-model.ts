import fs from "node:fs";
import path from "node:path";

/**
 * 真实 profile 用户层（`<realHome>/profiles/<profile>/cordis.patch.yml`）的三件事：
 * ① 读默认模型（`readProfileDefaultModel`）；② 缺 `- id: acp` 时给用户提示（`acpOverrideHint`）；
 * ③ 复制进沙箱前剔除「微信 MCP」条目（`stripWechatMcpEntries`，防回环）。
 * 文件是桌面端维护的 YAML 用户层，结构是一个 patch 列表。这里只做定点抽取，不引入 YAML 依赖。
 */

/**
 * 从 DSH 真实 home 的 profile 用户层读「默认模型」。
 *
 * 为什么需要（2026-10-29 实测，DSH 0.2.1-rc.3，scripts/acp-probe.mjs）：`dsh --profile acp` 的 ACP 桥插件默认模型写死在它
 * **自己的 bundle patch** 里（`- id: acp` → `deepseek-official/deepseek-v4-flash`，该路由要 DEEPSEEK_API_KEY），
 * 而 profile 用户层只覆盖 `llm-pi-ai` / `agent-default-model` / `web-search-deepseek`——**`- id: acp` 由用户自己补**
 * （插件 README 原话：a later patch can replace that row's complete config）。
 *
 * 读的顺序（都只是「读用户自己写的配置」，不替 agent 合成）：
 * ① 用户层若已有 `- id: acp` 且带 provider/model → 用它的值（这才是 ACP 路径真正生效的模型）；
 * ② 否则退回 `- id: agent-default-model` 的 provider/model（桌面端的默认，等于「你日常怎么用」）。
 * 读不到返回 null（调用方回退到内置预设值 / 不下发）。
 */
export function readProfileDefaultModel(realHome: string, profile: string): string | null {
  if (!realHome || !profile) return null;
  let text: string;
  try {
    text = fs.readFileSync(path.join(realHome, "profiles", profile, "cordis.patch.yml"), "utf-8");
  } catch {
    return null;
  }
  const acp = entryConfig(text, /^\s*-\s+id:\s*acp\s*(#.*)?$/);
  if (acp) return acp;
  return entryConfig(text, /^\s*-\s+id:\s*agent-default-model\s*(#.*)?$/);
}

/**
 * 复制进沙箱前剔除「微信 MCP」条目（真实文件不动）。DSH 自己的 MCP 也写在 profile 里
 * （`- id: mcp-xxx` + `name: '@deepseek-ai/dsh-mcp-client'`）；如果用户在自己的 dsh 配置里挂过微信 MCP，
 * 原样复制会让沙箱里的 agent 用同一个 bot token 起第二个消费者（抢消息/回环）。
 * 大脑与 worker 的 MCP 都由 WeMind 的激活集权威决定（`wechat` 永远不在里面），所以只剔这一种条目，其余原样保留。
 * 没有命中时返回**原文**（逐字节复制不受影响）。
 */
export function stripWechatMcpEntries(text: string): { text: string; removed: string[] } {
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) if (/^-\s/.test(lines[i])) starts.push(i);
  const removed: string[] = [];
  const drop = new Set<number>();
  for (let b = 0; b < starts.length; b++) {
    const start = starts[b];
    const end = b + 1 < starts.length ? starts[b + 1] : lines.length;
    const body = lines
      .slice(start, end)
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    if (!isWechatMcpEntry(body)) continue;
    removed.push(lines[start].trim().replace(/^-\s+/, "").split(/\s+#/)[0]);
    for (let i = start; i < end; i++) drop.add(i);
  }
  if (!removed.length) return { text, removed };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let out = lines.filter((_, i) => !drop.has(i)).join(eol);
  if (/(\r\n|\n)$/.test(text) && !out.endsWith(eol)) out += eol; // 剔掉的若是最后一条，别把文件末尾的换行也带走
  return { text: out, removed };
}

/** 一条 patch 条目是不是「微信 MCP」：跑 wemind-mcp 的，或 serverName 为 wechat 的 mcp-client。 */
function isWechatMcpEntry(body: string): boolean {
  if (/wemind-mcp|@wemind\/wechat-mcp/i.test(body)) return true;
  return (
    /name:\s*['"]?@deepseek-ai\/dsh-mcp-client/.test(body) &&
    /serverName:\s*['"]?wechat['"]?\s*(#.*)?$/m.test(body)
  );
}

/** 给用户的提示（缺 `- id: acp` 时用）：说清后果 + 给出可直接粘贴的片段（值取自 agent-default-model，读不到就给占位）。 */
export function acpOverrideHint(realHome: string, profile: string): string | null {
  if (!realHome || !profile) return null;
  const file = path.join(realHome, "profiles", profile, "cordis.patch.yml");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return null; // 还没有这份 profile（dsh 首次启动才生成）：先不提示，「改哪份文件」还说不清
  }
  if (/^[ \t]*-[ \t]+id:[ \t]*acp[ \t]*(#.*)?$/m.test(text)) return null;
  const derived = entryConfig(text, /^\s*-\s+id:\s*agent-default-model\s*(#.*)?$/);
  const pair = derived ? (JSON.parse(derived) as [string, string]) : null;
  const provider = pair?.[0] ?? "magpie";
  const model = pair?.[1] ?? "auto/deepseek-v4.1-flash";
  return [
    `提示：${file} 没有配置 - id: acp（ACP 桥的默认模型），终端 dsh --profile ${profile} 与微信大脑都会落到 deepseek-official（要 API key）。`,
    `把下面这段加到那份文件末尾（插件文档写明的覆盖点），两边行为就一致：`,
    `- id: acp`,
    `  config:`,
    `    provider: ${JSON.stringify(provider)}`,
    `    model: ${JSON.stringify(model)}`,
  ].join("\n");
}

/** 读某个 patch 条目（按起始行正则定位）的 config.provider/model；缺一个就 null。 */
function entryConfig(text: string, head: RegExp): string | null {
  let inside = false;
  let provider = "";
  let model = "";
  for (const line of text.split(/\r?\n/)) {
    if (!inside) {
      if (head.test(line)) inside = true;
      continue;
    }
    // patch 列表的下一个条目（顶层 `- ` 或别的 `- id:`）→ 当前条目结束
    if (/^-\s+/.test(line) || /^\s*-\s+id:/.test(line)) break;
    if (!provider) provider = scalar(line, "provider");
    if (!model) model = scalar(line, "model");
  }
  if (!provider || !model) return null;
  return JSON.stringify([provider, model]);
}

/** 取 `key: value` 的标量值（去引号与行尾注释）。 */
function scalar(line: string, key: string): string {
  const m = new RegExp(`^\\s+${key}:\\s+(.+)$`).exec(line);
  if (!m) return "";
  return m[1]
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^["']|["']$/g, "");
}
