#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import {
  WEMIND_ROOT,
  accountDir,
  deriveAccountKey,
  listAccounts,
  registerAccount,
  unregisterAccount,
  setLabel,
  getDefaultKey,
  setDefaultKey,
  fetchQRCode,
  pollQRStatus,
  saveQrState,
  clearSessionPause,
  notifyStart,
  notifyStop,
  addAllowFrom,
  removeAllowFrom,
  readAllowFrom,
  type AccountData,
} from "@wemind/wechat-ilink-core";
import { pm2Start, pm2Stop } from "./pm2-runner.js";
import { watchdogStart } from "./watchdog-runner.js";

/**
 * WeMind 多账号管理 CLI。
 * 账号 key = 由微信 botId 派生的唯一标识；每个账号独立目录 ~/.wemind/<key>。
 * label = 人类可读别名（可改、可重复）；管理命令可用 key 或 label 选择账号。
 * 推荐用 `login` 一条命令完成：自刷新二维码 → 扫码 → 自动归档（→ 可选自动启动）。
 */

const BASE = process.env.WEMIND_ILINK_BASE?.trim() || "https://ilinkai.weixin.qq.com";
const STAGING = path.join(WEMIND_ROOT, ".staging");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readAccount(dir: string): AccountData | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "account.json"), "utf-8")) as AccountData;
  } catch {
    return null;
  }
}
function readPid(dir: string, name: string): number | null {
  try {
    const n = parseInt(fs.readFileSync(path.join(dir, name), "utf-8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function killPid(pid: number): void {
  if (process.platform === "win32")
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(pid);
    } catch {
      /* ignore */
    }
  }
}
function openFile(p: string): void {
  try {
    if (process.platform === "win32")
      spawn("cmd", ["/c", "start", "", p], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    else
      spawn(process.platform === "darwin" ? "open" : "xdg-open", [p], {
        detached: true,
        stdio: "ignore",
      }).unref();
  } catch {
    /* ignore */
  }
}

/** key 或 label → key（label 唯一匹配才行）。 */
function resolveKey(arg: string): string {
  if (!arg) throw new Error("需要 <key 或 label>");
  const accs = listAccounts();
  if (accs.some((a) => a.key === arg)) return arg;
  const byLabel = accs.filter((a) => a.label === arg);
  if (byLabel.length === 1) return byLabel[0].key;
  if (byLabel.length > 1)
    throw new Error(
      `label「${arg}」对应多个账号，请改用 key：${byLabel.map((a) => a.key).join(", ")}`,
    );
  throw new Error(`未找到账号：${arg}（既不是 key 也不是 label）`);
}

/** 启动某账号的 daemon（方案 a：委托 pm2 常驻，跑 `wemind daemon`，注入 WECHAT_ACCOUNT）。 */
function startDaemon(key: string, runner?: string): void {
  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  // start 前先停现有任何 runner（pm2 app / builtin 看门狗），避免同账号双跑抢 token
  stopDaemon(key);
  const useRunner = (runner || process.env.WEMIND_RUNNER || "builtin").toLowerCase();
  console.log((useRunner === "pm2" ? pm2Start(key, cliPath) : watchdogStart(key, cliPath)).msg);
}

/** 停止某账号的常驻：先 pm2 delete（方案 a），再按 pid 兜底杀 wrapper/daemon/brain（兼容直接启动的）。 */
function stopDaemon(key: string): string {
  pm2Stop(key); // best-effort：停掉 pm2 托管的 app（若有）
  const dir = accountDir(key);
  const wpid = readPid(dir, "wrapper.pid");
  const dpid = readPid(dir, "daemon.pid");
  const bpid = readPid(dir, "brain.pid");
  const stopped: string[] = [];
  if (wpid && alive(wpid)) {
    killPid(wpid);
    stopped.push(`wrapper ${wpid}`);
  }
  if (dpid && alive(dpid)) {
    killPid(dpid);
    stopped.push(`daemon ${dpid}`);
  }
  if (bpid && alive(bpid)) {
    killPid(bpid);
    stopped.push(`brain ${bpid}`);
  }
  for (const f of ["wrapper.pid", "daemon.pid", "brain.pid"]) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* ignore */
    }
  }
  return stopped.length ? `已停止 ${stopped.join(" + ")}` : "无运行中的进程";
}

