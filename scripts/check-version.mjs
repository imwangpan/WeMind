#!/usr/bin/env node
/**
 * 版本号一致性检查：发布前确认「源码里的版本 / 包名」与「锁文件 / CLI 常量」一致。
 *
 * 为什么需要：npm 发布包取自 `packages/wechat-daemon`（包名 `@wemind/cli`，命令 `wemind`），
 * 但版本号与包名散落在——
 *   - packages/wechat-daemon/package.json  name / version（**唯一权威来源**）
 *   - packages/wechat-daemon/src/version.ts  CLI_VERSION / CLI_PKG_NAME（`wemind version` 输出）
 *   - package-lock.json  packages/wechat-daemon.version
 * 任意一处漂移都会导致「装了 1.2.0、`wemind version` 报 1.0.0」这类最难查的问题，
 * 或在 `npm view` 上找不到 `versionLine()` 里报的那个包名。
 *
 * 用法：node scripts/check-version.mjs
 * 退出码：0 一致；1 不一致（打印全部差异）
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf-8");

const problems = [];

const pkg = JSON.parse(read("packages/wechat-daemon/package.json"));
const version = pkg.version;
const name = pkg.name;
if (!version) problems.push("packages/wechat-daemon/package.json 缺少 version");
if (!name) problems.push("packages/wechat-daemon/package.json 缺少 name");

// 包名与命令名是**有意的**两套值：包在 @wemind scope 下叫 cli，命令叫 wemind。
const bins = typeof pkg.bin === "string" ? { [name]: pkg.bin } : Object.keys(pkg.bin ?? {});
if (!bins.includes("wemind"))
  problems.push(
    `packages/wechat-daemon/package.json 的 bin 里没有「wemind」（当前：${bins.join(", ") || "空"}）——安装后用户敲的命令必须是 wemind`,
  );
if (name !== "@wemind/cli")
  problems.push(`包名应为 @wemind/cli（与文档、workflow、version.ts 的 CLI_PKG_NAME 一致），当前为 ${name}`);

const versionTs = read("packages/wechat-daemon/src/version.ts");
const mv = versionTs.match(/export const CLI_VERSION = "([^"]+)"/);
if (!mv) problems.push("packages/wechat-daemon/src/version.ts 找不到 CLI_VERSION 常量");
else if (mv[1] !== version)
  problems.push(`src/version.ts CLI_VERSION=${mv[1]} 与 package.json version=${version} 不一致`);

const mn = versionTs.match(/export const CLI_PKG_NAME = "([^"]+)"/);
if (!mn) problems.push("packages/wechat-daemon/src/version.ts 找不到 CLI_PKG_NAME 常量");
else if (mn[1] !== name)
  problems.push(`src/version.ts CLI_PKG_NAME=${mn[1]} 与 package.json name=${name} 不一致`);

const lock = JSON.parse(read("package-lock.json"));
const lockEntry = lock.packages?.["packages/wechat-daemon"];
if (lockEntry?.version !== version)
  problems.push(
    `package-lock.json 里 packages/wechat-daemon.version=${lockEntry?.version} 与 package.json version=${version} 不一致（跑 npm install 同步）`,
  );
if (lockEntry?.name !== name)
  problems.push(
    `package-lock.json 里 packages/wechat-daemon.name=${lockEntry?.name} 与 package.json name=${name} 不一致（跑 npm install 同步）`,
  );

if (problems.length) {
  console.error("[check-version] 版本/包名不一致：");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`[check-version] OK：${name}@${version}（命令 wemind；package.json / version.ts / lock 一致）`);
