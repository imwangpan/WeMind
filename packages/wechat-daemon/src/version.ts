import { readOwnVersion } from "@wemind/wechat-ilink-core";

/**
 * CLI 版本号与包身份（`wemind version` / `wemind --version` / help 头部）。
 *
 * **版本号唯一来源是 `package.json`**，这里在运行时读它，不再手写常量。
 * 为什么：以前版本号散落在 package.json 和本文件两处，`npm version` 只会改前者，
 * 漏改本文件会导致「发了 1.2.0、`wemind version` 还报 1.1.0」这种极难排查的漂移。
 * 现在 `npm run release:patch|minor|major` 一步到位，本文件自动跟着变。
 *
 * 查找逻辑在 `@wemind/wechat-ilink-core` 的 `readOwnVersion()`（与 MCP 包共用一份）：
 * 必须把**本文件的** `import.meta.url` 传进去，否则会命中的是 core 自己的 package.json。
 */

/** 期望的 npm 包名。这是**独立常量**，故意不从 package.json 读——它是校验基准。 */
export const CLI_PKG_NAME = "@wemind/cli";

/**
 * 包版本。正常情况下等于 `package.json` 的 `version`；
 * 若查找失败（不该发生），退化为可识别的占位值，单测会把它当失败信号。
 */
export const CLI_VERSION = readOwnVersion(import.meta.url, CLI_PKG_NAME) ?? "0.0.0-unknown";

/** 单行版本串（供 --version 输出）：命令名 + 版本，包名放括号里便于反馈问题时对上 npm 页面。 */
export function versionLine(): string {
  return `wemind ${CLI_VERSION} (${CLI_PKG_NAME}, node ${process.versions.node}, ${process.platform}-${process.arch})`;
}
