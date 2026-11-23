#!/usr/bin/env node
/**
 * 三个包的 tsc 并行跑。
 *
 * 原来 `npm run typecheck` 是三层 `npm run -w` 串行：每层都要启动一个 npm，三个包还排队；
 * 实测 3.0s，其中约 1.7s 是 npm 进程本身。这里直接 `node <tsc 的 JS 入口>`，
 * 不依赖 .bin 里的 shell 包装（Windows 上是 .cmd），三个进程同时启动。
 *
 * 输出按包顺序汇总，只有失败才打印该包的 tsc 诊断（tsc 把诊断写到 stdout）。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = path.join(root, "node_modules/typescript/bin/tsc");
const PACKAGES = ["wechat-ilink-core", "wechat-daemon", "wechat-mcp"];

function typecheck(name) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [tsc, "-p", path.join("packages", name, "tsconfig.json")],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("error", (err) => resolve({ name, code: 1, out: `${out}${err.message}\n` }));
    child.on("close", (code) => resolve({ name, code: code ?? 1, out }));
  });
}

const results = await Promise.all(PACKAGES.map(typecheck));
let failed = false;
for (const result of results) {
  if (result.code === 0) continue;
  failed = true;
  process.stderr.write(`\n[${result.name}] 类型检查失败\n${result.out}`);
}
if (failed) process.exit(1);
console.log(`typecheck ok: ${PACKAGES.join(", ")}`);
