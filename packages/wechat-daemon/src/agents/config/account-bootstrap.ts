import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

import { ensureWechatSettings } from "./wechat-settings.js";

/**
 * 新账号的 parity 目录骨架。
 *
 * 只创建“即使没有内容也需要存在”的目录/空文件；不写 `workspace.json`（默认 managed 由代码计算，
 * 写死绝对路径反而会让搬移账号目录后失效），也不写 `runtime.json`（缺省就是 direct）。
 */
export function ensureParityAccountDirs(dir: string = DATA_DIR): void {
  for (const rel of ["agent-overrides", "media/inbound", "workspace/brain", "workspace/worker"]) {
    fs.mkdirSync(path.join(dir, rel), { recursive: true, mode: 0o700 });
  }
  ensureWechatSettings(dir);
}
