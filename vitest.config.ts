import { defineConfig } from "vitest/config";

/**
 * vitest 配置。
 *
 * 存在的首要原因是 **exclude `.agents/`**：仓库支持 `git worktree`（DSH 等 agent 会把分支检出到 `.agents/worktrees/<branch>/`），那里的 `packages/**\/*.test.ts` 是**同一批测试文件的副本**。vitest 默认只排除 `node_modules`/`dist`，于是本地跑测试时会把每个测试计两遍（实测：19 文件/155 测试 → 出现 worktree 时变成 38/310），让人误以为「测试变多了」或「有重复定义」。CI 里没有 `.agents/` 所以一直正常——这种「本地与 CI 不一致」最难查，故显式排除。
 */
export default defineConfig({
  test: {
    // 默认池是 forks（每个测试文件一个子进程）；threads 省掉重复的进程启动，实测快约 10%
    // （全量 29.2s vs 32.1s，126 文件 / 1400+ 用例）。isolate 不能关：关掉后模块级 env 常量
    // 与 vi.mock 会跨文件残留，复现时 12–39 个用例失败、且失败集合随 worker 调度变化，所以只换池、不碰隔离。
    pool: "threads",
    // 默认 5s 在 CI 的 windows-latest 上不够：127 个测试文件并发时，真实系统调用（PowerShell CIM
    // 查询、spawn 子进程）会被排队拖慢——2026-11-24 的 CI 里 proc-identity 就因此超时（同一次
    // ubuntu 通过），此前 prepack-guard 也撞过一次 5.4s。放到 15s 后仍会失败，只是不再因为机器慢而误报。
    testTimeout: 15_000,
    setupFiles: ["./vitest.setup.ts"],
    include: ["packages/**/*.test.ts", "scripts/**/*.test.mjs"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // worktree 里的副本、以及 agent 的临时目录，都不能计入
      "**/.agents/**",
      "**/.git/**",
    ],
  },
});
