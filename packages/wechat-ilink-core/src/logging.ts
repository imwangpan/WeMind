/**
 * 两个发布包共用的输出出口：运行日志走 stderr 且带级别，用户输出走 stdout 且保持纯文本。
 * 之前各模块自己拼 `const log = (...a) => console.error("[wemind/xxx]", ...a)`（5 份），另有裸 console.error / console.log 散落各处；这里收敛成两个出口。
 * 级别**写进日志文本**而不是分流 stdout/stderr：watchdog 会把子进程的 stdout 与 stderr 合并进同一个 daemon.log，分流后通道信息落盘即丢、还会乱序；MCP 的 stdout 更是 JSON-RPC 帧通道，不能写日志。
 */
export const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Logger {
  /** 预留：接新 agent / 调 ACP 协议时的逐帧细节；默认静默，WEMIND_LOG_LEVEL=debug 才输出。当前没有调用点。 */
  debug(...a: unknown[]): void;
  /** 正常运行的关键节点，排障必须可见（含 ACP 的 spawn / initialized / session/new / prompt ok 等线索）。 */
  info(...a: unknown[]): void;
  /** 可恢复的异常或降级（限流退避、会话过期、重试、自愈）。 */
  warn(...a: unknown[]): void;
  /** 失败，需要人处理（未捕获异常、回合失败、fatal）。 */
  error(...a: unknown[]): void;
  /** 子系统日志：createLogger("wechat-daemon").child("acp") → `[wemind/wechat-daemon/acp]`。 */
  child(scope: string): Logger;
}

/** DEBUG 默认不输出；这是为将来预留的开关，目前项目没有 debug 调用点。 */
function debugEnabled(): boolean {
  return process.env.WEMIND_LOG_LEVEL?.trim().toLowerCase() === "debug";
}

/** 所有级别都写 stderr：保住 MCP 的 stdout 帧通道，也让 watchdog 的合并保持单一来源、不产生乱序。 */
export function createLogger(scope: string): Logger {
  const emit =
    (level: LogLevel) =>
    (...a: unknown[]): void => {
      const prefix = `[wemind/${scope}][${level}]`;
      // console.error/console.warn 在这里只是「写到 stderr」的出口，不代表内容是错误：Node 的 console.log/info/debug 全部走 stdout，而 stdout 要留给 CLI 用户输出与 MCP 的 JSON-RPC 帧。
      if (level === "WARN") console.warn(prefix, ...a);
      else console.error(prefix, ...a);
    };
  const debug = emit("DEBUG");
  return {
    debug: (...a: unknown[]) => {
      if (debugEnabled()) debug(...a);
    },
    info: emit("INFO"),
    warn: emit("WARN"),
    error: emit("ERROR"),
    child: (sub: string) => createLogger(`${scope}/${sub}`),
  };
}

/**
 * CLI 用户输出：命令结果、二维码、交互问答、帮助文本。纯文本、无前缀、无级别，**必须留在 stdout**。
 * CI 装包冒烟直接断言 `wemind version` / `wemind help` 的输出，readline 也用 process.stdout 配对；加任何前缀都会破坏它们。
 */
export function print(...a: unknown[]): void {
  console.log(...a);
}
