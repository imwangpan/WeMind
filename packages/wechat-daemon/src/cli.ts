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
import { preloadAgentAdapters } from "./agents/agent-adapter-loader.js";
const log = createLogger("wechat-daemon");
const watchdogLog = log.child("watchdog");
const cliLog = log.child("cli");

const argv = process.argv.slice(2);
const hook = cliHook(argv);

async function main(): Promise<void> {
  // ESM adapter 只能异步 import；在同步解析器看到定义前先把它们放进缓存。
  const preloaded = await preloadAgentAdapters();
  for (const problem of preloaded.problems) log.warn(problem);
  if (hook === "daemon") return runDaemon();
  if (hook === "watchdog") return runWatchdog();
  return runManage(argv);
}

main().catch((err: unknown) => {
  const target = hook === "watchdog" ? watchdogLog : hook === "daemon" ? log : cliLog;
  target.error("fatal:", describeError(err, import.meta.url));
  process.exit(1);
});
