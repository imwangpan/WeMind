#!/usr/bin/env node
/**
 * 一次性提升 `@wemind/cli` 的版本号（`package.json` + `package-lock.json`），并自检一致性。
 *
 * 为什么需要这个脚本：`npm version patch -w @wemind/cli --no-git-tag-version` 已经能同时改
 * package.json 和 lockfile，但有两个坑：
 *   1. 它**不会**改 `packages/wechat-daemon/src/version.ts`。本仓库已把该文件改成运行时读
 *      package.json，所以不再需要手改——但脚本仍会跑一遍 check-version 确认没有被改回硬编码。
 *   2. 它默认会创建 git commit + tag，除非加 `--no-git-tag-version`；漏加会得到一个意外提交。
 * 这个脚本把正确姿势固化下来，执行完直接告诉你下一步该干什么。
 *
 * 用法：
 *   node scripts/bump-version.mjs patch        # 1.1.0 → 1.1.1（Bug 修复）
 *   node scripts/bump-version.mjs minor        # 1.1.0 → 1.2.0（向后兼容的新功能）
 *   node scripts/bump-version.mjs major        # 1.1.0 → 2.0.0（不兼容改动）
 *   node scripts/bump-version.mjs 1.4.2        # 直接指定版本
 *   node scripts/bump-version.mjs --dry-run patch
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const PKG = "@wemind/cli";
const PKG_JSON = path.join(root, "packages/wechat-daemon/package.json");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const target = args.find((a) => !a.startsWith("--"));

const RELEASE_TYPES = ["patch", "minor", "major"];
const isExplicit = target && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(target);
if (!target || (!RELEASE_TYPES.includes(target) && !isExplicit)) {
  console.error(
    "用法：node scripts/bump-version.mjs <patch|minor|major|x.y.z> [--dry-run]\n" +
      "  patch  修 bug、兼容性改动\n" +
      "  minor  新增向后兼容的功能\n" +
      "  major  不兼容改动",
  );
  process.exit(1);
}

const before = JSON.parse(fs.readFileSync(PKG_JSON, "utf-8")).version;
console.log(`[bump-version] 当前 ${PKG}@${before}`);

/**
 * 执行一条命令（不经 shell）。
 *
 * Windows 上 `npm` 只是一个 `.cmd` 包装器，**Node 不允许直接 spawn `.cmd/.bat`**
 * （`spawnSync npm.cmd ... → EINVAL`），而 `shell: true` + args 数组又触发 DEP0190
 * （参数只拼接、不转义，有注入面）。所以这里挑最稳的路：
 *   - 要跑 npm 时，用当前 node 直接执行 npm 自身的 JS 入口（`npm-cli.js`）；
 *   - 跑 node 时本来就没有 shell 问题。
 * 与 `src/spawn-agent.ts` 对 Windows 的处理取舍一致（避免 shell + 逐参数引用）。
 */
function npmCliPath() {
  // npm 的 JS 入口就在 node 安装目录的 node_modules/npm/bin/ 下
  const candidates = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

const run = (kind, cmdArgs, label) => {
  const isNpm = kind === "npm";
  const exe = isNpm ? process.execPath : process.execPath;
  let args = cmdArgs;
  if (isNpm) {
    const cli = npmCliPath();
    if (!cli) {
      console.error(`[bump-version] 找不到 npm 的 JS 入口（npm-cli.js），请手动执行：npm ${cmdArgs.join(" ")}`);
      process.exit(1);
    }
    args = [cli, ...cmdArgs];
  }

  if (dryRun) {
    console.log(`[bump-version] (dry-run) 将执行：${isNpm ? "npm" : "node"} ${cmdArgs.join(" ")}`);
    return { status: 0 };
  }
  const r = spawnSync(exe, args, { cwd: root, encoding: "utf8" });
  if (r.error) {
    console.error(`[bump-version] ${label} 无法执行：${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`[bump-version] ${label} 失败：\n${r.stdout ?? ""}${r.stderr ?? ""}`);
    process.exit(1);
  }
  return r;
};

// ① 改 package.json + package-lock.json（--no-git-tag-version：不自动 commit/tag）
run("npm", ["version", target, "--workspace", PKG, "--no-git-tag-version"], "npm version");

if (dryRun) {
  console.log("[bump-version] (dry-run) 跳过自检");
  process.exit(0);
}

// ② 自检：名字/版本/lock 一致 + 源码没有回退成硬编码版本号
run("node", ["scripts/check-version.mjs"], "check-version");

const after = JSON.parse(fs.readFileSync(PKG_JSON, "utf-8")).version;
console.log(`[bump-version] ✅ ${PKG}@${before} → ${after}`);
console.log(
  [
    "",
    "接下来：",
    "  1) npm run lint && npm run typecheck && npm run build && npm test",
    "  2) npm pack --dry-run -w @wemind/cli     # 确认产物内容",
    "  3) git add packages/wechat-daemon/package.json package-lock.json",
    "     git commit -m \"chore: release @wemind/cli " + after + "\"",
    "  4) git push origin main                  # CI 自动发布（版本已存在则跳过）",
  ].join("\n"),
);
