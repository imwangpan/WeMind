/** cli.js 的三个入口：daemon 本体 / 后台守护进程 / 管理命令。单独成模块以便单测（cli.ts 导入即执行）。 */
export type CliHook = "daemon" | "watchdog" | "manage";

export function cliHook(argv: readonly string[]): CliHook {
  if (argv[0] === "daemon") return "daemon";
  if (argv[0] === "_watchdog") return "watchdog";
  return "manage";
}
