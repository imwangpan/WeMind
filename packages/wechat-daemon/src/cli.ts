#!/usr/bin/env node
/**
 * wemind —— 完整应用的命令行入口（bin）。
 * - 子命令 `daemon`：跑 daemon 本体（长轮询 + 大脑 + worker），通常由 pm2 调用，用户不直接用。
 * - 其余子命令（login/list/start/stop/task…）：交给 manage 派发。
 */
import { createLogger, describeError } from "@wemind/wechat-ilink-core";
import { cliHook } from "./cli/cli-dispatch.js";
import { runDaemon } from "./index.js";
import { runManage } from "./cli/manage.js";
import { runWatchdog } from "./cli/watchdog-runner.js";
const log = createLogger("wechat-daemon");
const watchdogLog = log.child("watchdog");
const cliLog = log.child("cli");

const argv = process.argv.slice(2);
const hook = cliHook(argv);

if (hook === "daemon") {
  runDaemon().catch((err: unknown) => {
    log.error("fatal:", describeError(err, import.meta.url));
    process.exit(1);
  });
} else if (hook === "watchdog") {
  runWatchdog().catch((err: unknown) => {
    watchdogLog.error("fatal:", describeError(err, import.meta.url));
    process.exit(1);
  });
} else {
  runManage(argv).catch((e: unknown) => {
    cliLog.error(describeError(e, import.meta.url));
    process.exit(1);
  });
}
