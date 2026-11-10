#!/usr/bin/env node
/**
 * 发布前守卫：`files: ["dist"]` 的包若忘了 build，npm pack/publish 会发出一个**只有 package.json** 的空壳包（bin 指向不存在的 dist/cli.js）——装完 `wemind` 命令直接报「找不到模块」。
 *
 * 因此每个要发布的工作区包在 `scripts.prepack` 里调本脚本，检查目标目录：
 *   1. package.json 的 `files` 里列出的每个目录/文件都存在且非空；
 *   2. `bin` 指向的文件存在（可执行入口必须有）；
 *   3. 产物里不得残留 `@wemind/*` 裸包名 import（core 是 JIT 源码包，必须被 tsdown 内联）。
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

/** 递归收集 files 覆盖的脚本产物；只扫 .js/.mjs/.cjs——.map 的 sourcesContent 会包含源码里的 import，扫它会误报。 */
const SCRIPT_EXT = new Set([".js", ".mjs", ".cjs"]);
function collectScripts(p) {
  const out = [];
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
      if (ent.name === "node_modules") continue;
      out.push(...collectScripts(path.join(p, ent.name)));
    }
  } else if (SCRIPT_EXT.has(path.extname(p))) {
    out.push(p);
  }
  return out;
}

const packagedScripts = [];
for (const entry of pkg.files ?? []) {
  const p = path.join(pkgDir, entry);
  if (!existsNonEmpty(p)) {
    problems.push(`files 条目不存在或为空：${entry}（先跑 npm run build）`);
    continue;
  }
  packagedScripts.push(...collectScripts(p));
}

// 发布产物必须自包含：core 是 private 的 JIT 源码包，由 tsdown alwaysBundle 内联。
// 产物里若仍出现 @wemind/* 裸包名 import，说明它被当成 external，装到用户机器上会 ERR_MODULE_NOT_FOUND。
const WORKSPACE_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](@wemind\/[^"']+)["']/g;
for (const file of packagedScripts) {
  const text = fs.readFileSync(file, "utf-8");
  WORKSPACE_SPECIFIER.lastIndex = 0;
  const hit = WORKSPACE_SPECIFIER.exec(text);
  if (hit) {
    problems.push(
      `产物仍引用工作区包 ${hit[1]}：${path.relative(pkgDir, file)}（core 没有被内联，检查 tsdown deps.alwaysBundle）`,
    );
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
