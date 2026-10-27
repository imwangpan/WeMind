import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  // 输出 dist/index.js（而非默认 .mjs）：package.json 已是 type:module，.js 即按 ESM 解析，这样 bin/main 等对 dist/index.js 的引用无需改动。
  outExtensions: () => ({ js: ".js" }),
  // 该包是可执行 MCP server（有 bin），不对外暴露类型，故关闭 dts。
  // 关掉 dts 还能避免 tsdown 去加载 typescript 包——TypeScript 7.0(原生)已不再暴露旧的 JS API。
  dts: false,
  // 把内核内联进单一产物：发布时无需单独发布 @wemind/wechat-ilink-core。
  // 其余运行时依赖（MCP SDK / zod / qrcode）在 package.json 的 dependencies 中，tsdown 默认 external。
  deps: {
    alwaysBundle: ["@wemind/wechat-ilink-core"],
  },
});
