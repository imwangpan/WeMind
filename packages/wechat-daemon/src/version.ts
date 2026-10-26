/**
 * CLI 版本号（`wemind version` / `wemind --version` / help 头部）。
 * 与 package.json 的 version 必须一致——单测 version.test.ts 会读 package.json 校验，
 * 避免「发了新版本、CLI 还报旧版本号」这种排查成本极高的小漂移。
 */
export const CLI_VERSION = "1.1.0";

/** 单行版本串（供 --version 输出）。 */
export function versionLine(): string {
  return `wemind ${CLI_VERSION} (node ${process.versions.node}, ${process.platform}-${process.arch})`;
}
