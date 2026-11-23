#!/usr/bin/env node
/**
 * Markdown 相对链接检查（read-only）。原来的 scripts/check-docs.ps1 的 Node 版：
 * verify 不再依赖 PowerShell，Linux/macOS 与 CI 都能直接跑。
 *
 *   node scripts/check-docs.mjs            # 检查仓库
 *   node scripts/check-docs.mjs --root .   # 指定根目录（测试用）
 *
 * 跳过：http(s)/mailto/#锚点、node_modules、dist、.git，以及 agent 的 worktree 副本
 * （`.claude/worktrees/`、`.worktrees/`、`.agents/`）——那里的 Markdown 是同一批文件
 * 的另一份检出，扫进去会让「检查数」翻倍，与 vitest 排除 .agents 是同一类问题。
 * 判断用「相对 root 的路径」：脚本在 worktree 里跑时（root = .../.worktrees/<name>）
 * 绝对路径会命中 `.worktrees/` 而把全部文件排除掉。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const SKIP_ROOTS = [".claude/worktrees", ".worktrees", ".agents"];
const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function isSkipped(rel) {
  const segments = rel.split("/");
  if (segments.some((segment) => SKIP_DIRS.has(segment))) return true;
  return SKIP_ROOTS.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
}

function listMarkdown(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, full));
      if (isSkipped(rel)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push({ full, rel });
    }
  };
  walk(root);
  return files;
}

/** 返回 { checked, files, broken }，供 CLI 与测试共用。 */
export function checkDocs({ root }) {
  const resolvedRoot = path.resolve(root);
  const files = listMarkdown(resolvedRoot);
  const broken = [];
  let checked = 0;

  for (const file of files) {
    let lineNo = 0;
    let inFence = false;
    for (const line of fs.readFileSync(file.full, "utf8").split(/\r?\n/)) {
      lineNo++;
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      // 去掉行内代码，避免把 `![](示例)` 之类当成真链接
      const clean = line.replace(/`[^`]*`/g, "");
      for (const match of clean.matchAll(LINK_RE)) {
        let target = match[1].trim();
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        target = target.replace(/^</, "").replace(/>$/, "");
        target = target.replace(/\s+"[^"]*"$/, ""); // 去掉 Markdown title
        target = target.split("#")[0];
        if (!target) continue;
        checked++;
        const resolved = path.resolve(path.dirname(file.full), target);
        if (!fs.existsSync(resolved)) broken.push({ file: file.rel, line: lineNo, target });
      }
    }
  }

  broken.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
  return { checked, files: files.length, broken };
}

function main(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--root" && argv[index + 1]) root = path.resolve(argv[++index]);
  }

  const { checked, files, broken } = checkDocs({ root });
  console.log(`checked ${checked} relative links in ${files} markdown files`);
  if (broken.length === 0) {
    console.log("OK: no broken relative links");
    return 0;
  }
  console.log(`BROKEN: ${broken.length}`);
  for (const item of broken) console.log(`${item.file}:${item.line}  ${item.target}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
