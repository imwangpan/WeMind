// pm2 封装：`wemind start --runner pm2` / `stop` 委托 pm2 做常驻（看门狗 / 开机自启 / 多账号）。
// 默认 runner 是自带看门狗（watchdog-runner.ts）；本模块只在用户显式选 pm2 时使用。
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { accountDir } from "@wemind/wechat-ilink-core"; // 与 daemon 自身用的是同一个根（尊重 WEMIND_HOME）

import { BRAIN_CONFIG_EXIT_CODE } from "./brain-agents.js";

/*
 * 统一用「单条命令字符串 + shell」调用 pm2，而不是 spawnSync(cmd, args[], { shell: true })。
 * 后者在 Node 20+ 会触发 DEP0190 弃用警告（shell:true 同时传 args 数组、参数仅拼接不转义）。
 * 这里命令中只拼入受控值：固定的 cliPath（import.meta 解析得到）、账号 key 派生的 name 与日志路径，
 * 且路径都加引号处理空格——无任何外部不可信输入，无注入风险。
 */
function pm2Run(
  cmd: string,
  opts: { quiet?: boolean; env?: NodeJS.ProcessEnv } = {},
): SpawnSyncReturns<Buffer> {
  return spawnSync(`pm2 ${cmd}`, {
    shell: true,
    stdio: opts.quiet ? "ignore" : "inherit",
    env: opts.env ?? process.env,
    windowsHide: true, // 避免瞬时闪出控制台窗口
  });
}

/** pm2 是否已全局安装、可用。 */
export function pm2Available(): boolean {
  try {
    return pm2Run("-v", { quiet: true }).status === 0;
  } catch {
    return false;
  }
}

/** 账号的 daemon 日志路径，与 run-daemon.ps1 / ecosystem 方式一致：`~/.wemind/<key>/daemon.log`。 */
function daemonLogPath(key: string): string {
  return path.join(accountDir(key), "daemon.log");
}

/**
 * 生成 pm2 的 app 声明（`{ apps: [decl] }`，写进账号目录的 `pm2.app.json`）。
 *
 * **为什么用 JSON 声明而不是把参数堆在 `pm2 start` 命令行上**：
 * - `restart_delay` / `stop_exit_codes` / `max_restarts` 在命令行上是 `--restart-delay` /
 *   `--stop-exit-codes`（**变参**）/ `--max-restarts`，还要和 `-- daemon` 这个「脚本参数分隔符」
 *   挤在同一条命令里——解析顺序、变参吞掉后续 token 的风险都只能靠真机试；
 * - JSON 声明没有解析层：键值原样进 `pm2_env`（`stop_exit_codes` 在 `God.handleExit` 里既接受
 *   数字数组也接受数字字符串，这里给数字数组），与 `ecosystem.config.cjs` 同源同义；
 * - 路径全走 JSON 转义，不再依赖 shell 引号。
 *
 * 与 `ecosystem.config.cjs` 保持一致的项：app 名 `wemind-<key>`、崩溃 5s 重拉、最多 50 次、
 * 退出码 78（大脑配置错误）不重启、日志合并到账号 `daemon.log`。导出供单测直接断言（不需要装 pm2）。
 */
export function buildAppDeclaration(
  key: string,
  cliPath: string,
  logPath: string,
): Record<string, unknown> {
  return {
    name: `wemind-${key}`,
    script: cliPath,
    args: "daemon", // 等价于 `cli.js daemon`；不必再依赖 `-- daemon` 分隔符
    interpreter: "node",
    cwd: os.homedir(), // 不继承 `pm2 start` 时的 shell 目录（换了目录再 start 行为才一致）
    autorestart: true,
    restart_delay: 5000, // 与 builtin 看门狗 / run-daemon.ps1 的 5s 重拉一致
    max_restarts: 50, // 防崩溃风暴
    stop_exit_codes: [BRAIN_CONFIG_EXIT_CODE], // 78 = 大脑配置错误，重拉无益
    out_file: logPath,
    error_file: logPath,
    merge_logs: true,
    watch: false, // daemon 是长轮询常驻进程
    // 只声明账号；其余（DEEPSEEK_API_KEY、WEMIND_HOME 等）由 pm2 从执行 `pm2 start` 的进程环境
    // 合并进来（`Common.prepareAppConf`：shell env 打底、声明里的 env 覆盖）——与改动前一致。
    env: { WECHAT_ACCOUNT: key },
  };
}

/**
 * 把声明写进账号目录，返回文件路径。单独导出便于测试（不触碰 pm2）；
 * `dir` 可覆盖目标目录——单测传临时目录，避免动真实 `~/.wemind`。
 */
export function writeAppDeclaration(
  key: string,
  cliPath: string,
  logPath: string,
  dir: string = accountDir(key),
): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "pm2.app.json");
  const apps = [buildAppDeclaration(key, cliPath, logPath)];
  fs.writeFileSync(file, JSON.stringify({ apps }, null, 2) + "\n", "utf-8");
  return file;
}

/** 用 pm2 启动某账号的 daemon：app 名 `wemind-<key>`，注入 WECHAT_ACCOUNT，日志归一到账号 daemon.log。 */
export function pm2Start(key: string, cliPath: string): { ok: boolean; msg: string } {
  if (!pm2Available()) {
    return {
      ok: false,
      msg: "未检测到 pm2。请先安装：npm i -g pm2，再重试 `wemind start`。",
    };
  }
  const log = daemonLogPath(key);
  const name = `wemind-${key}`;
  // 已存在同名进程则先删，确保按最新声明重启
  pm2Run(`delete ${name}`, { quiet: true });
  const decl = writeAppDeclaration(key, cliPath, log);
  const r = pm2Run(`start "${decl}"`, { env: { ...process.env, WECHAT_ACCOUNT: key } });
  if (r.status !== 0) {
    return { ok: false, msg: `pm2 启动失败（exit=${r.status}），声明文件：${decl}` };
  }
  pm2Run("save", { quiet: true });
  return {
    ok: true,
    msg:
      `已用 pm2 启动 ${name}（日志：${log}）。\n` +
      "  崩溃 5s 重拉、退出码 78（大脑配置错误）不再重启，与自带看门狗一致。\n" +
      "  开机自启（首次）：执行 `pm2 startup`——Linux/macOS 按提示操作；Windows 用计划任务跑 `pm2 resurrect`。",
  };
}

/** 停止某账号的 daemon（pm2 delete）。 */
export function pm2Stop(key: string): { ok: boolean; msg: string } {
  if (!pm2Available()) return { ok: false, msg: "未检测到 pm2。" };
  const name = `wemind-${key}`;
  const r = pm2Run(`delete ${name}`, { quiet: true });
  pm2Run("save", { quiet: true });
  return r.status === 0
    ? { ok: true, msg: `已停止 ${name}。` }
    : { ok: false, msg: `${name} 未在运行，或停止失败。` };
}
