import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

import { stripVscodeDebugEnv } from "../debug-env.js";

/*
 * 启动 ACP agent 进程的**统一入口**。
 *
 * 为什么不是 `spawn(bin, args[], { shell: true })`：
 *   Node 20+ 对这种写法报 DEP0190——`shell:true` 时 `args` 只是用空格拼进命令串、不做任何转义（既是注入面，也会在 daemon.log 里每次冷启动刷两行弃用警告）。
 *   正确做法是**自己把整条命令拼成一个字符串**再交给 shell，参数由我们逐条加引号。
 *   仓库里的 pm2-runner.ts 出于同样原因用了同样的写法。
 *
 * 为什么仍然要经 shell：
 *   Windows 上 npm shim（opencode / npx / gemini）都是 `.cmd`，而 Node 20+ **禁止**无 shell 直接 spawn `.cmd`/`.bat`（EINVAL，CVE-2024-27980 之后的安全限制），所以只能让 cmd.exe 去解析 PATH。POSIX 上同一份代码走 `/bin/sh -c`，正好覆盖两侧。
 *
 * 注：既然经 shell，cmd 的元字符语义就生效（参数必须逐条加引号；`%VAR%` 仍会被展开），这与改动前的行为一致，不引入新语义。
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
 * Windows 经 shell 启动时的子进程环境：设置 `NoDefaultCurrentDirectoryInExePath=1`，禁止 cmd/CreateProcess
 * 从**当前目录**解析裸命令名。worker 的 cwd 是任务目录（`--cwd`，可能指向用户项目），里面若有一个同名
 * `.cmd`，就会被当成要启动的 agent——这是提权/劫持面。POSIX 原样返回，不引入 Windows 专用变量。
 * 导出仅供单测。
 */
export function shellEnv(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  if (platform !== "win32") return env;
  return { ...(env ?? process.env), NoDefaultCurrentDirectoryInExePath: "1" };
}

/**
 * 交给 ACP 子进程的环境：摘掉 VS Code 注入的调试引导（见 `debug-env.ts`）。
 *
 * 为什么子进程也要摘：前台 `wemind daemon` 在 VS Code 集成终端里启动时，daemon 自身被接上、跑得好好的，
 * 但它 spawn 的 agent（多为 node 脚本）会继承 `NODE_OPTIONS=--require …/bootloader.js`，等一个永远不会来的调试器，
 * 表现为 `initialize` 迟迟不回。与 watchdog 的脱离式 spawn 是同一个注入，处理方式相同。
 * 导出仅供单测。
 */
export function spawnEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return stripVscodeDebugEnv(env ?? process.env);
}

/**
 * 启动 agent：`shell=true` 的走「整串命令行 + shell」（见文件头注释），其余直接 spawn。
 * 默认 `windowsHide: true`（不闪控制台窗口），其余选项透传。
 */
export function spawnAgent(
  agent: SpawnableAgent,
  opts: SpawnOptionsWithoutStdio = {},
): ChildProcessWithoutNullStreams {
  const base: SpawnOptionsWithoutStdio = {
    windowsHide: true,
    ...opts,
    env: spawnEnv(opts.env),
  };
  if (!agent.shell) return spawn(agent.bin, agent.args, base);
  const shellOpts: SpawnOptionsWithoutStdio = { ...base, shell: true };
  const env = shellEnv(process.platform, base.env);
  if (env !== base.env) shellOpts.env = env;
  return spawn(buildShellLine(agent.bin, agent.args), shellOpts);
}
