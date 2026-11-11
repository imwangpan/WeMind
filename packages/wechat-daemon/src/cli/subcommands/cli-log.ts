/**
 * wemind log：读某账号的 daemon.log 尾部。日志是**全量运行日志**（正常轨迹与错误混在一起），默认输出最后 N 行保留上下文，--errors 只筛错误行并带上前后各 2 行。
 * 不做 --follow：RotatingLog 靠 rename 轮转（daemon.log → daemon.log.1），跟随的句柄会指向旧文件；跨平台实现也不同，pm2 路线另有 pm2 logs。
 */
import fs from "node:fs";
import path from "node:path";
import { accountDir } from "@wemind/wechat-ilink-core";

const DEFAULT_LINES = 50;
const MAX_LINES = 2000;
const CONTEXT_LINES = 2;
const MAX_ROTATED = 20;

export const LOG_USAGE = `用法: wemind log [key|label] [--lines N] [--errors] [--file N]

  key|label     账号 key 或别名（省略 = 默认账号）
  --lines N     输出最后 N 行（1..${MAX_LINES}，默认 ${DEFAULT_LINES}；--errors 时按命中条数算）
  --errors      只筛 [ERROR]/[WARN] 行，并带前后各 ${CONTEXT_LINES} 行上下文
  --file N      看轮转文件 daemon.log.N（不传则看当前的 daemon.log）

日志是全量运行日志（正常轨迹与错误混在一起），一次性快照，不支持 --follow。`;

/** 日志行都以 `[wemind/...]` 前缀开头；只在这样的行里找错误，避免把用户消息正文里出现的 "error" 捞进来。 */
const LOG_LINE = /^\[wemind\/[^\]]+\]/;
/** 统一 logger 之后的新格式：`[wemind/<scope>][INFO|WARN|ERROR|DEBUG] …`，错误行精确匹配即可。 */
const BAD_LEVEL = /^\[wemind\/[^\]]+\]\[(ERROR|WARN)\]/;
const ANY_LEVEL = /^\[wemind\/[^\]]+\]\[(INFO|WARN|ERROR|DEBUG)\]/;

/**
 * 错误特征清单：仅用于**兼容升级前写入的旧 daemon.log**（那时没有级别标记）。新日志一律按 `[ERROR]/[WARN]` 认，不再靠关键词猜。旧文件轮转掉之后这份清单可删。
 */
export const ERROR_MARKERS = [
  "error",
  "failed",
  "fail",
  "exception",
  "reject",
  "fatal",
  "expired",
  "⚠️",
  "超时",
  "失败",
  "出错",
  "中断",
  "拒绝",
  "退避",
  "限流",
  "过期",
  "不可用",
  "接不上",
  "挂起",
  "没起得来",
] as const;

export interface LogOptions {
  sel?: string;
  lines: number;
  errorsOnly: boolean;
  file?: string;
}

/** 纯函数：解析 log 子命令参数；非法值抛错，由 runManage 的顶层 catch 统一给友好提示与 .ts 行号。 */
export function parseLogArgs(args: string[]): LogOptions {
  const opts: LogOptions = { lines: DEFAULT_LINES, errorsOnly: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--errors") {
      opts.errorsOnly = true;
      continue;
    }
    if (a === "--lines" || a === "-n") {
      const raw = args[++i];
      const n = Number(raw);
      if (!raw || !Number.isInteger(n) || n <= 0 || n > MAX_LINES)
        throw new Error(`用法: --lines <1..${MAX_LINES} 的整数>`);
      opts.lines = n;
      continue;
    }
    if (a === "--file") {
      const raw = args[++i];
      if (!raw || !/^[1-9]\d*$/.test(raw)) throw new Error("用法: --file <轮转序号，如 1>");
      opts.file = raw;
      continue;
    }
    if (a.startsWith("-")) throw new Error(`未知参数：${a}`);
    if (opts.sel !== undefined) throw new Error("只能指定一个账号（key 或 label）");
    opts.sel = a;
  }
  return opts;
}

/** 新日志认级别标记（精确、不误伤正文）；无标记的旧日志回退到关键词，保证升级后仍能看到历史错误。 */
export function isErrorLine(line: string): boolean {
  if (!LOG_LINE.test(line)) return false;
  if (BAD_LEVEL.test(line)) return true;
  if (ANY_LEVEL.test(line)) return false;
  const lower = line.toLowerCase();
  return ERROR_MARKERS.some((marker) => lower.includes(marker));
}

export interface LogView {
  path: string;
  total: number;
  /** errorsOnly 时全文命中的错误行数（不是输出行数）。 */
  hits: number;
  shown: string[];
  rotated: string[];
}

/** 纯函数：读日志尾部；errorsOnly 时先全文找错误行、取最后 N 条命中，再各自扩展到前后 CONTEXT_LINES 行（去重、按原顺序）。 */
export function readLogTail(dir: string, opts: LogOptions): LogView {
  const base = path.join(dir, "daemon.log");
  const target = opts.file ? `${base}.${opts.file}` : base;
  let text = "";
  try {
    text = fs.readFileSync(target, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const all = text ? text.replace(/\r\n/g, "\n").split("\n") : [];
  if (all.at(-1) === "") all.pop();
  const rotated = Array.from({ length: MAX_ROTATED }, (_, i) => String(i + 1))
    .filter((n) => n !== opts.file)
    .map((n) => `${base}.${n}`)
    .filter((file) => fs.existsSync(file));
  if (!opts.errorsOnly) {
    return { path: target, total: all.length, hits: 0, shown: all.slice(-opts.lines), rotated };
  }
  const hitIdx = all.flatMap((line, i) => (isErrorLine(line) ? [i] : []));
  const picked = new Set<number>();
  for (const i of hitIdx.slice(-opts.lines)) {
    for (
      let j = Math.max(0, i - CONTEXT_LINES);
      j <= Math.min(all.length - 1, i + CONTEXT_LINES);
      j++
    )
      picked.add(j);
  }
  const shown = [...picked].sort((a, b) => a - b).map((i) => all[i]);
  return { path: target, total: all.length, hits: hitIdx.length, shown, rotated };
}

/** 输出给用户：路径与统计 + 尾部内容 + 更早的轮转文件提示。 */
export function cmdLog(key: string, opts: LogOptions): string {
  const view = readLogTail(accountDir(key), opts);
  const stat = view.total
    ? `（共 ${view.total} 行${
        opts.errorsOnly
          ? `，命中 ${view.hits} 条错误，输出含上下文 ${view.shown.length} 行`
          : `，显示最后 ${view.shown.length} 行`
      }）`
    : "（文件不存在或为空）";
  const body = view.shown.length ? view.shown.join("\n") : "（没有可显示的行）";
  const older = view.rotated.length
    ? `\n\n还有更早的轮转日志：${view.rotated.join("、")}（用 \`wemind log --file <序号>\` 查看）`
    : "";
  return `账号 ${key} 日志：${view.path}${stat}\n\n${body}${older}`;
}
