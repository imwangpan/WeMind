#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  WEMIND_ROOT, accountDir, deriveAccountKey,
  listAccounts, registerAccount, unregisterAccount, setLabel, getDefaultKey, setDefaultKey,
  notifyStop,
  type AccountData,
} from "@wemind/wechat-ilink-core";

/**
 * WeMind 多账号管理 CLI。
 * 账号 key = 由微信 botId 派生的唯一标识；每个账号独立目录 ~/.wemind/<key>。
 * 登录走「staging → finalize」：先用 WECHAT_DATA_DIR=<staging> 扫码登录，再 finalize 按 botId 归档。
 */

const STAGING = path.join(WEMIND_ROOT, ".staging");

function readAccount(dir: string): AccountData | null {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "account.json"), "utf-8")) as AccountData; }
  catch { return null; }
}
function readPid(dir: string, name: string): number | null {
  try { const n = parseInt(fs.readFileSync(path.join(dir, name), "utf-8").trim(), 10); return Number.isFinite(n) ? n : null; }
  catch { return null; }
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function killPid(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else { try { process.kill(pid); } catch { /* ignore */ } }
}

/** 停止某账号的 wrapper(先，避免自重启)与 daemon。 */
function stopDaemon(key: string): string {
  const dir = accountDir(key);
  const wpid = readPid(dir, "wrapper.pid");
  const dpid = readPid(dir, "daemon.pid");
  const bpid = readPid(dir, "brain.pid");
  const stopped: string[] = [];
  if (wpid && alive(wpid)) { killPid(wpid); stopped.push(`wrapper ${wpid}`); }
  if (dpid && alive(dpid)) { killPid(dpid); stopped.push(`daemon ${dpid}`); }
  if (bpid && alive(bpid)) { killPid(bpid); stopped.push(`brain ${bpid}`); }
  for (const f of ["wrapper.pid", "daemon.pid", "brain.pid"]) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
  return stopped.length ? `已停止 ${stopped.join(" + ")}` : "无运行中的进程";
}

async function cmdFinalize(label?: string): Promise<string> {
  const acc = readAccount(STAGING);
  if (!acc?.botId) throw new Error(`staging 无有效登录（${STAGING}）。请先用 WECHAT_DATA_DIR="${STAGING}" 跑 MCP server 完成扫码登录。`);
  const key = deriveAccountKey(acc.botId);
  const dest = accountDir(key);
  if (fs.existsSync(dest)) {
    fs.rmSync(STAGING, { recursive: true, force: true });
    throw new Error(`账号目录已存在: ${dest}（该微信号此前已登录过）。已清理 staging。`);
  }
  fs.renameSync(STAGING, dest);
  const meta = registerAccount({ key, botId: acc.botId, userId: acc.userId, baseUrl: acc.baseUrl, label: label || key });
  return `已登录并归档：key=${key}  label=${meta.label}  botId=${acc.botId}\n目录：${dest}\n启动：设 WECHAT_ACCOUNT=${key} 跑 daemon（或用 run-all-daemons.ps1）。`;
}

function cmdAdopt(key: string, label?: string): string {
  if (!key) throw new Error("用法: adopt <key> [--label 名]");
  const acc = readAccount(accountDir(key));
  if (!acc?.botId) throw new Error(`${accountDir(key)} 无有效 account.json`);
  const meta = registerAccount({ key, botId: acc.botId, userId: acc.userId, baseUrl: acc.baseUrl, label: label || key });
  return `已登记：key=${key}  label=${meta.label}  botId=${acc.botId}`;
}

function cmdList(): string {
  const def = getDefaultKey();
  const accs = listAccounts();
  if (!accs.length) return "（无已登记账号）。用 finalize / adopt 添加。";
  return accs.map((a) => {
    const dpid = readPid(accountDir(a.key), "daemon.pid");
    const bpid = readPid(accountDir(a.key), "brain.pid");
    const running = dpid && alive(dpid) ? `运行中(pid ${dpid})` : "已停止";
    const brain = bpid && alive(bpid) ? `  brain(pid ${bpid})` : "";
    return `- ${a.key}${a.key === def ? " [默认]" : ""}  label=${a.label}  botId=${a.botId}  ${running}${brain}`;
  }).join("\n");
}

async function cmdLogout(key: string): Promise<string> {
  if (!key) throw new Error("用法: logout <key>");
  const dir = accountDir(key);
  const acc = readAccount(dir);
  const stopMsg = stopDaemon(key);
  if (acc?.botToken) { try { await notifyStop({ baseUrl: acc.baseUrl, token: acc.botToken }); } catch { /* ignore */ } }
  for (const f of ["account.json", "state.json", "qr_login.json", "qrcode.png", "qrcode.txt"]) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
  }
  return `账号 ${key} 已登出（${stopMsg}）。目录与会话保留，可重新登录。`;
}

function cmdDelete(key: string): string {
  if (!key) throw new Error("用法: delete <key>");
  const stopMsg = stopDaemon(key);
  try { fs.rmSync(accountDir(key), { recursive: true, force: true }); }
  catch (e) { throw new Error(`删除目录失败: ${String(e)}`); }
  unregisterAccount(key);
  return `账号 ${key} 已删除（${stopMsg}，已移除目录与注册）。`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  const rest = [...argv];
  const li = rest.indexOf("--label");
  let label: string | undefined;
  if (li >= 0) { label = rest[li + 1]; rest.splice(li, 2); }

  switch (cmd) {
    case "list": console.log(cmdList()); break;
    case "finalize": console.log(await cmdFinalize(label)); break;
    case "adopt": console.log(cmdAdopt(rest[0], label)); break;
    case "label": setLabel(rest[0], rest.slice(1).join(" ")); console.log(`已设置 ${rest[0]} 的别名为「${rest.slice(1).join(" ")}」`); break;
    case "set-default": setDefaultKey(rest[0]); console.log(`默认账号 = ${rest[0]}`); break;
    case "logout": console.log(await cmdLogout(rest[0])); break;
    case "delete": console.log(cmdDelete(rest[0])); break;
    default:
      console.log(`WeMind 多账号管理
用法: node packages/wechat-daemon/dist/manage.js <command>

  list                      列出账号及运行状态
  finalize [--label 名]     把 .staging 的登录按 botId 归档为新账号
  adopt <key> [--label 名]  把已存在的账号目录登记进注册表
  label <key> <文本>        设置人类可读别名
  set-default <key>         设默认账号
  logout <key>              停 daemon + 通知下线 + 清凭证(保留目录，可重登)
  delete <key>              停 daemon + 删除目录 + 移除注册`);
  }
}
main().catch((e) => { console.error("error:", e?.message ?? e); process.exit(1); });
