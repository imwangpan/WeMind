import type { Logger } from "@wemind/wechat-ilink-core";

/** 回调式组件的日志接口：第一参数是级别，后面才是正文；避免把错误一律压成 INFO。 */
export type LogLevelName = "info" | "warn" | "error";
export type LeveledLog = (level: LogLevelName, ...a: unknown[]) => void;

/** 把 core 的 Logger 适配成 LeveledLog（daemon 各处注入用）。 */
export function bindLogger(logger: Logger): LeveledLog {
  return (level, ...a) => logger[level](...a);
}
