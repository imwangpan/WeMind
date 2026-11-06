#!/usr/bin/env node
/**
 * 三张文档表格的生成与校验。
 *
 * 为什么存在：同一张表写在多处，改一处不会报错，只有人肉比对才发现。这三张表能从代码枚举，就交给机器。
 *
 * 用法：
 *   node scripts/gen-docs-tables.mjs           重新生成标记块内的表格（会改文件）
 *   node scripts/gen-docs-tables.mjs --check   只比对，不一致 exit 1（CI / verify 用）
 *
 * 只生成可枚举的列（名字 / 默认 / 出处），不生成说明文字：
 * 散文靠人写，表格靠机器。标记块外的人写内容不会被覆盖。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractPresetNames } from "./check-agent-docs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = {
  "env-vars": [
    "docs/repowiki/09-配置项与环境变量.md",
    "docs/使用指南/速查-数据目录与环境变量.md",
  ],
  presets: ["docs/接入方案/接入其它-ACP-Agent.md"],
  "cli-commands": ["README.md"],
};

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function writeText(rel, text) {
  fs.writeFileSync(path.join(ROOT, rel), text, "utf8");
}

function listSourceFiles(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      result.push(...listSourceFiles(abs));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      result.push(abs);
    }
  }
  // 按相对路径排序：fs.readdirSync 的顺序在 NTFS 与 ext4 上不同，不排序会让「变量首现位置」随 OS 变化。
  return result.sort((a, b) => {
    const ra = path.relative(dir, a).split(path.sep).join("/");
    const rb = path.relative(dir, b).split(path.sep).join("/");
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
}

/** 运行环境自带、不是 WeMind 配置项的变量：不进文档表。 */
const RUNTIME_ENV = new Set([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOME",
  "TEMP",
  "TMP",
  "COMSPEC",
  "SHELL",
  "NODE_OPTIONS",
  "VSCODE_INSPECTOR_OPTIONS",
]);

/** 从一行里尽量取出该环境变量的默认值；取不到返回 null。 */
export function extractDefault(line, name) {
  // `[^;|]*?` 不能跨过 `||`：否则 `process.env.X?.trim() || read(...) || ""` 会误取到空串。
  const re = new RegExp(
    `process\\.env\\.${name}[^;|]*?(?:\\?\\?|\\|\\|)\\s*(?:"([^"]*)"|'([^']*)'|(-?\\d[\\d_]*))`,
  );
  const m = line.match(re);
  if (!m) return null;
  const value = m[1] ?? m[2] ?? m[3] ?? "";
  return value.replace(/_/g, "");
}

/** 枚举 packages/* /src 下所有被读取的环境变量。 */
export function collectEnvVars() {
  const seen = new Map();
  const packagesDir = path.join(ROOT, "packages");
  for (const pkg of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const srcDir = path.join(packagesDir, pkg.name, "src");
    if (!fs.existsSync(srcDir)) continue;
    for (const file of listSourceFiles(srcDir)) {
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        // 变量名允许大小写混合（Windows 的 SystemRoot），系统运行环境变量随后过滤。
        for (const m of line.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
          const name = m[1];
          if (RUNTIME_ENV.has(name)) continue;
          if (!seen.has(name)) {
            seen.set(name, {
              name,
              defaultValue: extractDefault(line, name),
              location: `${rel}:${index + 1}`,
            });
          }
        }
      });
    }
  }
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 从预设对象字面量里提取 bin / args。 */
export function parsePresetRows(source) {
  const start = source.indexOf("export const ACP_AGENT_PRESETS");
  const body = start >= 0 ? source.slice(start) : source;
  const names = extractPresetNames(source);
  const rows = [];
  for (const name of names) {
    const keyRe = new RegExp(`^ {2}"?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?:\\s*\\{`, "m");
    const keyMatch = body.match(keyRe);
    if (!keyMatch) continue;
    const blockStart = keyMatch.index + keyMatch[0].length;
    const rest = body.slice(blockStart);
    const nextKey = rest.search(/\n {2}"?[\w-]+"?: \{/);
    const block = nextKey >= 0 ? rest.slice(0, nextKey) : rest;
    const bin = block.match(/bin:\s*"([^"]+)"/)?.[1] ?? "—";
    const argsMatch = block.match(/args:\s*\[([^\]]*)\]/);
    const args = argsMatch
      ? argsMatch[1]
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean)
          .join(" ")
      : "—";
    rows.push({ name, bin, args: args || "—" });
  }
  return rows;
}

