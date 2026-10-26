#!/usr/bin/env node
/**
 * 发布前守卫：`files: ["dist"]` 的包若忘了 build，npm pack/publish 会发出一个**只有 package.json**
 * 的空壳包（bin 指向不存在的 dist/cli.js）——装完 `wemind` 命令直接报「找不到模块」。
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
  const head = fs.readFileSync(p, "utf-8").slice(0, 200);
  if (!head.startsWith("#!")) {
    problems.push(`bin「${binName}」缺少 shebang（#!）：${target}`);
  }
}

if (problems.length) {
  console.error(`[prepack-guard] ${name}@${pkg.version ?? "?"} 拒绝发布：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`[prepack-guard] ${name}@${pkg.version ?? "?"} 产物齐全，可以打包/发布。`);
