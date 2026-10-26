import { defineConfig } from "vitest/config";

/**
 * vitest 配置。
 *
 * 存在的首要原因是 **exclude `.agents/`**：仓库支持 `git worktree`（DSH 等 agent 会把
 * 分支检出到 `.agents/worktrees/<branch>/`），那里的 `packages/**\/*.test.ts` 是**同一批
 * 测试文件的副本**。vitest 默认只排除 `node_modules`/`dist`，于是本地跑测试时会把每个
 * 测试计两遍（实测：19 文件/155 测试 → 出现 worktree 时变成 38/310），
 * 让人误以为「测试变多了」或「有重复定义」。CI 里没有 `.agents/` 所以一直正常——
 * 这种「本地与 CI 不一致」最难查，故显式排除。
 */
export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // worktree 里的副本、以及 agent 的临时目录，都不能计入
      "**/.agents/**",
      "**/.git/**",
    ],
  },
});
