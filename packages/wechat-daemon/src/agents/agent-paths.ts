import path from "node:path";

import { WEMIND_ROOT } from "@wemind/wechat-ilink-core";

/** 本机定义目录：`~/.wemind/.agents`；点号目录不会与账号 key 撞名。 */
export function agentsDir(): string {
  return process.env.WEMIND_AGENTS_DIR?.trim() || path.join(WEMIND_ROOT, ".agents");
}

/** 安装来源清单（`agent list` 用它区分「数据包」与本机手写定义）。 */
export function agentSourcesFile(): string {
  return path.join(agentsDir(), ".sources.json");
}
