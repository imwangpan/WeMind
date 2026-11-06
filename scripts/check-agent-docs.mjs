#!/usr/bin/env node
/**
 * 接入文档完整性检查。
 *
 * 对 packages/wechat-daemon/src/agents/brain-presets.ts 里的每个内置预设，断言：
 *   1. docs/接入方案/ 下有一篇接入文档（正文提到预设名）；
 *   2. 文档头部有「最后核对」「实测环境」「状态」三个字段；
 *   3. 有五类二级标题：安装/准备、预设/沙箱、探针/实测、限制（或风险）、验证/复现/验收；
 *   4. 有独立的 `## 待实测` 小节（没有待测项就写「无」）；
 *   5. 预设名或文档名出现在四处索引：接入其它-ACP-Agent.md、docs/ai/已知坑.md、docs/README.md、llms.txt。
 *
 * 用法：node scripts/check-agent-docs.mjs
 * 退出码：0 = 全部通过；1 = 有缺口（逐条打印缺什么）。
 *
 * 没有白名单：现有文档的缺口在 2026-11-06 一次补齐，之后新增预设必须一开始就满足。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRESET_SOURCE = "packages/wechat-daemon/src/agents/brain-presets.ts";
const DOC_DIR = "docs/接入方案";
// AGENTS.md §6 已于 2026-11-06 拆到 docs/ai/已知坑.md：预设名现在在那里出现。
const INDEX_FILES = [
  "docs/接入方案/接入其它-ACP-Agent.md",
  "docs/ai/已知坑.md",
  "docs/README.md",
  "llms.txt",
];

const HEADER_FIELDS = ["最后核对", "实测环境", "状态"];
const REQUIRED_SECTIONS = [
  { key: "安装", patterns: /安装|准备/ },
  { key: "预设", patterns: /预设|沙箱/ },
  { key: "探针", patterns: /探针|实测/ },
  { key: "限制", patterns: /限制|坑|风险|待实测/ },
  { key: "验证", patterns: /验证|复现|验收/ },
];

/** 从 ACP_AGENT_PRESETS 的对象字面量里取出预设名（顶层键）。 */
export function extractPresetNames(source) {
  const start = source.indexOf("export const ACP_AGENT_PRESETS");
  if (start < 0) return [];
  const body = source.slice(start);
  const end = body.indexOf("\n};");
  const block = end >= 0 ? body.slice(0, end) : body;
  const names = [];
  for (const match of block.matchAll(/^ {2}"?([\w-]+)"?:\s*\{/gm)) {
    names.push(match[1]);
  }
  return names;
}

/** 名称归一化：大小写与连字符不参与比较（claude-code ↔ 接入-ClaudeCode.md）。 */
export function normName(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * 找预设对应的接入文档。
 *
 * 先按文件名匹配（`接入-ClaudeCode.md` ↔ `claude-code`），这是唯一可靠的对应关系。
 * 文件名对不上时才退回「正文出现预设名」，且只接受唯一命中——否则通用文档会把多个预设都抢走。
 */
export function findDocForPreset(name, docs) {
  const target = normName(name);
  const byFile = docs.find((doc) => {
    const base = doc.file.replace(/^.*[\\/]/, "").replace(/^接入-/, "").replace(/\.md$/, "");
    return normName(base) === target;
  });
  if (byFile) return byFile;
  const hits = docs.filter((doc) =>
    new RegExp(`(^|[^\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`).test(doc.text),
  );
  return hits.length === 1 ? hits[0] : null;
}

/** 检查一篇接入文档的正文，返回缺口列表。 */
export function checkDocContent(content) {
  const errors = [];
  const head = content.split(/\r?\n/).slice(0, 25).join("\n");
  for (const field of HEADER_FIELDS) {
    if (!head.includes(field)) errors.push(`头部缺少「${field}」`);
  }
  const headings = content.match(/^##\s+.+$/gm) ?? [];
  for (const section of REQUIRED_SECTIONS) {
    if (!headings.some((h) => section.patterns.test(h))) {
      errors.push(`缺少「${section.key}」类二级标题（关键词：${section.patterns.source}）`);
    }
  }
  if (!/^##\s+(?:\d+\.\s*)?待实测\s*$/m.test(content)) {
    errors.push("缺少独立的「待实测」二级标题（没有待测项就写「无」）");
  }
  return errors;
}

/** 检查四处索引是否提到该预设（或该文档名）。 */
export function checkIndexes(name, docBase, indexTexts) {
  const errors = [];
  for (const [file, text] of Object.entries(indexTexts)) {
    if (!text.includes(name) && !text.includes(docBase)) {
      errors.push(`${file} 未提到 ${name} 或 ${docBase}`);
    }
  }
  return errors;
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function main() {
  const names = extractPresetNames(readText(PRESET_SOURCE));
  if (names.length === 0) {
    console.error(`从 ${PRESET_SOURCE} 解析不出预设名，脚本需要更新。`);
    return 1;
  }

  const files = fs
    .readdirSync(path.join(ROOT, DOC_DIR))
    .filter((f) => /^接入-.+\.md$/.test(f) && f !== "接入其它-ACP-Agent.md")
    .sort();
  const docs = files.map((f) => ({ file: `${DOC_DIR}/${f}`, text: readText(`${DOC_DIR}/${f}`) }));
  const indexTexts = Object.fromEntries(INDEX_FILES.map((f) => [f, readText(f)]));

  let failures = 0;
  for (const name of names) {
    const doc = findDocForPreset(name, docs);
    if (!doc) {
      console.error(`[${name}] 缺少接入文档：${DOC_DIR}/ 下没有正文提到 ${name} 的文件`);
      failures++;
      continue;
    }
    const errors = [
      ...checkDocContent(doc.text),
      ...checkIndexes(name, path.basename(doc.file, ".md"), indexTexts),
    ];
    if (errors.length > 0) {
      failures++;
      console.error(`[${name}] ${doc.file}`);
      for (const e of errors) console.error(`  - ${e}`);
    }
  }

  if (failures === 0) {
    console.log(`check-agent-docs 通过：${names.length} 个预设的接入文档都完整。`);
    return 0;
  }
  console.error(`\ncheck-agent-docs 未通过：${failures}/${names.length} 个预设的文档有缺口。`);
  return 1;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