/** 把 STAGING 的登录按 botId 归档 + 登记。 */
function finalizeStaging(label?: string): { key: string; msg: string } {
  const acc = readAccount(STAGING);
  if (!acc?.botId) throw new Error(`staging 无有效登录（${STAGING}）`);
  const key = deriveAccountKey(acc.botId);
  const dest = accountDir(key);
  if (fs.existsSync(dest)) {
    fs.rmSync(STAGING, { recursive: true, force: true });
    throw new Error(`账号目录已存在: ${dest}（该微信号此前已登录过；如需重登请先 delete ${key}）`);
  }
  fs.renameSync(STAGING, dest);
  for (const f of [
    "qrcode.png",
    "qrcode.txt",
    "qr_login.json",
    "poll.out",
    "poll.err",
    "auto.out",
    "auto.err",
  ]) {
    try {
      fs.unlinkSync(path.join(dest, f));
    } catch {
      /* ignore */
    }
  }
  const meta = registerAccount({
    key,
    botId: acc.botId,
    userId: acc.userId,
    baseUrl: acc.baseUrl,
    label: label || key,
  });
  if (acc.userId) addAllowFrom(acc.userId, dest); // 配对：扫码登录者自动授权
  return { key, msg: `已归档：key=${key}  label=${meta.label}  botId=${acc.botId}\n目录：${dest}` };
}

/** 一条命令完成扫码登录：自刷新二维码 + 终端码 + 自动开图 + 自动归档（→ 可选自动启动）。 */
async function cmdLogin(
  label: string | undefined,
  autoStart: boolean,
  runner?: string,
): Promise<void> {
  fs.rmSync(STAGING, { recursive: true, force: true });
  fs.mkdirSync(STAGING, { recursive: true });
  const png = path.join(STAGING, "qrcode.png");
  const overall = Date.now() + 15 * 60 * 1000;
  let code = "";
  let opened = false;

  const refresh = async (): Promise<void> => {
    const qr = await fetchQRCode(BASE);
    code = qr.qrcode;
    saveQrState({ qrcode: qr.qrcode, qrcodeUrl: qr.qrcode_img_content, createdAt: Date.now() });
    await QRCode.toFile(png, qr.qrcode_img_content, { width: 480, margin: 2 });
    const term = await QRCode.toString(qr.qrcode_img_content, { type: "terminal", small: true });
    console.log("\n用要登录的微信扫下面的二维码（过期会自动刷新）：\n");
    console.log(term);
    console.log("图片(已自动打开): " + png);
    console.log("链接: " + qr.qrcode_img_content + "\n");
    if (!opened) {
      openFile(png);
      opened = true;
    }
  };

  await refresh();
  console.log("等待扫码确认…（最多 15 分钟，Ctrl+C 取消）");
  while (Date.now() < overall) {
    let s;
    try {
      s = await pollQRStatus(BASE, code);
    } catch {
      await sleep(2000);
      continue;
    }
    if (s.status === "confirmed") {
      if (!s.bot_token || !s.ilink_bot_id || !s.ilink_user_id)
        throw new Error("confirmed 但数据不全");
      fs.writeFileSync(
        path.join(STAGING, "account.json"),
        JSON.stringify(
          {
            botToken: s.bot_token,
            botId: s.ilink_bot_id,
            userId: s.ilink_user_id,
            baseUrl: s.baseurl ?? BASE,
            savedAt: Date.now(),
          },
          null,
          2,
        ),
        "utf-8",
      );
      clearSessionPause(s.ilink_bot_id);
      await notifyStart({ baseUrl: s.baseurl ?? BASE, token: s.bot_token }).catch(() => {});
      for (const f of ["qrcode.png", "qr_login.json"]) {
        try {
          fs.unlinkSync(path.join(STAGING, f));
        } catch {
          /* ignore */
        }
      }
      console.log("\n登录成功，归档中…");
      const { key, msg } = finalizeStaging(label);
      console.log(msg);
      if (autoStart) {
        startDaemon(key, runner);
        console.log(`已启动 daemon（账号 ${key}）。`);
      } else {
        console.log(`启动：wemind start ${key}`);
      }
      return;
    }
    if (s.status === "expired") {
      console.log("二维码过期，自动刷新…");
      await refresh();
      continue;
    }
    await sleep(1500);
  }
  throw new Error("超时（15 分钟）未完成登录");
}

