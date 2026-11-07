#!/usr/bin/env node
import path from "node:path";
import {
  WEMIND_ROOT,
  accountDir,
  setLabel,
  setDefaultKey,
  addAllowFrom,
  removeAllowFrom,
  readAllowFrom,
} from "@wemind/wechat-ilink-core";
import { cmdBrain } from "./subcommands/cli-brain.js";
import { cmdLogin, finalizeStaging } from "./subcommands/cli-login.js";
import { cmdSession, cmdSessionCurrent } from "./subcommands/cli-session.js";
import { cmdAutostart } from "./subcommands/autostart.js";
import { pickKey, resolveKey } from "./cli-context.js";
import {
  cmdTask,
  cmdTaskList,
  cmdTaskReply,
  cmdTaskStatus,
  cmdTaskStop,
  parseTaskId,
} from "./subcommands/cli-task.js";
import {
  cmdAdopt,
  cmdDelete,
  cmdList,
  cmdLogout,
  cmdStart,
  cmdStartAll,
  cmdStartKeys,
} from "./account-commands.js";
import { startDaemon, stopDaemon } from "./process-lifecycle.js";
import { CLI_VERSION, versionLine } from "../shared/version.js";
import { renderHelp } from "../ipc/chat-commands.js";

export { pickKey } from "./cli-context.js";
export { agentLabel } from "./subcommands/cli-brain.js";
export { createLoginStagingDir } from "./subcommands/cli-login.js";
export { resolveTaskCwd, taskAckOutcome } from "./subcommands/cli-task.js";
// 测试与旧调用方按 `manage.ts` 取这些进程辅助函数；实现已移到 process-lifecycle.ts。
export { brainRecord, descendantPids, stopSummary, deleteGuard } from "./process-lifecycle.js";

/**
 * WeMind 多账号管理 CLI。
 * 账号 key = 由微信 botId 派生的唯一标识；每个账号独立目录 ~/.wemind/<key>。
 * label = 人类可读别名（可改、可重复）；管理命令可用 key 或 label 选择账号。
 * 推荐用 `login` 一条命令完成：自刷新二维码 → 扫码 → 自动登记（→ 可选自动启动）。
 *
 * 拆分子模块（2026-11-06）：账号命令在 account-commands.ts，进程启停在 process-lifecycle.ts，
 * 大脑/登录/会话/任务的命令实现在 subcommands/；本文件只做参数解析与分派。
 */

/** 旧流程的固定暂存目录：仅 `wimind finalize` 兼容命令使用；新登录走 createLoginStagingDir()。 */
const LEGACY_STAGING = path.join(WEMIND_ROOT, ".staging");

