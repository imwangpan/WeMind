import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 向上查找本包自己的 package.json，读取 version 与 ilink_appid。
 * 不写死路径以兼容 dev（src/）与构建产物（dist/）两种布局。
 * 查找逻辑借鉴自官方 Tencent/openclaw-weixin（MIT）。
 */
function readPkg(): { version: string; ilinkAppId: string } {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  const { root } = path.parse(dir);
  while (dir && dir !== root) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const p = JSON.parse(fs.readFileSync(candidate, "utf-8")) as {
          name?: string;
          version?: string;
          ilink_appid?: string;
        };
        if (p.name === "mcp-wechat-server" || p.ilink_appid !== undefined) {
          return { version: p.version ?? "0.0.0", ilinkAppId: p.ilink_appid ?? "bot" };
        }
      } catch {
        // 格式损坏，继续向上找
      }
    }
    dir = path.dirname(dir);
  }
  return { version: "0.0.0", ilinkAppId: "bot" };
}

export const PKG = readPkg();
