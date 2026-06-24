// pm2 封装：`wemind start` / `stop` 委托 pm2 做常驻（看门狗 / 开机自启 / 多账号），即「方案 a」。
// 后续迭代到「方案 b」（自带轻量看门狗、去 pm2 依赖）时替换本模块即可，CLI 其余部分不动。
import { spawnSync } from "node:child_process";

// Windows 上 pm2 是 pm2.cmd，需经 shell 解析；其余平台直接调用。
const useShell = process.platform === "win32";

/** pm2 是否已全局安装、可用。 */
export function pm2Available(): boolean {
  try {
    const r = spawnSync("pm2", ["-v"], { shell: useShell, stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** 用 pm2 启动某账号的 daemon：app 名 `wemind-<key>`，注入 WECHAT_ACCOUNT，跑 `<cli> daemon`。 */
export function pm2Start(key: string, cliPath: string): { ok: boolean; msg: string } {
  if (!pm2Available()) {
    return {
      ok: false,
      msg: "未检测到 pm2。请先安装：npm i -g pm2，再重试 `wemind start`。",
    };
  }
  const name = `wemind-${key}`;
  // 已存在同名进程则先删，确保按最新参数重启
  spawnSync("pm2", ["delete", name], { shell: useShell, stdio: "ignore" });
  const r = spawnSync(
    "pm2",
    ["start", cliPath, "--name", name, "--interpreter", "node", "--", "daemon"],
    { shell: useShell, stdio: "inherit", env: { ...process.env, WECHAT_ACCOUNT: key } },
  );
  if (r.status !== 0) return { ok: false, msg: `pm2 启动失败（exit=${r.status}）。` };
  spawnSync("pm2", ["save"], { shell: useShell, stdio: "ignore" });
  return {
    ok: true,
    msg:
      `已用 pm2 启动 ${name}。\n` +
      "  开机自启（首次）：执行 `pm2 startup`——Linux/macOS 按提示操作；Windows 用计划任务跑 `pm2 resurrect`。",
  };
}

/** 停止某账号的 daemon（pm2 delete）。 */
export function pm2Stop(key: string): { ok: boolean; msg: string } {
  if (!pm2Available()) return { ok: false, msg: "未检测到 pm2。" };
  const name = `wemind-${key}`;
  const r = spawnSync("pm2", ["delete", name], { shell: useShell, stdio: "ignore" });
  spawnSync("pm2", ["save"], { shell: useShell, stdio: "ignore" });
  return r.status === 0
    ? { ok: true, msg: `已停止 ${name}。` }
    : { ok: false, msg: `${name} 未在运行，或停止失败。` };
}
