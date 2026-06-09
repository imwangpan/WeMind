import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  // 把内核内联进单一产物：发布时无需单独发布 @wemind/wechat-ilink-core。
  // 其余运行时依赖（MCP SDK / zod / qrcode）保持 external，由使用者安装。
  noExternal: ["@wemind/wechat-ilink-core"],
  // 入口文件的 shebang 由 esbuild 自动保留，无需重复注入 banner。
});
