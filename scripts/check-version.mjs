#!/usr/bin/env node
/**
 * 版本号一致性检查：发布前确认「源码里的版本」与「工作区包 / 锁文件 / CLI 常量」一致。
 *
 * 为什么需要：npm 发布包取自 `packages/wechat-daemon`，但版本号散落在——
 *   - packages/wechat-daemon/package.json  version（**唯一权威来源**）
 *   - packages/wechat-daemon/src/version.ts  CLI_VERSION（`wemind version` 输出）
 *   - package-lock.json  packages/wechat-daemon.version
 *   - .github/workflows/wemind-publish.yml 里不写死版本（CI 从 package.json 读），无需校验
 * 任意一处漂移都会导致「装了 1.2.0、wemind version 报 1.1.0」这类最难查的问题。
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
if (!version) problems.push("packages/wechat-daemon/package.json 缺少 version");

const versionTs = read("packages/wechat-daemon/src/version.ts");
const m = versionTs.match(/export const CLI_VERSION = "([^"]+)"/);
if (!m) problems.push("packages/wechat-daemon/src/version.ts 找不到 CLI_VERSION 常量");
else if (m[1] !== version)
  problems.push(`src/version.ts CLI_VERSION=${m[1]} 与 package.json version=${version} 不一致`);

const lock = JSON.parse(read("package-lock.json"));
const lockVersion = lock.packages?.["packages/wechat-daemon"]?.version;
if (lockVersion !== version)
  problems.push(
    `package-lock.json 里 packages/wechat-daemon.version=${lockVersion} 与 package.json version=${version} 不一致（跑 npm install 同步）`,
  );

const rootPkg = JSON.parse(read("package.json"));
if (rootPkg.name === pkg.name)
  problems.push(
    `根 package.json 也叫「${pkg.name}」：npm workspaces 里根包与工作区包同名会让 -w ${pkg.name} 解析到根包。根包应改名（如 ${pkg.name}-monorepo）。`,
  );

if (problems.length) {
  console.error("[check-version] 版本/包名不一致：");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`[check-version] OK：wemind@${version}（package.json / version.ts / lock 一致）`);
