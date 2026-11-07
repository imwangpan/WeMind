import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { accountDir } from "@wemind/wechat-ilink-core";
import { LAUNCHD_LABEL_PREFIX, SYSTEMD_UNIT_PREFIX } from "../../shared/mixed-config.js";

/**
 * Linux / macOS 自启安装。
 *
 * 两个平台都**自带 supervisor**，所以这里的单元跑 `wemind daemon`（前台常驻），
 * 而不是 `wemind start`——后者启动后立刻退出，会被判为「服务已退出」并无限重拉；
 * systemd 默认还会连带杀掉它 detached 出去的整条 cgroup。
 *
 * 单元只继承 `WECHAT_ACCOUNT`、`WEMIND_HOME`（如果设置了）和安装时的 `PATH`；
 * 其余环境变量（API key 等）不会从交互 shell 自动带过去，需要用户写进服务配置。
 */

/** 构造 systemd 用户单元内容；纯函数，便于单测。 */
export function buildSystemdUnit(
  key: string,
  nodePath: string,
  cliPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const envLines = [
    `Environment=${quoteUnit(`WECHAT_ACCOUNT=${key}`)}`,
    // 自启按账号 key 寻址；空值会让 core 回退到 <根>/<key>，防止从用户管理器继承来的旧变量把目录带偏。
    "Environment=WECHAT_DATA_DIR=",
  ];
  // 自定义根目录必须带进服务环境，否则 daemon 会回到默认的 ~/.wemind。
  const home = env.WEMIND_HOME?.trim();
  if (home) envLines.push(`Environment=${quoteUnit(`WEMIND_HOME=${home}`)}`);
  // 把安装时的 PATH 带进单元：daemon 需要能找到 agent 可执行文件（fnm/nvm/Volta 装的都在用户 PATH 里）。
  if (env.PATH) envLines.push(`Environment=${quoteUnit(`PATH=${env.PATH}`)}`);

  return `[Unit]
Description=WeMind daemon (${key})
After=network.target

[Service]
Type=simple
${envLines.join("\n")}
ExecStart=${quoteUnit(nodePath)} ${quoteUnit(cliPath)} daemon
Restart=always
RestartSec=5
# 退出码 75（同账号已有实例）/ 78（大脑配置错误）重拉无益，与 builtin / pm2 口径一致
RestartPreventExitStatus=75 78

[Install]
WantedBy=default.target
`;
}

/** Linux：为单个账号写 systemd 用户单元并启用。 */
export function installSystemdUnit(key: string, nodePath: string, cliPath: string): void {
  const dir = path.join(os.homedir(), ".config", "systemd", "user");
  const unitName = `${SYSTEMD_UNIT_PREFIX}@${key}.service`;
  const unitPath = path.join(dir, unitName);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(unitPath, buildSystemdUnit(key, nodePath, cliPath), "utf-8");

  // 任何一步失败都要报错；否则服务没启用/没起来，命令却打印「已安装并启动」。
  runSystemctl(["daemon-reload"]);
  runSystemctl(["enable", unitName]);
  runSystemctl(["restart", unitName]);
  console.log(`已安装并启动 systemd 用户单元：${unitName}`);

  // 非图形会话下用户级服务会在登出后停止；提示一次 enable-linger
  const linger = runCapture("loginctl", ["show-user", os.userInfo().username, "--property=Linger"]);
  if (!linger.includes("Linger=yes")) {
    console.warn(
      "提示：要让服务在登出后继续运行，请执行一次：loginctl enable-linger " +
        os.userInfo().username,
    );
  }
}

/** 构造 macOS LaunchAgent plist 内容；纯函数，便于单测。 */
export function buildLaunchAgentPlist(
  key: string,
  nodePath: string,
  cliPath: string,
  logPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const label = `${LAUNCHD_LABEL_PREFIX}.${key}`;
  const envEntries = [
    `    <key>WECHAT_ACCOUNT</key>\n    <string>${escapeXml(key)}</string>`,
    // 空值让 core 回退到 <根>/<key>；显式覆盖用户会话里可能残留的 WECHAT_DATA_DIR。
    "    <key>WECHAT_DATA_DIR</key>\n    <string></string>",
  ];
  const home = env.WEMIND_HOME?.trim();
  if (home) {
    envEntries.push(`    <key>WEMIND_HOME</key>\n    <string>${escapeXml(home)}</string>`);
  }
  if (env.PATH) {
    envEntries.push(`    <key>PATH</key>\n    <string>${escapeXml(env.PATH)}</string>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(cliPath)}</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries.join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

/** macOS：为单个账号写 LaunchAgent plist 并加载。 */
export function installLaunchAgent(key: string, nodePath: string, cliPath: string): void {
  const dir = path.join(os.homedir(), "Library", "LaunchAgents");
  const label = `${LAUNCHD_LABEL_PREFIX}.${key}`;
  const plistPath = path.join(dir, `${label}.plist`);
  const logPath = path.join(accountDir(key), "daemon.log");

  fs.mkdirSync(dir, { recursive: true });
  // launchd 打开日志文件前，账号目录必须已经存在。
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  // 覆盖前先卸载旧定义（不存在会失败，忽略）。
  try {
    execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore", timeout: 15_000 });
  } catch {
    /* 未加载 */
  }
  fs.writeFileSync(plistPath, buildLaunchAgentPlist(key, nodePath, cliPath, logPath), "utf-8");
  execFileSync("launchctl", ["load", plistPath], { stdio: "pipe", timeout: 15_000 });
  console.log(`已安装并加载 LaunchAgent：${label}`);
}

/** systemd 单元值转义：含空白、引号或反斜杠的值要用双引号包起来。 */
function quoteUnit(value: string): string {
  return /[\s"\\]/.test(value) ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value;
}

/** 执行必须成功的 systemctl 步骤；失败时把 stderr 带进错误，避免静默安装成功。 */
function runSystemctl(args: string[]): void {
  try {
    execFileSync("systemctl", ["--user", ...args], { stdio: "pipe", timeout: 15_000 });
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const detail =
      (err.stderr ? String(err.stderr) : err.stdout ? String(err.stdout) : err.message)?.trim() ??
      "";
    throw new Error(
      `systemctl --user ${args.join(" ")} 失败${detail ? `：${detail}` : ""}。` +
        "请确认当前会话能使用 systemd 用户服务（systemctl --user status）。",
    );
  }
}

function runCapture(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 10_000 });
  } catch {
    return "";
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