/** CLI 子命令（manage.ts 的 case 分支，过滤 flag 别名）。 */
export function collectCliCommands(source) {
  const names = [...source.matchAll(/case\s+"([^"]+)":/g)].map((m) => m[1]);
  const filtered = names.filter((n) => !n.startsWith("-"));
  return [...new Set(filtered)].sort();
}

/** 微信指令（chat-commands.ts 的 COMMAND_SPECS：zh + brief）。 */
export function collectWechatCommands(source) {
  const rows = [];
  for (const m of source.matchAll(/\bid:\s*"([^"]+)"[\s\S]*?\bzh:\s*"([^"]+)"[\s\S]*?\bbrief:\s*"([^"]+)"/g)) {
    rows.push({ id: m[1], zh: m[2], brief: m[3] });
  }
  return rows;
}

function escapeCell(text) {
  return String(text).replace(/\|/g, "\\|");
}

export function renderEnvVarsTable(items) {
  const lines = ["| 变量 | 默认 | 出处 |", "|:---|:---|:---|"];
  for (const item of items) {
    let value = "—";
    if (item.defaultValue === "") value = '`""`';
    else if (item.defaultValue !== null) value = `\`${escapeCell(item.defaultValue)}\``;
    lines.push(`| \`${item.name}\` | ${value} | \`${item.location}\` |`);
  }
  return lines.join("\n");
}

export function renderPresetsTable(rows) {
  const lines = ["| 预设 | 二进制 | 启动参数 |", "|:---|:---|:---|"];
  for (const row of rows) {
    lines.push(`| \`${row.name}\` | \`${escapeCell(row.bin)}\` | \`${escapeCell(row.args)}\` |`);
  }
  return lines.join("\n");
}

export function renderCliTable(cliCommands, wechatCommands) {
  const lines = [
    "**CLI 子命令**（`wemind <命令>`）",
    "",
    "| 命令 |",
    "|:---|",
    ...cliCommands.map((c) => `| \`${c}\` |`),
    "",
    "**微信指令**",
    "",
    "| 指令 | 说明 |",
    "|:---|:---|",
    ...wechatCommands.map((c) => `| ${escapeCell(c.zh)} | ${escapeCell(c.brief)} |`),
  ];
  return lines.join("\n");
}

export function generateAll() {
  const envVars = collectEnvVars();
  const presets = parsePresetRows(readText("packages/wechat-daemon/src/agents/brain-presets.ts"));
  const cli = collectCliCommands(readText("packages/wechat-daemon/src/manage.ts"));
  const wechat = collectWechatCommands(
    readText("packages/wechat-daemon/src/ipc/chat-command-specs.ts"),
  );
  return {
    "env-vars": renderEnvVarsTable(envVars),
    presets: renderPresetsTable(presets),
    "cli-commands": renderCliTable(cli, wechat),
  };
}

function blockRegex(id) {
  return new RegExp(`(<!-- BEGIN:auto ${id} -->)[\\s\\S]*?(<!-- END:auto ${id} -->)`);
}

export function replaceBlock(text, id, generated) {
  const re = blockRegex(id);
  if (!re.test(text)) return null;
  return text.replace(re, `$1\n${generated}\n$2`);
}

export function extractBlock(text, id) {
  const m = text.match(blockRegex(id));
  if (!m) return null;
  return m[0]
    .replace(/^<!-- BEGIN:auto [^>]*-->\n?/, "")
    .replace(/\n?<!-- END:auto [^>]*-->$/, "")
    .trim();
}

function main(argv) {
  const check = argv.includes("--check");
  const generated = generateAll();
  let failures = 0;

  for (const [id, files] of Object.entries(TARGETS)) {
    for (const file of files) {
      const text = readText(file);
      const next = replaceBlock(text, id, generated[id]);
      if (next === null) {
        console.error(`${file} 缺少标记块 <!-- BEGIN:auto ${id} --> / <!-- END:auto ${id} -->`);
        failures++;
        continue;
      }
      if (check) {
        const actual = extractBlock(text, id);
        if (actual !== generated[id]) {
          console.error(`${file} 的「${id}」表格已过期；运行 npm run docs:tables 重新生成。`);
          failures++;
        }
      } else if (next !== text) {
        writeText(file, next);
        console.log(`已更新 ${file} 的「${id}」表格`);
      }
    }
  }

  if (failures > 0) return 1;
  console.log(check ? "docs:tables 通过：三张表都与代码一致。" : "docs:tables 完成。");
  return 0;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
