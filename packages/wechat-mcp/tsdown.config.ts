import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  // 未解析依赖（例如 core 没被内联）默认只是 warning + exit 0，产物会带裸包名 import；升级为硬失败。
  failOnWarn: true,
  // 输出 dist/index.js（而非默认 .mjs）：package.json 已是 type:module，.js 即按 ESM 解析，这样 bin/main 等对 dist/index.js 的引用无需改动。
  outExtensions: () => ({ js: ".js" }),
  // 该包是可执行 MCP server（有 bin），没有 import 它的类型消费者，不对外暴露类型，故关闭 dts。
  // 若未来要开 dts：JIT 源码包下需要单独的 tsconfig.dts.json（include core/src + rootDir 指到 packages/），见 AGENTS.md。
  dts: false,
  // 把内核内联进单一产物：发布时无需单独发布 @wemind/wechat-ilink-core。
  // 其余运行时依赖（MCP SDK / zod / qrcode）在 package.json 的 dependencies 中，tsdown 默认 external。
  deps: {
    alwaysBundle: ["@wemind/wechat-ilink-core"],
  },
});