function cmdList(): string {
  const def = getDefaultKey();
  const accs = listAccounts();
  if (!accs.length) return "（无已登记账号）。用 `login` 添加。";
  return accs
    .map((a) => {
      const dpid = readPid(accountDir(a.key), "daemon.pid");
      const bpid = readPid(accountDir(a.key), "brain.pid");
      const running = dpid && alive(dpid) ? `运行中(pid ${dpid})` : "已停止";
      const brain = bpid && alive(bpid) ? `  brain(pid ${bpid})` : "";
      return `- ${a.key}${a.key === def ? " [默认]" : ""}  label=${a.label}  botId=${a.botId}  ${running}${brain}`;
    })
    .join("\n");
}

function cmdAdopt(key: string, label?: string): string {
  if (!key) throw new Error("用法: adopt <key> [--label 名]");
  const acc = readAccount(accountDir(key));
  if (!acc?.botId) throw new Error(`${accountDir(key)} 无有效 account.json`);
  const meta = registerAccount({
    key,
    botId: acc.botId,
    userId: acc.userId,
    baseUrl: acc.baseUrl,
    label: label || key,
  });
  if (acc.userId) addAllowFrom(acc.userId, accountDir(key)); // 接管时把账号本人种入授权清单
  return `已登记：key=${key}  label=${meta.label}  botId=${acc.botId}`;
}

async function cmdLogout(sel: string): Promise<string> {
  const key = resolveKey(sel);
  const dir = accountDir(key);
  const acc = readAccount(dir);
  const stopMsg = stopDaemon(key);
  if (acc?.botToken) {
    try {
      await notifyStop({ baseUrl: acc.baseUrl, token: acc.botToken });
    } catch {
      /* ignore */
    }
  }
  for (const f of ["account.json", "state.json", "qr_login.json", "qrcode.png", "qrcode.txt"]) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* ignore */
    }
  }
  return `账号 ${key} 已登出（${stopMsg}）。目录与会话保留，可重新登录。`;
}

function cmdDelete(sel: string): string {
  const key = resolveKey(sel);
  const stopMsg = stopDaemon(key);
  try {
    fs.rmSync(accountDir(key), { recursive: true, force: true });
  } catch (e) {
    throw new Error(`删除目录失败: ${String(e)}`);
  }
  unregisterAccount(key);
  return `账号 ${key} 已删除（${stopMsg}，已移除目录与注册）。`;
}

function cmdStart(sel: string, runner?: string): string {
  const key = resolveKey(sel);
  startDaemon(key, runner);
  return `已启动 daemon（账号 ${key}）。用 list 查看运行状态。`;
}