export async function runManage(argv: string[]): Promise<void> {
  const cmd = argv.shift();
  const rest = [...argv];
  // autostart 的 --key / --label 是**子命令参数**：跳过下面的全局开关解析，否则会被 takeValue("--label") 抽走。
  const isAutostart = cmd === "autostart";
  // 取开关值：缺值（`--cwd` 后面没东西，或紧跟另一个开关）直接报错——以前会静默当成「没写」，用默认值继续跑。
  const takeValue = (flag: string): string | undefined => {
    if (isAutostart) return undefined;
    const i = rest.indexOf(flag);
    if (i < 0) return undefined;
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} 缺少参数值`);
    rest.splice(i, 2);
    return v;
  };
  const label = takeValue("--label");
  const si = isAutostart ? -1 : rest.indexOf("--start");
  const autoStart = si >= 0;
  if (autoStart) rest.splice(si, 1);
  const cwd = takeValue("--cwd");
  const runner = takeValue("--runner");
  if (runner && !["builtin", "pm2"].includes(runner.toLowerCase()))
    throw new Error(`未知 runner「${runner}」（可用：builtin / pm2）`);
  const agentKey = takeValue("--agent");

  switch (cmd) {
    case "autostart":
      await cmdAutostart(rest);
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(versionLine());
      break;
    case "login":
      await cmdLogin(label, autoStart, runner, { startDaemon });
      break;
    case "list":
      console.log(cmdList());
      break;
    case "brain":
      console.log(await cmdBrain(rest, { startDaemon }));
      break;
    case "session": {
      const sub = (rest[0] ?? "").toLowerCase();
      if (sub === "current") console.log(cmdSessionCurrent(pickKey(rest[1])));
      else console.log(await cmdSession(rest));
      break;
    }
    case "adopt":
      console.log(cmdAdopt(rest[0], label));
      break;
    case "start":
      // --all / all / 全部：遍历注册表逐个启动（自启触发时用的就是它）
      // 多个 key/label：逐个启动（Windows 计划任务只装部分账号时用）
      if (["--all", "all", "全部"].includes((rest[0] ?? "").toLowerCase()))
        console.log(cmdStartAll(runner));
      else if (rest.length > 1) console.log(cmdStartKeys(rest, runner));
      else console.log(cmdStart(rest[0], runner));
      break;
    case "stop": {
      const k = pickKey(rest[0]); // 省略账号 = 默认账号（答复带上解析到的账号，避免「静默换目标」）
      console.log(`账号 ${k}：${stopDaemon(k).msg}`);
      break;
    }
    case "task":
      console.log(await cmdTask(rest[0], cwd, rest[1], agentKey));
      break;
    case "task-reply": {
      // 兼容两种写法：`task-reply "#3 内容"` 与 `task-reply 3 "内容"`
      const first = rest[0] ?? "";
      const m = first.match(/^[#＃](\d+)\s*([\s\S]*)$/);
      if (m) console.log(await cmdTaskReply(m[2], rest[1], parseTaskId(m[1])));
      else if (rest.length >= 2 && /^\d+$/.test(first))
        console.log(await cmdTaskReply(rest[1], rest[2], parseTaskId(first)));
      else console.log(await cmdTaskReply(first, rest[1]));
      break;
    }
    case "task-list":
      console.log(cmdTaskList(rest[0]));
      break;
    case "task-status":
      console.log(cmdTaskStatus(rest[0]));
      break;
    case "task-stop": {
      const a = rest[0];
      const id: number | "all" | undefined =
        a === "all" || a === "全部" ? "all" : a && /^\d+$/.test(a) ? parseTaskId(a) : undefined;
      console.log(await cmdTaskStop(id === undefined ? a : rest[1], id));
      break;
    }
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
      const { msg } = finalizeStaging(LEGACY_STAGING, label);
      console.log(msg);
      break;
    } // 兼容旧流程（staging 已有登录时直接收进账号目录）
    case "allow": {
      const k = resolveKey(rest[0]);
      const uid = rest[1];
      if (!uid) throw new Error("用法: allow <key|label> <userId>");
      const list = addAllowFrom(uid, accountDir(k));
      console.log(`已加入白名单 ${uid} → ${k}\n当前清单(${list.length})：${list.join(", ")}`);
      break;
    }
    case "revoke": {
      const k = resolveKey(rest[0]);
      const uid = rest[1];
      if (!uid) throw new Error("用法: revoke <key|label> <userId>");
      const list = removeAllowFrom(uid, accountDir(k));
      console.log(
        `已从白名单移除 ${uid} → ${k}\n当前清单(${list.length})：${list.join(", ") || "（空）"}`,
      );
      break;
    }
    case "allowlist": {
      const k = resolveKey(rest[0]);
      const list = readAllowFrom(accountDir(k));
      console.log(
        `${k} 登录者白名单(${list.length})：\n${list.map((u) => "  - " + u).join("\n") || "  （空）"}`,
      );
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(helpText());
      break;
    default:
      // 拼错命令不能静默成功：脚本里 `wemind strat x` 以前 exit 0，看起来像成功。
      // 提示与帮助都走 stderr（stdout 保持为空），并以 2 退出（2 = 用法错误，与「运行出错」的 1 区分）。
      console.error(`未知命令：${cmd}`);
      console.error(helpText());
      process.exitCode = 2;
  }
}

export function helpText(): string {
  return `WeMind 多账号管理（wemind v${CLI_VERSION}）
用法: wemind <command>            其余：wemind version | help

  login [--label 名] [--start]   一条命令完成扫码登录：自刷新二维码 + 自动登记（--start 顺带启动 daemon）
  list                           列出账号、别名、运行状态（含 brain 进程与 worker 池）
  start [key|label]              启动某账号的 daemon（省略 = 默认账号）
  start --all | <key1> <key2>…   启动所有 / 指定的多个账号（开机自启触发时用 --all）
  stop [key|label]               停止某账号的 daemon（连带 brain 与全部 worker 进程树；省略 = 默认账号）
  autostart install [--all|--key <key>|--label 名]
                                 安装开机自启（默认所有账号；检测到 PM2 优先用 PM2，否则用系统触发器）
  autostart status               查看自启方式与冲突（none / native-only / pm2-only / mixed）
  autostart uninstall            移除自启（PM2 实例与计划任务/systemd/LaunchAgent 一并清理）
  brain set <agent 名|auto> [--bin X] [--args "…"] [--extra-args "…"] [--shell|--no-shell] [--model X|auto] [--restart] [<key|label>]
                                 改账号大脑**配置**（写 brain.json；只给 agent 名且 daemon 认桥时当场应用；带 --bin/--args/--extra-args/--shell/--model 只写盘——除 --shell 外可用同名 brain switch 当场应用；--extra-args 追加在预设参数后，不会漏掉 ACP 子命令）
  brain unset|check|show [<key|label>]   清除配置 / 真机 ACP 自检 / 查看配置与生效情况
  logout <key|label>             停 daemon + 通知下线 + 清凭证（保留目录，可重登）
  delete <key|label>             停 daemon + 删除目录 + 移除注册
  label <key|label> <新别名>     改别名
  set-default <key|label>        设默认账号
  adopt <key> [--label 名]       把已存在的账号目录登记进注册表
  allowlist <key|label>          查看该账号的登录者白名单(allowFrom)
  allow <key|label> <userId>     （兜底）把某 userId 加进白名单（正常只会有登录者本人）
  revoke <key|label> <userId>    （兜底）从白名单里移除某 userId

【与微信等价的操作指令】以下都能带 [<key|label>]（省略则用默认账号）。
运行中的命令经**控制桥**交给 daemon 执行（CLI 与微信走同一段代码，行为一致）；daemon 没跑时，
读命令照常可用，部分写命令会只改文件或提示先启动。

${renderHelp("owner", "cli", { sections: ["brain", "session", "task", "misc"] })}

说明：key = 由微信 botId 派生的唯一标识（目录名）；label = 人类可读别名。多数命令可用 key 或 label。
省略账号的命令（start/stop 与会话/任务类）用**默认账号**：首个登记的账号自动成为默认，可用 set-default 改、list 里看 [默认]。
logout/delete 等破坏性命令仍必须显式指定账号。`;
}
// 入口由 cli.ts 调用 runManage(argv)；此处不再顶层自启。
