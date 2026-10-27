#!/usr/bin/env node
/**
 * 版本号一致性检查：发布前确认「包身份」与「锁文件」一致，且源码里没有硬编码版本号。
 *
 * 为什么需要：npm 发布包取自 `packages/wechat-daemon`（包名 `@wemind/cli`，命令 `wemind`）。
 * 版本号现在**只有一处来源**：`packages/wechat-daemon/package.json` 的 `version`（`src/version.ts` 在运行时读它，不再手写常量）。仍需校验的是：
 *   - package.json 的 name / version / bin 是否符合发布约定
 *   - package-lock.json 里该 workspace 的记录是否同步（`npm version` 会改，手改 package.json 不会）
 *   - src/version.ts 是否**没有**回退成硬编码字面量（回退会让版本号重新分裂成两处）
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
  problems.push(`包名应为 @wemind/cli（与文档、workflow 的 CLI_PKG_NAME 一致），当前为 ${name}`);

// 版本号只能来自 package.json：源码若又写死一个字面量，就会重新变成两处来源。
const versionTs = read("packages/wechat-daemon/src/version.ts");
if (/export const CLI_VERSION\s*=\s*["']\d+\.\d+\.\d+/.test(versionTs))
  problems.push(
    "src/version.ts 又出现了硬编码的 CLI_VERSION 字面量——版本号必须只从 package.json 读取（见该文件注释）",
  );
if (!versionTs.includes("CLI_PKG_NAME"))
  problems.push("src/version.ts 找不到 CLI_PKG_NAME 常量");

const lock = JSON.parse(read("package-lock.json"));
const lockEntry = lock.packages?.["packages/wechat-daemon"];
if (lockEntry?.version !== version)
  problems.push(
    `package-lock.json 里 packages/wechat-daemon.version=${lockEntry?.version} 与 package.json version=${version} 不一致（跑 npm install 同步，或改用 npm version -w）`,
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
console.log(
  `[check-version] OK：${name}@${version}（命令 wemind；版本号单一来源 package.json，lock 已同步）`,
);