// ===== 本地任务命令（文件桥）：写 task-inbox/*.json，由 daemon 扫描执行；状态读 task-state.json =====
function taskInboxDir(key: string): string {
  return path.join(accountDir(key), "task-inbox");
}
/** 原子写一个命令文件到收件箱（临时文件 + rename，避免 daemon 读到半截）。 */
function writeTaskCmd(key: string, obj: Record<string, unknown>): void {
  const dir = taskInboxDir(key);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...obj, ts: Date.now() }, null, 2), "utf-8");
  fs.renameSync(tmp, fp);
}
/** 选账号：显式 key/label 优先，否则用默认账号。 */
function pickKey(sel?: string): string {
  if (sel) return resolveKey(sel);
  const d = getDefaultKey();
  if (!d) throw new Error("无默认账号，请指定 <key|label> 或先 login");
  return d;
}
/** 预检 daemon 存活（本地命令需 daemon 在跑才有人消费收件箱）。 */
function requireDaemonAlive(key: string): void {
  const pid = readPid(accountDir(key), "daemon.pid");
  if (!pid || !alive(pid))
    throw new Error(
      `账号 ${key} 的 daemon 未运行。先启动：node packages/wechat-daemon/dist/manage.js start ${key}`,
    );
}

async function cmdTask(text: string, cwd: string | undefined, sel?: string): Promise<string> {
  if (!text) throw new Error('用法: task "<任务描述>" [--cwd 目录] [<key|label>]');
  const key = pickKey(sel);
  requireDaemonAlive(key);
  const useCwd = cwd || process.cwd();
  writeTaskCmd(key, { kind: "dispatch", text, cwd: useCwd });
  // 短轮询 task-state.json 确认已派发（最多 ~3s）
  const stateFile = path.join(accountDir(key), "task-state.json");
  for (let i = 0; i < 15; i++) {
    await sleep(200);
    try {
      if (JSON.parse(fs.readFileSync(stateFile, "utf-8")).active)
        return `已派发任务（worker 运行中，cwd=${useCwd}）。\n用 task-status 看进展、task-reply 回复、task-stop 结束。`;
    } catch {
      /* ignore */
    }
  }
  return `已投递任务（cwd=${useCwd}）。daemon 处理中，用 task-status 查看。`;
}
function cmdTaskReply(text: string, sel?: string): string {
  if (!text) throw new Error('用法: task-reply "<内容>" [<key|label>]');
  const key = pickKey(sel);
  requireDaemonAlive(key);
  writeTaskCmd(key, { kind: "reply", text });
  return `已发送给任务：${text.slice(0, 40)}`;
}
function cmdTaskStop(sel?: string): string {
  const key = pickKey(sel);
  requireDaemonAlive(key);
  writeTaskCmd(key, { kind: "stop" });
  return "已发送「结束任务」指令。";
}
function cmdTaskStatus(sel?: string): string {
  const key = pickKey(sel);
  const stateFile = path.join(accountDir(key), "task-state.json");
  let s: {
    active?: boolean;
    status?: string;
    turns?: number;
    startedAt?: number;
    lastOutput?: string;
  };
  try {
    s = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  } catch {
    return `账号 ${key}：无任务状态（task-state.json 不存在，daemon 可能未跑过任务）。`;
  }
  if (!s.active) return `账号 ${key}：当前无活跃任务（idle）。`;
  const since = s.startedAt ? `${Math.round((Date.now() - s.startedAt) / 1000)}s` : "?";
  return [
    `账号 ${key} 任务状态：`,
    `  状态：${s.status}  轮次：${s.turns ?? 0}  已运行：${since}`,
    `  最近输出：${s.lastOutput ? s.lastOutput.slice(0, 300) : "（无）"}`,
  ].join("\n");
}

