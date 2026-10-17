import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

/*
 * 启动 ACP agent 进程的**统一入口**。
 *
 * 为什么不是 `spawn(bin, args[], { shell: true })`：
 *   Node 20+ 对这种写法报 DEP0190——`shell:true` 时 `args` 只是用空格拼进命令串、不做任何转义
 *   （既是注入面，也会在 daemon.log 里每次冷启动刷两行弃用警告）。
 *   正确做法是**自己把整条命令拼成一个字符串**再交给 shell，参数由我们逐条加引号。
 *   仓库里的 pm2-runner.ts 出于同样原因用了同样的写法。
 *
 * 为什么仍然要经 shell：
 *   Windows 上 npm shim（opencode / npx / gemini）都是 `.cmd`，而 Node 20+ **禁止**无 shell
 *   直接 spawn `.cmd`/`.bat`（EINVAL，CVE-2024-27980 之后的安全限制），所以只能让 cmd.exe
 *   去解析 PATH。POSIX 上同一份代码走 `/bin/sh -c`，正好覆盖两侧。
 *
 * 注：既然经 shell，cmd 的元字符语义就生效（参数必须逐条加引号；`%VAR%` 仍会被展开），
 * 这与改动前的行为一致，不引入新语义。
 */

/** 启动所需的最小 agent 描述（`ResolvedAgent` 的子集，避免反向依赖 brain-agents）。 */
export type SpawnableAgent = {
  bin: string;
  args: readonly string[];
  shell: boolean;
};

/** cmd 需要加引号的字符：空白 + 元字符（不加引号时 cmd 会自行解释：`&` 断命令、`|` 管道…）。 */
const CMD_NEEDS_QUOTE = /[\s"&|<>^()%!]/;

/**
 * cmd.exe（MS CRT）参数转义：无空白/元字符则裸写；否则用双引号包裹，
 * 并按其规则处理引号前的前导反斜杠与结尾反斜杠。
 * 注：引号挡得住元字符，但挡不住 `%VAR%` 展开（cmd 命令行无法转义 `%`），与改动前行为一致。
 */
export function quoteCmdArg(arg: string): string {
  if (arg === "") return '""';
  if (!CMD_NEEDS_QUOTE.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** POSIX sh 参数转义：安全字符集裸写，否则单引号包裹（内部单引号写成 `'\''`）。 */
export function quoteShArg(arg: string): string {
  if (arg === "") return "''";
  if (!/[^\w@%+=:,./-]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** 把 `bin + args` 拼成一条交给 shell 的命令行（`platform` 仅为可测性暴露）。 */
export function buildShellLine(
  bin: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  const quote = platform === "win32" ? quoteCmdArg : quoteShArg;
  return [bin, ...args].map(quote).join(" ");
}

/**
 * 启动 agent：`shell=true` 的走「整串命令行 + shell」（见文件头注释），其余直接 spawn。
 * 默认 `windowsHide: true`（不闪控制台窗口），其余选项透传。
 */
export function spawnAgent(
  agent: SpawnableAgent,
  opts: SpawnOptionsWithoutStdio = {},
): ChildProcessWithoutNullStreams {
  const base: SpawnOptionsWithoutStdio = { windowsHide: true, ...opts };
  if (!agent.shell) return spawn(agent.bin, agent.args, base);
  return spawn(buildShellLine(agent.bin, agent.args), { ...base, shell: true });
}
