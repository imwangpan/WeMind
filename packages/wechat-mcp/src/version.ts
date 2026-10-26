import { readOwnVersion } from "@wemind/wechat-ilink-core";

/**
 * 本包版本号，用于 MCP server 上报（`initialize` 握手时告诉客户端 server version）。
 *
 * **版本号唯一来源是 `package.json`**，运行时读取，不手写常量。
 * 查找逻辑在 `@wemind/wechat-ilink-core` 的 `readOwnVersion()`（与 CLI 包共用一份）；
 * 必须传**本文件的** `import.meta.url`，否则会命中 core 自己的 package.json。
 *
 * dev（`src/`）、tsc 产物（`dist/`）、tsdown 单文件产物（`dist/index.js`）三种布局下，
 * 向上第一个 `name === "@wemind/wechat-mcp"` 的 package.json 都是本包自己的。
 */
export const VERSION = readOwnVersion(import.meta.url, "@wemind/wechat-mcp") ?? "0.0.0-unknown";
