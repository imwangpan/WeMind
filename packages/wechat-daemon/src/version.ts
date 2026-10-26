/**
 * CLI 版本号（`wemind version` / `wemind --version` / help 头部）。
 * 与 package.json 的 version 必须一致——单测 version.test.ts 会读 package.json 校验，
 * 避免「发了新版本、CLI 还报旧版本号」这种排查成本极高的小漂移。
 */
export const CLI_VERSION = "1.0.0";

/**
 * npm 包名（与 package.json 的 name 一致，单测校验）。
 * 命令名是 `wemind`，但**包名**是 `@wemind/cli`——两者不同，所以 `npx` 不能靠「唯一 bin」自动解析，
 * 必须写全 `npx @wemind/cli`（见 README 与 docs/发布-wemind-npm.md）。
 */
export const CLI_PKG_NAME = "@wemind/cli";

/** 单行版本串（供 --version 输出）：命令名 + 版本，包名放括号里便于反馈问题时对上 npm 页面。 */
export function versionLine(): string {
  return `wemind ${CLI_VERSION} (${CLI_PKG_NAME}, node ${process.versions.node}, ${process.platform}-${process.arch})`;
}
