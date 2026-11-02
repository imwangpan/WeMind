import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 让检出自动启用仓库自带的 git hooks（`.githooks/`）。
 *
 * 为什么需要：CI 会跑 `format:check`，而本地自检很容易只跑 lint/test——漏一次就是一次 Actions 红灯。pre-commit 钩子在提交前先挡住未格式化的 TypeScript，把问题留在本地。
 * 只在有 `.git` 的检出里配置；CI 的 `npm ci` 也会跑 `prepare`，但没有 `.git` 时直接跳过，不产生副作用。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!fs.existsSync(path.join(root, ".git"))) process.exit(0);

try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
    cwd: root,
    stdio: "ignore",
  });
} catch {
  // 不是 git 仓库 / 没装 git：跳过，CI 仍会兜底
}
