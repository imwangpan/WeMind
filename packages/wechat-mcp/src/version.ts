import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 读取本包 package.json 的 version，用于 MCP server 上报版本号。
 * 从当前文件位置向上查找最近的 package.json：dev（src/）、tsc 产物（dist/）、
 * tsdown 打包产物（dist/index.js）三种布局下都会命中 mcp-server 自己的 package.json。
 */
function readVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  const { root } = path.parse(dir);
  while (dir && dir !== root) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const p = JSON.parse(fs.readFileSync(candidate, "utf-8")) as {
          version?: string;
        };
        if (p.version) return p.version;
      } catch {
        // 格式损坏，继续向上找
      }
    }
    dir = path.dirname(dir);
  }
  return "0.0.0";
}

export const VERSION = readVersion();
