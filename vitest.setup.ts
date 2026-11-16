import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

/**
 * 测试隔离：不能读开发者真实的 `~/.wemind/.agents`。
 * 注册表每次按 `WEMIND_AGENTS_DIR` 重扫，所以这里只设一个空临时目录即可；
 * 需要本机定义的用例自己在用例里改这个变量。
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-agents-"));
process.env.WEMIND_AGENTS_DIR = dir;

afterAll(() => {
  delete process.env.WEMIND_AGENTS_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});
