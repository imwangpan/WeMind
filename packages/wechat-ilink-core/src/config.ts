/**
 * iLink 应用标识。
 * 原 fork 从 package.json 的 ilink_appid 字段读取（向上查找）；拆为 workspace 多包后，该耦合不再可靠（mcp-server 打包后会找到错误的 package.json），固化为常量，并允许 env 覆盖。
 */
export const ILINK_APP_ID = process.env.ILINK_APP_ID?.trim() || "bot";
