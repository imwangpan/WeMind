/**
 * 把单文件产物的报错栈自动翻回 .ts：Node 默认不应用 sourcemap，且实测在模块加载后调 setSourceMapsEnabled 对已加载模块无效，所以由我们自己读同目录的 .map。
 * map 与产物是同一次构建、同一个 dist 目录，版本天然配对，用户与维护者都不必记版本号、也不必设 NODE_OPTIONS；所有启动方式（watchdog / pm2 / systemd / 计划任务 / 前台直跑）都走同一段代码。
 * 两个 bin 产物都内联 core，放这里一份实现即可；任何一步失败都原样返回，绝不因为排查便利影响主流程。
 */
import fs from "node:fs";
import path from "node:path";
import { SourceMap } from "node:module";
import { fileURLToPath } from "node:url";

/** 匹配堆栈里的 `<路径>/文件名.js:行:列`；是否属于本产物由完整路径判定，不靠目录名猜。 */
const STACK_FRAME = /((?:file:\/\/)?[^\s()]*[/\\])?([\w.-]+\.js):(\d+):(\d+)/g;

/** SourceMap 的最小可测接口（生产用 node:module 的 SourceMap，测试用假对象）。 */
export interface StackSourceMap {
  findOrigin(
    line: number,
    column: number,
  ): { fileName?: string; lineNumber?: number } | Record<string, never>;
}

/**
 * 纯函数：把指向本产物的帧替换成源码文件与行号；map 为 null、查不到或抛错都原样返回。
 * 第三参数是产物自身的绝对路径（不是文件名）：npm 全局安装与 npx 的路径里含 `node_modules`，
 * 用目录名排除会把正式发布的包全部漏掉，所以只认「完整路径等于本产物」的帧。
 */
export function mapStackToSource(
  stack: string,
  map: StackSourceMap | null,
  bundlePath: string,
): string {
  if (!map || !stack) return stack;
  const bundle = path.resolve(bundlePath);
  const bundleName = path.basename(bundle);
  return stack.replace(
    STACK_FRAME,
    (frame, prefix: string | undefined, file: string, line: string, column: string) => {
      if (!isOwnFrame(prefix, file, bundle, bundleName)) return frame;
      let origin: { fileName?: string; lineNumber?: number };
      try {
        origin = map.findOrigin(Number(line), Number(column)) as {
          fileName?: string;
          lineNumber?: number;
        };
      } catch {
        return frame;
      }
      if (!origin?.fileName || origin.lineNumber === undefined) return frame;
      return `${origin.fileName.replace(/^(\.\.\/)+/, "")}:${origin.lineNumber}`;
    },
  );
}

/** 裸文件名只按 name 认（极少数 loader 会这样打栈）；带路径的帧必须解析后与本产物完全相同。 */
function isOwnFrame(
  prefix: string | undefined,
  file: string,
  bundle: string,
  bundleName: string,
): boolean {
  if (!prefix) return file === bundleName;
  let framePath: string;
  try {
    framePath = prefix.startsWith("file://")
      ? fileURLToPath(`${prefix}${file}`)
      : path.resolve(`${prefix}${file}`);
  } catch {
    return false;
  }
  const a = path.resolve(framePath);
  const b = path.resolve(bundle);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const sourceMapCache = new Map<string, StackSourceMap | null>();

/** 读与产物同目录、同名的 .js.map（cli.js → cli.js.map）；读不到就返回 null，并缓存结果避免每条错误都解析一次 1MB 的 map。 */
export function loadOwnSourceMap(callerUrl: string): StackSourceMap | null {
  if (sourceMapCache.has(callerUrl)) return sourceMapCache.get(callerUrl) ?? null;
  let result: StackSourceMap | null = null;
  try {
    const payload = JSON.parse(fs.readFileSync(`${fileURLToPath(callerUrl)}.map`, "utf8"));
    result = new SourceMap(payload) as unknown as StackSourceMap;
  } catch {
    result = null;
  }
  sourceMapCache.set(callerUrl, result);
  return result;
}

/** 错误出口统一用它：返回可直接写进日志的字符串，堆栈里的产物行号已换成 .ts 行号。 */
export function describeError(err: unknown, callerUrl: string): string {
  const raw = err instanceof Error ? err.stack || `${err.name}: ${err.message}` : String(err);
  try {
    return mapStackToSource(raw, loadOwnSourceMap(callerUrl), fileURLToPath(callerUrl));
  } catch {
    return raw;
  }
}
