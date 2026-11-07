import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 构造启动器子进程的环境变量（P0 修复点：`wemind start <key>` 不得继承父进程的 `WECHAT_DATA_DIR`）。
 *
 * 规则：
 * 1. 保留 `WEMIND_HOME`——它是根目录，与 `accountDir()` 的解析口径一致，继承是对的。
 * 2. 保留其余变量（`DEEPSEEK_API_KEY`、`WEMIND_RUNNER` 等需要透传给 daemon）。
 * 3. **强制丢弃** `WECHAT_DATA_DIR`——`start` 是按账号 key 寻址的管理命令，必须落在 `<根>/<key>`；
 *    否则会出现「报告已启动、实际没起/起错账号/停不掉」三种静默失败。
 * 4. 检测到该变量且指向的不是预期目录时，向 stderr 打一条迁移指引（此时账号目录尚未解析出来，不能写 `daemon.log`）。
 * 5. 强制覆盖 `WECHAT_ACCOUNT`，确保后台进程与传入 key 一致。
 *
 * 注意：`wemind daemon` 直跑**不经过**本函数，`WECHAT_DATA_DIR` 对它的单进程覆盖语义保持不变。
 */
export function launcherEnv(
  key: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...parentEnv };

  // 只要父进程**设过**这个变量就丢掉（空串也丢）：留着空串没有意义，也容易让人误以为它仍生效。
  const hasDataDir = Object.prototype.hasOwnProperty.call(env, "WECHAT_DATA_DIR");
  const oldDataDir = env.WECHAT_DATA_DIR?.trim();
  if (oldDataDir) {
    const homeDir = env.WEMIND_HOME?.trim() || path.join(os.homedir(), ".wemind");
    const expectedDir = path.join(homeDir, key);

    if (!samePath(oldDataDir, expectedDir)) {
      const isWin = process.platform === "win32";
      process.stderr.write(migrationHint(key, oldDataDir, expectedDir, isWin));
    }
  }
  // 拷贝一份再 delete：不要用 { ...env, WECHAT_DATA_DIR: undefined }——spawn 的 env 里给 undefined 行为不保证。
  if (hasDataDir) delete env.WECHAT_DATA_DIR;

  env.WECHAT_ACCOUNT = key;
  return env;
}

/**
 * 启动器要记录/传给子进程的可执行文件路径必须稳定。
 *
 * fnm 的 `fnm_multishells` 是每个 shell 临时创建的联接目录，记录 `process.execPath` 会在
 * 该 shell 退出或重启后指向不存在的路径；`realpathSync` 会解析到真实安装位置。
 * 解析失败（路径已被删除等）时原样返回，交给启动阶段报错，不在这里静默换成别的路径。
 */
export function stableExecPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Windows 路径大小写不敏感，且用户可能写尾斜杠；统一 resolve 后比较。 */
function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function migrationHint(
  key: string,
  oldDataDir: string,
  expectedDir: string,
  isWin: boolean,
): string {
  const migrate = isWin
    ? `     xcopy /y /e "${oldDataDir}\\*.*" "${expectedDir}\\"`
    : `     mv "${oldDataDir}"/* "${expectedDir}/"`;
  const clear = isWin
    ? `     [System.Environment]::SetEnvironmentVariable("WECHAT_DATA_DIR", "", "User")`
    : `     echo 'unset WECHAT_DATA_DIR' >> ~/.bashrc && unset WECHAT_DATA_DIR`;

  return (
    `[注意] 检测到环境变量 WECHAT_DATA_DIR=${oldDataDir}，它会让 wemind start 指向错误的目录。\n\n` +
    `原因：wemind start 按账号 key 寻址，数据目录固定为 <根目录>/<key>，不能由该变量覆盖。\n\n` +
    `本次已修正：账号 ${key} 使用目录 ${expectedDir}\n` +
    `你的旧数据仍在：${oldDataDir}\n\n` +
    `处理方式（选其一）：\n` +
    `  1) 迁移旧数据到新目录：\n${migrate}\n` +
    `  2) 清除环境变量（不再需要它）：\n${clear}\n`
  );
}