export async function runManage(argv: string[]): Promise<void> {
  const cmd = argv.shift();
  const rest = [...argv];
  const li = rest.indexOf("--label");
  let label: string | undefined;
  if (li >= 0) {
    label = rest[li + 1];
    rest.splice(li, 2);
  }
  const si = rest.indexOf("--start");
  const autoStart = si >= 0;
  if (autoStart) rest.splice(si, 1);
  const ci = rest.indexOf("--cwd");
  let cwd: string | undefined;
  if (ci >= 0) {
    cwd = rest[ci + 1];
    rest.splice(ci, 2);
  }
  const ri = rest.indexOf("--runner");
  let runner: string | undefined;
  if (ri >= 0) {
    runner = rest[ri + 1];
    rest.splice(ri, 2);
  }

  switch (cmd) {
    case "login":
      await cmdLogin(label, autoStart, runner);
      break;
    case "list":
      console.log(cmdList());
      break;
    case "adopt":
      console.log(cmdAdopt(rest[0], label));
      break;
    case "start":
      console.log(cmdStart(rest[0], runner));
      break;
    case "stop": {
      const k = resolveKey(rest[0]);
      console.log(stopDaemon(k));
      break;
    }
    case "task":
      console.log(await cmdTask(rest[0], cwd, rest[1]));
      break;
    case "task-reply":
      console.log(cmdTaskReply(rest[0], rest[1]));
      break;
    case "task-status":
      console.log(cmdTaskStatus(rest[0]));
      break;
    case "task-stop":
      console.log(cmdTaskStop(rest[0]));
      break;
    case "label": {
      const k = resolveKey(rest[0]);
      setLabel(k, rest.slice(1).join(" "));
      console.log(`已设置 ${k} 的别名为「${rest.slice(1).join(" ")}」`);
      break;
    }
    case "set-default": {
      const k = resolveKey(rest[0]);
      setDefaultKey(k);
      console.log(`默认账号 = ${k}`);
      break;
    }
    case "logout":
      console.log(await cmdLogout(rest[0]));
      break;
    case "delete":
      console.log(cmdDelete(rest[0]));
      break;
    case "finalize": {
      const { msg } = finalizeStaging(label);
      console.log(msg);
      break;
    } // 兼容旧流程（staging 已有登录时归档）
    case "allow": {
      const k = resolveKey(rest[0]);
      const uid = rest[1];
      if (!uid) throw new Error("用法: allow <key|label> <userId>");
      const list = addAllowFrom(uid, accountDir(k));
      console.log(`已授权 ${uid} → ${k}\n当前清单(${list.length})：${list.join(", ")}`);
      break;
    }
    case "revoke": {
      const k = resolveKey(rest[0]);
      const uid = rest[1];
      if (!uid) throw new Error("用法: revoke <key|label> <userId>");
      const list = removeAllowFrom(uid, accountDir(k));
      console.log(`已撤销 ${uid} → ${k}\n当前清单(${list.length})：${list.join(", ") || "（空）"}`);
      break;
    }
    case "allowlist": {
      const k = resolveKey(rest[0]);
      const list = readAllowFrom(accountDir(k));
      console.log(
        `${k} 授权用户(${list.length})：\n${list.map((u) => "  - " + u).join("\n") || "  （空）"}`,
      );
      break;
    }
    default:
      console.log(`WeMind 多账号管理
用法: node packages/wechat-daemon/dist/manage.js <command>

  login [--label 名] [--start]   一条命令完成扫码登录：自刷新二维码 + 自动归档（--start 顺带启动 daemon）
  list                           列出账号、别名、运行状态
  start <key|label>              启动某账号的 daemon
  task "<描述>" [--cwd 目录] [<key|label>]   本地派发任务给 worker（默认 cwd=当前终端目录）
  task-reply "<内容>" [<key|label>]          回复/注入当前任务（「task-reply 继续」= 续跑）
  task-status [<key|label>]                  查看当前任务状态与最近输出
  task-stop [<key|label>]                    结束当前任务
  logout <key|label>             停 daemon + 通知下线 + 清凭证（保留目录，可重登）
  delete <key|label>             停 daemon + 删除目录 + 移除注册
  label <key|label> <新别名>     改别名
  set-default <key|label>        设默认账号
  adopt <key> [--label 名]       把已存在的账号目录登记进注册表
  allowlist <key|label>          查看该账号的授权用户清单(allowFrom)
  allow <key|label> <userId>     授权某用户可驱动该账号 bot
  revoke <key|label> <userId>    撤销某用户的授权

说明：key = 由微信 botId 派生的唯一标识（目录名）；label = 人类可读别名。多数命令可用 key 或 label。`);
  }
}
// 入口由 cli.ts 调用 runManage(argv)；此处不再顶层自启。
