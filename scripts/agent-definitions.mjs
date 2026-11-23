/**
 * 读取内置 agent 定义（`packages/wechat-daemon/src/agents/definitions/*.json`）。
 *
 * 文档守卫（check-agent-docs / gen-docs-tables）的唯一键源。定义本身是纯 JSON，
 * 所以不用再解析 TypeScript 源码里的对象字面量——加一个 agent 只需要放一份 JSON。
 */
import fs from "node:fs";
import path from "node:path";

export const DEFINITIONS_DIR = "packages/wechat-daemon/src/agents/definitions";

/** 解析一份定义并校验「文件名 = name」；错误信息带上文件名，守卫报错时能直接定位。 */
export function parseDefinition(source, file) {
  let raw;
  try {
    raw = JSON.parse(source);
  } catch (e) {
    throw new Error(`${file}: JSON 解析失败：${e.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`${file}: 定义应是一个 JSON 对象`);
  if (typeof raw.name !== "string" || raw.name === "") throw new Error(`${file}: 缺少非空的 name`);
  const expected = path.basename(file, ".json");
  if (raw.name !== expected)
    throw new Error(`${file}: name「${raw.name}」与文件名不一致（必须相同）`);
  return raw;
}

/** 读取全部内置定义；按文件名排序，保证生成表格与检查输出稳定。 */
export function readBuiltinDefinitions(root) {
  const dir = path.join(root, DEFINITIONS_DIR);
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => parseDefinition(fs.readFileSync(path.join(dir, file), "utf8"), file));
}
