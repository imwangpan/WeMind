// pm2 封装：`wemind start` / `stop` 委托 pm2 做常驻（看门狗 / 开机自启 / 多账号），即「方案 a」。
// 后续迭代到「方案 b」（自带轻量看门狗、去 pm2 依赖）时替换本模块即可，CLI 其余部分不动。
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import os from "node:os";
import path from "node:path";

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
  const root = process.env.WEMIND_HOME?.trim() || path.join(os.homedir(), ".wemind");
  return path.join(root, key, "daemon.log");
}

/** 用 pm2 启动某账号的 daemon：app 名 `wemind-<key>`，注入 WECHAT_ACCOUNT，日志归一到账号 daemon.log。 */
export function pm2Start(key: string, cliPath: string): { ok: boolean; msg: string } {
  if (!pm2Available()) {
    return {
      ok: false,
      msg: "未检测到 pm2。请先安装：npm i -g pm2，再重试 `wemind start`。",
    };
  }
  const name = `wemind-${key}`;
  const log = daemonLogPath(key);
  // 已存在同名进程则先删，确保按最新参数重启
  pm2Run(`delete ${name}`, { quiet: true });
  // stdout/stderr 都导向账号 daemon.log（与非 pm2 方式统一，看日志一个地方），并注入 WECHAT_ACCOUNT。
  const r = pm2Run(
    `start "${cliPath}" --name ${name} --interpreter node --output "${log}" --error "${log}" --merge-logs -- daemon`,
    { env: { ...process.env, WECHAT_ACCOUNT: key } },
  );
  if (r.status !== 0) return { ok: false, msg: `pm2 启动失败（exit=${r.status}）。` };
  pm2Run("save", { quiet: true });
  return {
    ok: true,
    msg:
      `已用 pm2 启动 ${name}（日志：${log}）。\n` +
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
