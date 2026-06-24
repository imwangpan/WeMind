import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  // 输出 dist/cli.js（bin 指向它）；package.json 已 type:module，.js 即按 ESM 解析。
  outExtensions: () => ({ js: ".js" }),
  // CLI 不对外暴露类型；关 dts 也避免 tsdown 去加载 typescript 包
  // （TypeScript 7.0 原生编译器已不再暴露旧的 JS API，加载即报错）。
  dts: false,
  // 把内核内联进单一产物：发布 `wemind` 时无需单独发 @wemind/wechat-ilink-core。
  deps: {
    alwaysBundle: ["@wemind/wechat-ilink-core"],
  },
});
