import fs from "node:fs";
import path from "node:path";

import {
  accountDir,
  getDefaultKey,
  listAccounts,
  loadAccount as readAccount,
} from "@wemind/wechat-ilink-core";
import { CLI_PID_MARKERS, isOurProcess } from "./shared/process/proc-identity.js";
import {
  awaitControlResponse,
  bridgePidOf,
  controlTimeoutMs,
  newRequestId,
  writeControlRequest,
  type ControlKind,
  type ControlRequest,
} from "./control-bridge.js";
import { resolveAgent } from "./agents/brain-agents.js";
import { loadBrainConfig } from "./agents/brain-config.js";

/** 读裸 pid 文件（daemon.pid / wrapper.pid / brain.pid）；不存在/坏内容 → null。 */
export function readPid(dir: string, name: string): number | null {
  try {
    const n = parseInt(fs.readFileSync(path.join(dir, name), "utf-8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * 该 pid 是否「活着**且确实是我们自己的** CLI 进程」。
 * 只判存活不够：pid 会复用（尤其重启后），陈旧 pid 文件可能指向**别人的**进程 → 会误杀/误判。
 */
export function aliveOurs(pid: number | null, markers: string[][] = CLI_PID_MARKERS): boolean {
  return isOurProcess(pid, markers);
}

/** key 或 label → key（label 唯一匹配才行）。 */
export function resolveKey(arg: string): string {
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

/**
 * 选账号：显式 key/label 优先，否则用默认账号（`accounts.json` 的 `default`；缺失时回落第一个登记的账号，见 core 的 `getDefaultKey`）。
 * `session`/`task*` 早就是这个口径；`start`/`stop` 也走这里——所以「省略账号」= 默认账号。
 */
export function pickKey(sel?: string): string {
  if (sel) return resolveKey(sel);
  const d = getDefaultKey();
  if (!d) throw new Error("无默认账号，请指定 <key|label> 或先 login");
  return d;
}

/** 预检 daemon 存活（本地命令需 daemon 在跑才有人消费收件箱）。 */
export function requireDaemonAlive(key: string): void {
  const pid = readPid(accountDir(key), "daemon.pid");
  if (!aliveOurs(pid))
    throw new Error(
      `账号 ${key} 的 daemon 未运行。先启动：wemind start ${key}（用 wemind list 查看状态）`,
    );
}

/** daemon 是否活着（且确实是我们自己的进程）。读命令不需要它，写命令优先走它。 */
export function daemonAlive(key: string): boolean {
  return aliveOurs(readPid(accountDir(key), "daemon.pid"));
}

/**
 * daemon 活着**且认识控制桥**（升级 CLI 后没重启的旧 daemon 在这里判为不可用）。
 * 决定「走桥还是走文件」都该问这个而不是 daemonAlive：对旧 daemon 发送只会白等到超时。
 */
export function bridgeReady(key: string): boolean {
  const dir = accountDir(key);
  return daemonAlive(key) && bridgePidOf(dir) === readPid(dir, "daemon.pid");
}

/**
 * 经控制桥让 daemon 执行一条命令并等回话。
 * 超时**如实**报「没等到回复」——桥的价值就在于「CLI 说的」和「daemon 做的」是同一件事，绝不假装成功。
 */
export async function viaBridge(
  key: string,
  req: Omit<ControlRequest, "id" | "at">,
): Promise<string> {
  const dir = accountDir(key);
  // 先验「在跑的这个 daemon 认不认识桥」：升级 CLI 后 daemon 常常还在跑旧版本，径直发送只会干等到超时。
  // 凭据是 daemon 启动时写的 control-out/.bridge（内容 = 它自己的 pid）——pid 对上才算数。
  const dpid = readPid(dir, "daemon.pid");
  if (bridgePidOf(dir) !== dpid)
    throw new Error(
      `账号 ${key} 的 daemon 还在跑**旧版本**（不认识控制桥），换大脑/会话命令发送过去只会白等超时。\n` +
        `重启一次即可：wemind stop ${key} && wemind start ${key}\n` +
        `（只想改配置不动进程：wemind brain set <agent 名>，但它要等下次启动才生效。）`,
    );
  const timeoutMs = controlTimeoutMs(req.kind as ControlKind);
  const now = Date.now();
  // 带上截止时间：CLI 放弃后 daemon 不再执行（否则「CLI 说超时、daemon 照做」两边说法相反）。
  const full: ControlRequest = {
    id: newRequestId(now),
    at: now,
    ...req,
    expiresAt: now + timeoutMs,
  };
  writeControlRequest(full, dir);
  const res = await awaitControlResponse(full.id, dir, timeoutMs);
  if (!res)
    throw new Error(
      `等 daemon 回复超时（${req.kind}）。它可能正忙或已退出，用 wemind list 看状态、daemon.log 看日志。`,
    );
  if (!res.ok) process.exitCode = 1; // ❌ 开头的答复 = 失败（脚本据此判成败）
  return res.text;
}

/** 会话命令归属的人：登录者（与 daemon 里 owner 的定义一致）。 */
export function ownerOf(key: string): string {
  return process.env.WECHAT_OWNER_ID?.trim() || readAccount(accountDir(key))?.userId || "";
}

/** daemon 没在跑时用来定会话归属（按 agent 分开存）的大脑名（与 daemon 启动期同一个解析来源：配置 + 环境变量 + 自动探测）。 */
export function agentNameOf(key: string): string {
  return resolveAgent(loadBrainConfig(accountDir(key)), accountDir(key)).name;
}

/**
 * 末尾那个「长得像账号」的位置参数摘出来当账号选择（`session list 工作号`）。
 * 认不出就当普通参数——session 的名字可能跟账号别名撞脸，宁可把它当名字。
 */
export function splitKeyArg(args: string[]): { args: string[]; sel?: string } {
  const last = args[args.length - 1];
  if (args.length && last && listAccounts().some((a) => a.key === last || a.label === last))
    return { args: args.slice(0, -1), sel: last };
  return { args };
}
