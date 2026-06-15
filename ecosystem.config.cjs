// WeMind 跨平台常驻配置（pm2）。
// pm2 同时充当：看门狗（崩溃自动重拉）+ 自启（pm2 startup/save）+ 单实例（按 app 名）+ 进程托管（脱离终端）。
// 三系统通用：Windows / Linux / macOS。用法见 docs/跨平台常驻-pm2.md。
//
// 多账号：读取 ~/.wemind/accounts.json，为每个已登记账号生成一个 app（wemind-<key>）；
// 无注册表时回退到单账号 "default"（数据目录 ~/.wemind/default）。
// 新增账号后重跑 `pm2 start ecosystem.config.cjs && pm2 save` 即可纳入新账号。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DAEMON = path.join(__dirname, "packages", "wechat-daemon", "dist", "index.js");
const ROOT = path.join(os.homedir(), ".wemind");
const REG = path.join(ROOT, "accounts.json");

function accountKeys() {
  try {
    const j = JSON.parse(fs.readFileSync(REG, "utf8"));
    const keys = Object.keys(j.accounts || {});
    if (keys.length) return keys;
  } catch { /* 无注册表/解析失败 → 回退 */ }
  return ["default"];
}

function appFor(key) {
  const dataDir = path.join(ROOT, key);
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch { /* ignore */ }
  return {
    name: `wemind-${key}`,
    script: DAEMON,
    cwd: __dirname,
    env: { WECHAT_ACCOUNT: key },
    // 看门狗：崩溃自动重启，延迟 5s（与原 PowerShell wrapper 一致），限重启次数防风暴
    autorestart: true,
    restart_delay: 5000,
    max_restarts: 50,
    // 日志合并到各账号数据目录的 daemon.log，与现有约定一致
    out_file: path.join(dataDir, "daemon.log"),
    error_file: path.join(dataDir, "daemon.log"),
    merge_logs: true,
    // daemon 是长轮询常驻进程，关闭文件监听重启
    watch: false,
  };
}

module.exports = { apps: accountKeys().map(appFor) };
