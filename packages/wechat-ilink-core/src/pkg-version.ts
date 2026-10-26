import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 读取「调用方所在包」自己的版本号（从它的 package.json）。
 *
 * ## 为什么放在 core
 * `@wemind/wechat-mcp` 与 `@wemind/cli` 都需要上报自己的版本，两边的「向上查找 package.json」
 * 逻辑完全一样。放 core 里只维护一份；两个消费方各留一个 3 行的薄适配层。
 *
 * ## 为什么必须由调用方传入位置（`callerUrl`）
 * `import.meta.url` 指向**当前文件**，而当前文件在 core 里——用它去向上找，命中的会是 core
 * 自己的 `package.json`（或更上层的仓库根），**永远拿不到调用方的版本**。
 * 实测过：在 daemon 语境里直接复用 mcp 的同类实现，得到的是 mcp 的版本（1.0.4）而不是
 * daemon 的（1.1.0），且不会报错——静默给错值是最坏的一类 bug。
 * 所以这里强制由调用方传 `import.meta.url`，函数从**那个位置**向上找。
 *
 * ## 为什么还要 expectedName
 * 只按「最近的 package.json」查找并不可靠：在 monorepo 里向上找，可能先撞到 core 的、
 * 也可能撞到仓库根的。用 `name` 精确匹配，命中不了就返回 `undefined`（安全失败），
 * 由调用方决定兜底值，绝不静默返回别人的版本。
 *
 * ## 打包后仍然有效
 * 两个消费方都用 tsdown 把 core **内联**进单文件产物。由于查找起点是调用方的
 * `import.meta.url`（打包后是 `dist/cli.js` / `dist/index.js`），向上第一个带
 * `name` 匹配的 `package.json` 正是该消费方自己的——dev（`src/`）与产物（`dist/`）两种布局都成立。
 *
 * @param callerUrl 调用方模块的 `import.meta.url`
 * @param expectedName 期望的包名（即调用方自己 package.json 的 `name`）
 * @returns 匹配到的 `version`；找不到返回 `undefined`
 */
export function readOwnVersion(callerUrl: string, expectedName: string): string | undefined {
  if (!callerUrl || !expectedName) return undefined;
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(callerUrl));
  } catch {
    // callerUrl 不是合法 file: URL（如打包器改写了它）：安全失败
    return undefined;
  }
  const { root } = path.parse(dir);
  while (dir && dir !== root) {
    const candidate = path.join(dir, "package.json");
    try {
      const p = JSON.parse(fs.readFileSync(candidate, "utf-8")) as {
        name?: string;
        version?: string;
      };
      if (p.name === expectedName && p.version) return p.version;
    } catch {
      // 文件不存在 / 非法 JSON：都不是目标，继续向上
    }
    dir = path.dirname(dir);
  }
  return undefined;
}
