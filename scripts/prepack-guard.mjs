#!/usr/bin/env node
/**
 * 发布前守卫：`files: ["dist"]` 的包若忘了 build，npm pack/publish 会发出一个**只有 package.json** 的空壳包（bin 指向不存在的 dist/cli.js）——装完 `wemind` 命令直接报「找不到模块」。
 *
 * 因此每个要发布的工作区包在 `scripts.prepack` 里调本脚本，检查目标目录：
 *   1. package.json 的 `files` 里列出的每个目录/文件都存在且非空；
 *   2. `bin` 指向的文件存在（可执行入口必须有）。
 * 任何一项不满足就 exit 1，让 `npm publish` 失败而不是发出坏包。
 *
 * 用法：node scripts/prepack-guard.mjs <包目录>
 */
import fs from "node:fs";
import path from "node:path";

const pkgDir = path.resolve(process.argv[2] ?? ".");
const pkgFile = path.join(pkgDir, "package.json");

/** @type {{name?:string, version?:string, files?:string[], bin?:Record<string,string>|string}} */
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgFile, "utf-8"));
} catch (e) {
  console.error(`[prepack-guard] 读不到 ${pkgFile}：${String(e)}`);
  process.exit(1);
}

const problems = [];
const name = pkg.name ?? path.basename(pkgDir);

/** child 是否就是 parent 或位于其内部（用于判断某产物是否被 files 覆盖）。 */
function isUnder(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 目录非空 / 文件存在。 */
function existsNonEmpty(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return false;
  }
  if (st.isDirectory()) {
    try {
      return fs.readdirSync(p).length > 0;
    } catch {
      return false;
    }
  }
  return st.size > 0;
}

for (const entry of pkg.files ?? []) {
  if (!existsNonEmpty(path.join(pkgDir, entry))) {
    problems.push(`files 条目不存在或为空：${entry}（先跑 npm run build）`);
  }
}

const bins =
  typeof pkg.bin === "string"
    ? { [name]: pkg.bin }
    : Object.fromEntries(Object.entries(pkg.bin ?? {}));
for (const [binName, target] of Object.entries(bins)) {
  const p = path.join(pkgDir, target);
  if (!fs.existsSync(p)) {
    problems.push(`bin「${binName}」指向的文件不存在：${target}（先跑 npm run build）`);
    continue;
  }
  const text = fs.readFileSync(p, "utf-8");
  if (!text.startsWith("#!")) {
    problems.push(`bin「${binName}」缺少 shebang（#!）：${target}`);
  }
  // 引用了 sourcemap 就必须把 .map 一起带进包：否则用户报错时的行号指向一个不存在的映射，等于「假装有 sourcemap」，比没有更误导。
  const ref = text.match(/\/\/# sourceMappingURL=(\S+)\s*$/m);
  if (ref) {
    const mapPath = path.join(path.dirname(p), ref[1]);
    if (!fs.existsSync(mapPath)) {
      problems.push(`bin「${binName}」声明了 sourcemap（${ref[1]}）但该文件不存在`);
    } else if (!(pkg.files ?? []).some((f) => isUnder(path.join(pkgDir, f), mapPath))) {
      problems.push(`sourcemap ${path.relative(pkgDir, mapPath)} 不在 files 里，不会随包发布`);
    }
  }
}

if (problems.length) {
  console.error(`[prepack-guard] ${name}@${pkg.version ?? "?"} 拒绝发布：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`[prepack-guard] ${name}@${pkg.version ?? "?"} 产物齐全，可以打包/发布。`);
