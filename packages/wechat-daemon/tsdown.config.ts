import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  // 未解析依赖（例如 core 没被内联）默认只是 warning + exit 0，产物会带裸包名 import；升级为硬失败。
  failOnWarn: true,
  // 输出 dist/cli.js（bin 指向它）；package.json 已 type:module，.js 即按 ESM 解析。
  outExtensions: () => ({ js: ".js" }),
  // CLI 是 bin 包，没有 import 它的类型消费者，不对外暴露类型，故关闭 dts。
  // 若未来要开 dts：JIT 源码包下需要单独的 tsconfig.dts.json（include core/src + rootDir 指到 packages/），见 AGENTS.md。
  dts: false,
  // 带 sourcemap 发布（dist/cli.js.map 一起进包）：产物是单文件，用户报错只有打包后的行号，没有 map 时排查要本地重打一次、再对照 //#region 段猜位置。体积约 +30%，换可排查性。
  // 注意：map 里的 sources 指向源码路径，会让源码内容出现在包里（本项目 MIT，可接受）。
  sourcemap: true,
  // 把内核内联进单一产物：发布 `wemind` 时无需单独发 @wemind/wechat-ilink-core。
  deps: {
    alwaysBundle: ["@wemind/wechat-ilink-core"],
  },
});
