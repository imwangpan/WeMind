#!/usr/bin/env node
/**
 * wemind —— 完整应用的命令行入口（bin）。
 * - 子命令 `daemon`：跑 daemon 本体（长轮询 + 大脑 + worker），通常由 pm2 调用，用户不直接用。
 * - 其余子命令（login/list/start/stop/task…）：交给 manage 派发。
 */
import { runDaemon } from "./index.js";
import { runManage } from "./manage.js";

const argv = process.argv.slice(2);

if (argv[0] === "daemon") {
  runDaemon().catch((err: unknown) => {
    console.error("[daemon] fatal:", err);
    process.exit(1);
  });
} else {
  runManage(argv).catch((e: unknown) => {
    console.error("error:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
