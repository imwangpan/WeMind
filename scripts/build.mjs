#!/usr/bin/env node
/**
 * 构建两个发布包：先并行检查三个包的类型，再并行 tsdown。
 *
 * 类型检查放在 build 里，是为了让「能出包」等价于「类型干净」：
 * tsdown（rolldown/oxc）只剥类型、不做类型检查，以前 `build` 只 tsc 了 core，
 * daemon/mcp 的类型错误能一路出到 dist 里，只能等 `npm run verify` 或运行时才发现。
 * 实现复用 `scripts/typecheck.mjs`，类型检查只有一份。
 *
 * 原来是 `npm run typecheck -w core && npm run build -w cli -w mcp`，
 * 三层 npm 启动占了大半耗时（tsdown 本身只要 70–180ms）。这里直接跑
 * `node <tsc 入口>` 和 `node <tsdown 入口>`，并用包的目录当 cwd
 * （tsdown 的 entry 是相对 cwd 的 `src/...`）。
 *
 * 产物输出按顺序汇总，失败时带上该包的完整输出。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { typecheckAll } from "./typecheck.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsdown = path.join(root, "node_modules/tsdown/dist/run.mjs");

function run(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("error", (err) => resolve({ code: 1, out: `${out}${err.message}\n` }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

if (!(await typecheckAll())) process.exit(1);

const builds = await Promise.all([
  run([tsdown, "-c", "tsdown.config.ts"], path.join(root, "packages/wechat-daemon")),
  run([tsdown, "-c", "tsdown.config.ts"], path.join(root, "packages/wechat-mcp")),
]);

let failed = false;
for (const [index, name] of ["wechat-daemon", "wechat-mcp"].entries()) {
  const result = builds[index];
  if (result.code === 0) {
    process.stdout.write(result.out.trim() ? `${result.out.trim()}\n` : `${name} built\n`);
  } else {
    failed = true;
    process.stderr.write(`\n[${name}] 构建失败\n${result.out}`);
  }
}
if (failed) process.exit(1);
