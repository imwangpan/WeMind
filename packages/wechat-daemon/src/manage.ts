#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  saveAccountTo,
  loadAccount as readAccount,
  clearSessionPause,
  notifyStart,
  notifyStop,
  addAllowFrom,
  removeAllowFrom,
  readAllowFrom,
} from "@wemind/wechat-ilink-core";
import { pm2Start, pm2Stop } from "./pm2-runner.js";
import { watchdogStart } from "./watchdog-runner.js";
import {
  CLI_PID_MARKERS,
  brainPidMarkers,
  commandLines,
  isAlive,
  isOurProcess,
  matchesMarkers,
} from "./proc-identity.js";
import {
  ACP_AGENT_PRESETS,
  AUTO_PROBE_ORDER,
  resolveAgent,
  agentProblem,
  presetAvailable,
  acpArgsWarning,
  type ResolvedAgent,
} from "./brain-agents.js";
import {
  loadBrainConfig,
  updateBrainConfig,
  clearBrainConfig,
  brainConfigPath,
  type BrainConfig,
} from "./brain-config.js";
import { checkAgent } from "./brain-check.js";
import { acpOverrideHint } from "./profile-model.js";
import { readPidRecords, recordMarkers } from "./pid-record.js";
import { CLI_VERSION, versionLine } from "./version.js";
import { renderHelp } from "./chat-commands.js";
import {
  awaitControlResponse,
  bridgePidOf,
  controlTimeoutMs,
  newRequestId,
  writeControlRequest,
  type ControlKind,
  type ControlRequest,
} from "./control-bridge.js";
import {
  currentSessionIdOf,
  deleteSession,
  listSessions,
  renderSessionList,
  renameSession,
} from "./session-registry.js";
import { clearSessionPointer, brainSessionMapPath, sessionKey } from "./session-map.js";
import { awaitTaskAck, writeTaskCmd as writeTaskCommand } from "./task-inbox.js";

/**
 * WeMind 多账号管理 CLI。
 * 账号 key = 由微信 botId 派生的唯一标识；每个账号独立目录 ~/.wemind/<key>。
 * label = 人类可读别名（可改、可重复）；管理命令可用 key 或 label 选择账号。
 * 推荐用 `login` 一条命令完成：自刷新二维码 → 扫码 → 自动登记（→ 可选自动启动）。
 */

const BASE = process.env.WEMIND_ILINK_BASE?.trim() || "https://ilinkai.weixin.qq.com";
const STAGING = path.join(WEMIND_ROOT, ".staging");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readPid(dir: string, name: string): number | null {
  try {
    const n = parseInt(fs.readFileSync(path.join(dir, name), "utf-8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * 大脑进程的身份记录（`brain.pid` 现在是 JSON，见 pid-record.ts）：首条非 legacy 记录。
 * 记录里存的是**起进程时真实用的** bin/args —— 比「按当前配置猜」可靠：
 * `wemind brain set X` 之后、热切换窗口内、以及 brain≠worker 时，配置值都可能与实际在跑的进程不一致。
 * （导出仅供单测。）
 */
export function brainRecord(dir: string): {
  pid: number | null;
  markers: string[][] | null;
  agent: string;
} {
  const rec = readPidRecords(path.join(dir, "brain.pid"))[0];
  if (!rec) return { pid: null, markers: null, agent: "" };
  const markers = recordMarkers(rec);
  return { pid: rec.pid, markers: markers.length ? markers : null, agent: rec.agent };
}
/**
 * 该 pid 是否「活着**且确实是我们自己的** CLI 进程」。
 * 只判存活不够：pid 会复用（尤其重启后），陈旧 pid 文件可能指向**别人的**进程 → 会误杀/误判。
 */
function aliveOurs(pid: number | null, markers: string[][] = CLI_PID_MARKERS): boolean {
  return isOurProcess(pid, markers);
}

/** 阻塞式 sleep（CLI 是同步流程；Atomics.wait 不占 CPU、不比 spawn 一个进程贵）。 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* ignore */
  }
}

/**
 * 某 pid 的全部后代（POSIX）。Windows 不需要——`taskkill /T` 自己会走进程树。
 * 用 `ps -A -o pid=,ppid=` 一次取全表再在内存里建树，比逐层 `pgrep -P` 少起进程。
 * （导出仅供单测；CLI 内部不对外。）
 */
export function descendantPids(pid: number): number[] {
  try {
    // procps（Linux）与 BSD/macOS 的 ps 都认 `-A`；个别精简环境（BusyBox）只有 `-e`，故兜底一次。
    const psArgs = [
      ["-A", "-o", "pid=,ppid="],
      ["-e", "-o", "pid=,ppid="],
    ];
    let stdout = "";
    for (const args of psArgs) {
      const r = spawnSync("ps", args, { encoding: "utf8", timeout: 5000 });
      if (r.status === 0 && r.stdout) {
        stdout = r.stdout;
        break;
      }
    }
    const childrenOf = new Map<number, number[]>();
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!m) continue;
      const child = Number(m[1]);
      const parent = Number(m[2]);
      const bucket = childrenOf.get(parent);
      if (bucket) bucket.push(child);
      else childrenOf.set(parent, [child]);
    }
    const out: number[] = [];
    const walk = (p: number): void => {
      for (const c of childrenOf.get(p) ?? []) {
        out.push(c);
        walk(c);
      }
    };
    walk(pid);
    return out;
  } catch {
    return [];
  }
}

/**
 * 杀「pid 及其整棵进程树」。
 *
 * Windows：`taskkill /T /F` 本来就连带子树。
 * POSIX：`process.kill(pid)` **只**结束该进程，不动它的子进程——daemon 被停后，它拉起的 ACP 大脑 / worker 会留下来继续占着会话与文件句柄（Windows 的 `taskkill /T` 会连带子树，所以这个缺陷只在 POSIX 暴露）。
 * 所以这里先收集后代、由叶子往根 SIGTERM（daemon 的 SIGTERM 处理器会自己清 pid 文件），等一小会儿再对仍存活的补 SIGKILL。
 */
function killProcessTrees(pids: number[]): void {
  const unique = [...new Set(pids.filter((p) => isAlive(p)))];
  if (!unique.length) return;
  if (process.platform === "win32") {
    for (const pid of unique)
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true, // 避免瞬时闪出控制台窗口
      });
    return;
  }
  // 先收集所有后代（按叶子优先排序：后出现的更深，反过来就是叶子先）
  const targets: number[] = [];
  for (const pid of unique) targets.push(...descendantPids(pid).reverse(), pid);
  const all = [...new Set(targets)].filter((p) => isAlive(p));
  for (const pid of all) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
  sleepSync(800); // 给 SIGTERM 处理器一点时间（daemon 会清 pid 文件、关子进程）
  for (const pid of all) {
    if (!isAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
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
  // 用 process.argv[1]（即正在执行的 cli.js 绝对路径），而不是 dirname(import.meta.url)：
  // 发布后 tsdown 把 manage.ts 内联进 dist/cli.js，两者恰好相同；但若将来拆成多 chunk，argv[1] 才是「用户装的那个 bin」，dirname(import.meta.url) 可能是 dist/chunks/ 下。
  const cliPath =
    process.argv[1] || path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  // start 前先停现有任何 runner（pm2 app / builtin 后台守护进程），避免同账号双跑抢 token
  stopDaemon(key);
  const useRunner = (runner || process.env.WEMIND_RUNNER || "builtin").toLowerCase();
  console.log((useRunner === "pm2" ? pm2Start(key, cliPath) : watchdogStart(key, cliPath)).msg);
}

/**
 * 停止某账号的常驻：先 pm2 delete（方案 a），再按 pid 兜底杀 wrapper/daemon/brain/worker（兼容直接启动的）。停的是**整条链**：除列出的进程外，还连带它们的子进程树。
 */
function stopDaemon(key: string): string {
  pm2Stop(key); // best-effort：停掉 pm2 托管的 app（若有）
  const dir = accountDir(key);
  const ag = resolveAgent(loadBrainConfig(dir));
  // brain：优先用身份记录里「起进程时真实用的」bin/args 算特征串；没有记录（旧账号/未起过）才回退配置。
  const brec = brainRecord(dir);
  const brainMarkers = brec.markers ?? brainPidMarkers(ag.bin, ag.args);
  const cand: Array<{ pid: number | null; name: string; markers: string[][] }> = [
    { pid: readPid(dir, "wrapper.pid"), name: "wrapper", markers: CLI_PID_MARKERS },
    { pid: readPid(dir, "daemon.pid"), name: "daemon", markers: CLI_PID_MARKERS },
    { pid: brec.pid ?? readPid(dir, "brain.pid"), name: "brain", markers: brainMarkers },
  ];
  // worker：现在可能**多条并存**（多任务/多 agent），身份记录 `workers.pid.json` 里每条都带着起进程时真实用的 bin/args
  // → 逐条按自己的特征串判定。旧账号只有裸整数 `worker.pid`（无 bin/args）→ 回退「按配置算特征串」的老办法。
  const wrecs = readPidRecords(path.join(dir, "workers.pid.json"));
  if (wrecs.length) {
    for (const w of wrecs)
      cand.push({
        pid: w.pid,
        name: `worker${w.taskId ? `#${w.taskId}` : ""}(${w.agent || "?"})`,
        markers: recordMarkers(w),
      });
  } else {
    cand.push({
      pid: readPid(dir, "worker.pid"),
      name: "worker",
      markers: brainPidMarkers(ag.bin, ag.args),
    });
  }
  // 只杀「活着**且身份确认**」的：pid 会被复用，陈旧 pid 文件可能指向别人的进程 → 绝不误杀。
  // 命令行一次批量查（Windows 下较慢）；正常情况（陈旧 pid 早已不存在）根本不会发起查询。
  const lines = commandLines(cand.map((c) => c.pid));
  const stopped: string[] = [];
  const skipped: string[] = [];
  const toKill: number[] = [];
  const seen = new Set<number>();
  for (const c of cand) {
    if (!c.pid || seen.has(c.pid) || !isAlive(c.pid)) continue;
    seen.add(c.pid);
    if (matchesMarkers(lines.get(c.pid), c.markers)) {
      toKill.push(c.pid);
      stopped.push(`${c.name} ${c.pid}`);
    } else {
      skipped.push(`${c.name} ${c.pid}`); // 活着的 pid 但不是我们的（pid 复用）→ 不杀
    }
  }
  // 身份校验都通过了才动手：一次性杀掉这些进程**及其子进程树**（见 killProcessTrees 注释）。
  killProcessTrees(toKill);
  for (const f of ["wrapper.pid", "daemon.pid", "brain.pid", "worker.pid", "workers.pid.json"]) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* ignore */
    }
  }
  const parts: string[] = [];
  if (stopped.length) parts.push(`已停止 ${stopped.join(" + ")}`);
  if (skipped.length)
    parts.push(`跳过 ${skipped.join(" + ")}（非本程序，未杀；已清陈旧 pid 文件）`);
  return parts.length ? parts.join("；") : "无运行中的进程";
}

/** 把 STAGING 的登录按 botId 收进账号目录 + 登记。 */
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
  return { key, msg: `已登录：key=${key}  label=${meta.label}  botId=${acc.botId}\n目录：${dest}` };
}

/**
 * 懒加载 `qrcode`：只有扫码登录要画二维码，`list` / `brain` / `task` / `daemon` 全用不上。
 * 顶层 `import` 会让**每次**启动都付约 36ms（实测）解析 qrcode + yargs 依赖树；这里在第一次画码时才加载，之后同进程内复用（登录过程会因过期刷新多次）。
 * 用函数声明而非 `const QRCode = await import(...)`：后者在 ESM 顶层要多一层 TDZ 心智负担。
 */
let qrcodeMod: typeof import("qrcode") | undefined;

async function loadQrCode(): Promise<typeof import("qrcode")> {
  if (!qrcodeMod) {
    try {
      qrcodeMod = await import("qrcode");
    } catch (e) {
      throw new Error(
        `无法加载二维码库 qrcode（依赖缺失或安装损坏）：${e instanceof Error ? e.message : String(e)}\n` +
          "请重试安装：npm i -g @wemind/cli",
      );
    }
  }
  return qrcodeMod;
}

/** 一条命令完成扫码登录：自刷新二维码 + 终端码 + 自动开图 + 自动登记（→ 可选自动启动）。 */
async function cmdLogin(
  label: string | undefined,
  autoStart: boolean,
  runner?: string,
): Promise<void> {
  const QRCode = await loadQrCode(); // 只有登录路径才加载 qrcode
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
      // 走 core 的 saveAccountTo：POSIX 600 + Windows 一次性明文告警。
      // 之前这里是裸 writeFileSync，导致「凭证受权限保护」的安全承诺在 CLI 登录路径上不成立。
      saveAccountTo(STAGING, {
        botToken: s.bot_token,
        botId: s.ilink_bot_id,
        userId: s.ilink_user_id,
        baseUrl: s.baseurl ?? BASE,
        savedAt: Date.now(),
      });
      clearSessionPause(s.ilink_bot_id);
      await notifyStart({ baseUrl: s.baseurl ?? BASE, token: s.bot_token }).catch(() => {});
      for (const f of ["qrcode.png", "qr_login.json"]) {
        try {
          fs.unlinkSync(path.join(STAGING, f));
        } catch {
          /* ignore */
        }
      }
      console.log("\n登录成功，正在登记…");
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
  // 先收集各账号的 pid + 大脑特征，再**一次性**批量查命令行（Windows 下每次查询较慢）；只凭「pid 活着」显示状态会在重启后 pid 复用时骗人，所以要带身份校验。
  const entries = accs.map((a) => {
    const dir = accountDir(a.key);
    const ag = resolveAgent(loadBrainConfig(dir));
    const brec = brainRecord(dir);
    return {
      a,
      dir,
      dpid: readPid(dir, "daemon.pid"),
      bpid: brec.pid ?? readPid(dir, "brain.pid"),
      // 身份记录里是「起进程时真实用的」bin/args，比配置值可靠（brain set 未重启 / 热切换窗口 / brain≠worker）
      brainMarkers: brec.markers ?? brainPidMarkers(ag.bin, ag.args),
      brainAgent: brec.agent,
      // 多 task worker：`workers.pid.json` 是记录数组（每条一个 agent/任务），逐条按自己的身份校验
      workers: readPidRecords(path.join(dir, "workers.pid.json")).map((w) => ({
        pid: w.pid,
        agent: w.agent,
        state: w.state,
        taskId: w.taskId,
        markers: recordMarkers(w),
      })),
    };
  });
  const lines = commandLines(
    entries.flatMap((e) => [e.dpid, e.bpid, ...e.workers.map((w) => w.pid)]),
  );
  const aliveOursIn = (pid: number | null, markers: string[][]): boolean =>
    !!pid && matchesMarkers(lines.get(pid), markers);
  return entries
    .map((e) => {
      const running = aliveOursIn(e.dpid, CLI_PID_MARKERS) ? `运行中(pid ${e.dpid})` : "已停止";
      const brainPid = aliveOursIn(e.bpid, e.brainMarkers)
        ? `  brain(pid ${e.bpid}${e.brainAgent ? ` ${e.brainAgent}` : ""})`
        : "";
      const live = e.workers.filter((w) => aliveOursIn(w.pid, w.markers));
      const pool = live.length
        ? `  pool[${live.map((w) => `${w.agent}${w.taskId ? `#${w.taskId}` : ""}:${w.state}`).join(", ")}]`
        : "";
      return `- ${e.a.key}${e.a.key === def ? " [默认]" : ""}  label=${e.a.label}  botId=${e.a.botId}  agent=${agentLabel(e.dir)}  ${running}${brainPid}${pool}`;
    })
    .join("\n");
}

// ===== 大脑（ACP agent）选择：账号级持久配置 brain.json，见 brain-config.ts =====
const BRAIN_SRC_LABEL: Record<ResolvedAgent["source"], string> = {
  env: "环境变量 WEMIND_BRAIN*",
  file: "账号 brain.json",
  auto: "自动探测（未配置）",
};

/** list 用：账号「配置 / 自动探测」得到的大脑标签（不看当前 shell 的 env，避免误导）。 */
function agentLabel(dir: string): string {
  const cfg = loadBrainConfig(dir);
  if (cfg?.agent && cfg.agent.toLowerCase() !== "auto") return cfg.agent;
  const picked = AUTO_PROBE_ORDER.find((k) => presetAvailable(k));
  return picked ? `${picked}（自动）` : "（无可用）";
}

/** `wemind brain`（show）：打印某账号大脑的「配置」与「生效」情况。 */
function describeBrain(key: string): string {
  const dir = accountDir(key);
  const cfg = loadBrainConfig(dir);
  const ag = resolveAgent(cfg);
  const problem = agentProblem(ag);
  const cfgLine = cfg
    ? `brain.json → agent=${cfg.agent}${cfg.bin ? ` bin=${cfg.bin}` : ""}${cfg.args ? ` args=[${cfg.args.join(" ")}]` : ""}${cfg.extraArgs ? ` extra_args=[${cfg.extraArgs.join(" ")}]` : ""}${cfg.shell !== undefined ? ` shell=${cfg.shell}` : ""}${cfg.model ? ` model=${cfg.model}` : ""}`
    : "（未设置 brain.json）";
  const lines = [
    `账号 ${key}`,
    `  配置：${cfgLine}`,
    `  请求：${ag.requestedKey}    来源：${BRAIN_SRC_LABEL[ag.source]}`,
    `  生效：name=${ag.name}  bin=${ag.bin}  args=[${ag.args.join(" ")}]  shell=${ag.shell}  home_env=${ag.homeEnvVar ?? "(无)"}  model=${ag.model ?? "(agent 默认)"}  session_mode=${ag.sessionMode ?? "(无)"}`,
    `  可用：${problem ? `❌ ${problem}` : `✅ ${ag.binPath ?? ag.bin}`}`,
    `  可选 agent：${Object.keys(ACP_AGENT_PRESETS).join("、")}`,
    `  自动探测顺序：${AUTO_PROBE_ORDER.join(" → ")}`,
  ];
  // D：整段替换 args 后漏了 ACP 模式参数时提醒（只是提醒；运行时另有握手失败的诊断提示）
  const argsWarn = acpArgsWarning(ag.name, ag.args, ag.binOverridden);
  if (argsWarn) lines.push(`  ⚠️ ${argsWarn}`);
  // 用户层 profile 缺 `- id: acp` 时给出「你自己补上」的提示（WeMind 只原样同步配置，不替 agent 合成）
  const hint =
    ag.realProfile && ag.realHome && ag.inherit
      ? acpOverrideHint(ag.realHome, ag.realProfile)
      : null;
  if (hint) lines.push("", hint);
  return lines.join("\n");
}

/** `wemind brain set <agent 名|auto>`：把选择按账号写入磁盘（可选 --bin/--args/--extra-args/--shell/--model；--restart 立即重启 daemon）。 */
async function cmdBrainSet(
  agentName: string,
  key: string,
  opts: {
    bin?: string;
    args?: string;
    extraArgs?: string;
    shell?: boolean;
    model?: string;
    restart: boolean;
  },
): Promise<string> {
  const agent = agentName.trim().toLowerCase();
  if (agent !== "auto" && !ACP_AGENT_PRESETS[agent])
    throw new Error(
      `未知 agent「${agentName}」。可选：auto、${Object.keys(ACP_AGENT_PRESETS).join("、")}（自定义二进制用 --bin 搭配任一 agent）`,
    );
  if (opts.model !== undefined) {
    if (!opts.model.trim()) throw new Error("--model 缺少参数值（清空/跟随默认请写 --model auto）");
    // auto 只是「自动探测」，解析时会被替换成探测到的具体 agent：写进 presets.auto 永远读不到，
    // 顶层的 model 又会下发给探测出来的任意 agent（把 DSH 的模型值发给 opencode 之类）。
    if (agent === "auto")
      throw new Error(
        "`auto` 是「自动探测」，不绑定具体 agent，不能配 --model；请指定具体 agent（如 brain set deepseek --model …）",
      );
  }
  const dir = accountDir(key);
  const customized =
    opts.bin !== undefined ||
    opts.args !== undefined ||
    opts.extraArgs !== undefined ||
    opts.shell !== undefined ||
    opts.model !== undefined;
  // 只选 agent（没带自定义启动参数）+ 没要求重启时，写入磁盘和「热切换」其实是同一件事：daemon 在跑且认桥就交给它一次做完——
  // 它先启动新大脑、成功才写 brain.json（失败退回，盘上不留半截结果），这比「写入磁盘 + 等下次重启」对用户更实在（决策⑪）。
  // 带 --bin/--args/--shell/--model 则**不能**当场应用：控制桥只接受 agent 名（见 control-bridge.ts 的安全边界）。
  if (!opts.restart && !customized && bridgeReady(key)) {
    const r = await cmdBrainSwitch(agent, key, false);
    // 热切换失败时**没有写入磁盘**（持久化放最后，见 brain-switch.ts）：把这点说清楚，否则用户会以为 brain.json 已经改了。
    return r.startsWith("❌")
      ? `${r}\n（brain.json **没有被改写**：换大脑失败就不写入磁盘——这是「失败就退回原来那个」的代价。想强制写入再重启：wemind brain set ${agent} --restart）`
      : r;
  }
  const patch: BrainConfig = { agent };
  if (opts.bin) patch.bin = opts.bin;
  if (opts.args !== undefined) patch.args = opts.args.trim() ? opts.args.trim().split(/\s+/) : [];
  if (opts.extraArgs !== undefined)
    patch.extraArgs = opts.extraArgs.trim() ? opts.extraArgs.trim().split(/\s+/) : [];
  if (opts.shell !== undefined) patch.shell = opts.shell;
  if (opts.model !== undefined) patch.model = opts.model.trim();
  // 读-改-写：保留 worker 段（任务侧独立选择）与 presets 段（按 agent 名存的启动覆盖），旧 agent 的覆盖自动迁移。
  const before = loadBrainConfig(dir);
  const cfg = updateBrainConfig(patch, dir);
  const lines = [
    `已设置 ${key} 的大脑：agent=${agent}${cfg.bin ? ` bin=${cfg.bin}` : ""}${cfg.args ? ` args=[${cfg.args.join(" ")}]` : ""}${cfg.extraArgs ? ` extra_args=[${cfg.extraArgs.join(" ")}]` : ""}${cfg.model ? ` model=${cfg.model}` : ""}`,
    `配置文件：${brainConfigPath(dir)}`,
  ];
  // D：整段替换 args 时检查 ACP 模式标记（只提醒，不阻止写入）
  if (opts.args !== undefined) {
    const binOverridden =
      opts.bin !== undefined ||
      !!before?.presets?.[agent]?.bin ||
      (before?.agent?.trim().toLowerCase() === agent && !!before?.bin);
    const warn = acpArgsWarning(agent, cfg.args ?? [], binOverridden);
    if (warn) lines.push(`⚠️ ${warn}`);
  }
  if (opts.restart) {
    const dpid = readPid(dir, "daemon.pid");
    if (aliveOurs(dpid)) {
      startDaemon(key);
      lines.push(`已重启 daemon（账号 ${key}）。`);
    } else {
      lines.push(`daemon 未在运行，未重启（用 wemind start ${key} 启动）。`);
    }
  } else if (customized && bridgeReady(key)) {
    // --bin/--args/--extra-args/--model 的改动其实可以由 `brain switch <同名 agent>` 当场应用（sameAgent 按这几项判「是不是同一个」）；--shell 不在判据里，只能重启。
    const viaSwitch =
      opts.bin !== undefined ||
      opts.args !== undefined ||
      opts.extraArgs !== undefined ||
      opts.model !== undefined;
    lines.push(
      `（带 --bin/--args/--extra-args/--shell/--model 的改动不能由 brain set 当场应用：控制桥只认 agent 名。重启后生效——wemind stop ${key} && wemind start ${key}${viaSwitch ? `；不想重启的话，接着执行 wemind brain switch ${agent} 也能当场应用（它按 name/bin/args/model 判断是不是同一个，改过就会真切换）` : ""}）`,
    );
  } else if (daemonAlive(key)) {
    lines.push(
      `（daemon 在跑但不是当前版本（不认控制桥）：盘已写好，重启一次才生效——wemind stop ${key} && wemind start ${key}）`,
    );
  } else {
    lines.push(`（daemon 需重启才生效：wemind start ${key}）`);
  }
  return lines.join("\n");
}

/** `wemind brain unset`：清除账号级配置，回退到自动探测/默认。 */
function cmdBrainUnset(key: string): string {
  const ok = clearBrainConfig(accountDir(key));
  return ok
    ? `${key} 已清除 brain.json（回退到自动探测/默认）。daemon 需重启才生效。`
    : `${key} 未设置 brain.json（无需清除）。`;
}

/** `wemind brain check`：真起一个进程跑 ACP 握手，验证大脑「不仅找得到、而且能说 ACP」。 */
async function cmdBrainCheck(key: string): Promise<string> {
  const ag = resolveAgent(loadBrainConfig(accountDir(key)));
  const problem = agentProblem(ag);
  if (problem) return `❌ ${key} 的大脑不可用：${problem}`;
  const r = await checkAgent(ag);
  return `${r.ok ? "✅" : "❌"} ${key} 大脑自检（${ag.name}，bin=${ag.bin}）：${r.detail}（${r.ms}ms）`;
}

/** brain 子命令派发：show（默认）/ set / unset / check。 */
async function cmdBrain(rest: string[]): Promise<string> {
  const argv = [...rest];
  const FLAGS = new Set([
    "--bin",
    "--args",
    "--extra-args",
    "--shell",
    "--no-shell",
    "--model",
    "--restart",
  ]);
  const takeFlag = (name: string): string | undefined => {
    // 同时认 `--model X` 与 `--model=X`：以前只按整 token 匹配 `--model`，等号写法会被当成未知开关静默丢掉（命令还报成功）。
    const eq = argv.find((t) => t.startsWith(`${name}=`));
    if (eq !== undefined) {
      const v = eq.slice(name.length + 1);
      if (!v) throw new Error(`${name} 缺少参数值`);
      argv.splice(argv.indexOf(eq), 1);
      return v;
    }
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    // `--bin` 后面没值、或紧跟的是另一个开关（`brain set kiro --bin --restart`）时，以前会静默把 `--restart` 当成 bin 的值，看起来「设置成功」但存进去的是错的。
    // 值本身允许以 `--` 开头（如 `--args "--experimental-acp"`），所以只对已知开关报错。
    if (v === undefined || FLAGS.has(v)) throw new Error(`${name} 缺少参数值`);
    argv.splice(i, 2);
    return v;
  };
  const bin = takeFlag("--bin");
  const argsOverride = takeFlag("--args");
  const extraArgsOverride = takeFlag("--extra-args");
  const model = takeFlag("--model");
  const restart = argv.includes("--restart");
  if (restart) argv.splice(argv.indexOf("--restart"), 1);
  const shell = argv.includes("--shell") ? true : argv.includes("--no-shell") ? false : undefined;
  for (const f of ["--shell", "--no-shell"]) {
    const i = argv.indexOf(f);
    if (i >= 0) argv.splice(i, 1);
  }
  while (argv.includes("--worker")) argv.splice(argv.indexOf("--worker"), 1); // 只对 switch 有意义（用 rest 判断），不留成未知开关
  // 未知开关直接报错：以前一律被 pos 的过滤静默丢掉，`--modle` 这种拼错会「看起来设置成功」。
  const unknown = argv.filter((x) => x.startsWith("--"));
  if (unknown.length)
    throw new Error(
      `未知参数：${unknown.join(" ")}（可用：--bin --args --extra-args --shell --no-shell --model --restart）`,
    );
  const pos = argv.filter((x) => x && !x.startsWith("--"));
  const first = (pos[0] || "").toLowerCase();
  const SUBCOMMANDS = new Set(["show", "set", "unset", "check", "switch", "handoff"]);
  if (first && !SUBCOMMANDS.has(first)) {
    // 省略子命令 → 视为 `brain show <key|label>`（如 `wemind brain 工作号`）。
    return describeBrain(pickKey(pos[0]));
  }
  const sub = first || "show";
  switch (sub) {
    case "show":
      return describeBrain(pickKey(pos[1]));
    case "set": {
      if (!pos[1])
        throw new Error(
          '用法: brain set <agent 名|auto> [--bin X] [--args "…"] [--extra-args "…"] [--shell|--no-shell] [--model X|auto] [--restart] [<key|label>]',
        );
      return await cmdBrainSet(pos[1], pickKey(pos[2]), {
        bin,
        args: argsOverride,
        extraArgs: extraArgsOverride,
        shell,
        model,
        restart,
      });
    }
    case "switch": {
      // 桥只接受**agent 名**（安全边界：见 control-bridge.ts）。带 --bin/--args/--shell/--model 就走 set（只写入磁盘；--bin/--args/--model 可随后用同名 switch 当场应用，--shell 只能重启）。
      if (
        bin !== undefined ||
        argsOverride !== undefined ||
        extraArgsOverride !== undefined ||
        shell !== undefined ||
        model !== undefined
      )
        throw new Error(
          "`brain switch` 只接受 agent 名（换大脑是「换一个已装好的 agent」，不能带 --bin/--args/--extra-args/--model）。\n" +
            "需要自定义二进制用 `brain set <agent 名> --bin …`（那是配置变更，只写入磁盘——之后 `wemind brain switch <同名 agent>` 可当场应用，或重启 daemon）；追加参数用 `brain set <agent 名> --extra-args …`；换模型用 `brain set <agent 名> --model …`。",
        );
      if (!pos[1]) throw new Error("用法: brain switch <agent 名|auto> [--worker] [<key|label>]");
      const worker = rest.includes("--worker");
      return await cmdBrainSwitch(pos[1], pickKey(pos[2]), worker);
    }
    case "handoff":
      return await cmdBrainHandoff(pickKey(pos[1]));
    case "unset":
      return cmdBrainUnset(pickKey(pos[1]));
    case "check":
      return await cmdBrainCheck(pickKey(pos[1]));
    default:
      throw new Error(
        `未知 brain 子命令「${sub}」（可用：show / set / switch / handoff / unset / check）`,
      );
  }
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
  if (acc.userId) addAllowFrom(acc.userId, accountDir(key)); // 接管时把登录者种入白名单
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

function cmdStart(sel?: string, runner?: string): string {
  const key = pickKey(sel); // 省略账号 = 默认账号
  startDaemon(key, runner);
  return `已启动 daemon（账号 ${key}）。用 list 查看运行状态。`;
}

// ===== 本地任务命令（文件桥）：写 task-inbox/*.json，由 daemon 扫描执行；状态读 task-state.json，结果读 task-out/*.json =====
/** 原子写一个命令文件到收件箱（临时文件 + rename，避免 daemon 读到半截）；返回本次命令的答复编号。 */
function writeTaskCmd(key: string, obj: Record<string, unknown>): string {
  return writeTaskCommand(accountDir(key), obj);
}

/**
 * 等这次命令的答复（daemon 把真实结果写进 `task-out/<id>.json`）。
 * 三种情形分得很清楚：
 *  - 有答复、有文案 → 打印 daemon 的那句话（失败原因、「没有 #9 号任务」这类只有它知道的事）；
 *  - 有答复、文案为空 → 命令成功但没有额外要说的，用调用方自己那句话（**立刻**，不干等）；
 *  - 没有答复 → 老版 daemon 不认这条通道（或它正在退出）：回退到「已发送」措辞并说明一句，
 *    不把「没等到」当成「成功了」——达上限被拒与「派发成功」在旧措辞里长得一模一样。
 */
async function taskOutcome(
  key: string,
  ackId: string,
  fallback: string,
  timeoutMs = 5000,
): Promise<string> {
  const a = await awaitTaskAck(accountDir(key), ackId, timeoutMs);
  if (!a)
    return `${fallback}\n（没等到 daemon 答复：它可能还在跑旧版本，或刚启动。用 task-list / task-status 核对实际状态。）`;
  return a.text || fallback;
}
/**
 * 选账号：显式 key/label 优先，否则用默认账号（`accounts.json` 的 `default`；缺失时回落第一个登记的账号，见 core 的 `getDefaultKey`）。
 * `session`/`task*` 早就是这个口径；`start`/`stop` 也走这里——所以「省略账号」= 默认账号。
 * 默认账号是可见的（`wemind list` 的 `[默认]`）、可改的（`wemind set-default`）；`logout`/`delete` 这类破坏性命令仍然必须显式指定，不走这里。
 */
export function pickKey(sel?: string): string {
  if (sel) return resolveKey(sel);
  const d = getDefaultKey();
  if (!d) throw new Error("无默认账号，请指定 <key|label> 或先 login");
  return d;
}
/** 预检 daemon 存活（本地命令需 daemon 在跑才有人消费收件箱）。 */
function requireDaemonAlive(key: string): void {
  const pid = readPid(accountDir(key), "daemon.pid");
  if (!aliveOurs(pid))
    throw new Error(
      `账号 ${key} 的 daemon 未运行。先启动：wemind start ${key}（用 wemind list 查看状态）`,
    );
}

// ===== 控制桥（CLI → daemon → 回话）：让 CLI 与微信指令走同一段代码 =====
/** daemon 是否活着（且确实是我们自己的进程）。读命令不需要它，写命令优先走它。 */
function daemonAlive(key: string): boolean {
  return aliveOurs(readPid(accountDir(key), "daemon.pid"));
}

/**
 * daemon 活着**且认识控制桥**（升级 CLI 后没重启的旧 daemon 在这里判为不可用）。
 * 决定「走桥还是走文件」都该问这个而不是 daemonAlive：对旧 daemon 发送只会白等到超时。
 */
function bridgeReady(key: string): boolean {
  const dir = accountDir(key);
  return daemonAlive(key) && bridgePidOf(dir) === readPid(dir, "daemon.pid");
}

/**
 * 经控制桥让 daemon 执行一条命令并等回话。
 * 超时**如实**报「没等到回复」——桥的价值就在于「CLI 说的」和「daemon 做的」是同一件事，绝不假装成功。
 */
async function viaBridge(key: string, req: Omit<ControlRequest, "id" | "at">): Promise<string> {
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
  const full: ControlRequest = { id: newRequestId(), at: Date.now(), ...req };
  writeControlRequest(full, dir);
  const res = await awaitControlResponse(full.id, dir, controlTimeoutMs(req.kind as ControlKind));
  if (!res)
    throw new Error(
      `等 daemon 回复超时（${req.kind}）。它可能正忙或已退出，用 wemind list 看状态、daemon.log 看日志。`,
    );
  if (!res.ok) process.exitCode = 1; // ❌ 开头的答复 = 失败（脚本据此判成败）
  return res.text;
}

/**
 * `brain switch <agent 名|auto>`：**热切换**——daemon 在跑就走控制桥（不重启、不打断在途回合）；
 * daemon 没在跑就只写 brain.json（下次启动生效）。
 * `--worker` 设默认任务大脑：那是 daemon 进程内才有的状态（不写入磁盘），没有 daemon 就没有意义，必须先启动。
 */
async function cmdBrainSwitch(agentName: string, key: string, worker: boolean): Promise<string> {
  const agent = agentName.trim().toLowerCase();
  if (agent !== "auto" && !ACP_AGENT_PRESETS[agent])
    throw new Error(
      `未知 agent「${agentName}」。可选：auto、${Object.keys(ACP_AGENT_PRESETS).join("、")}`,
    );
  const dir = accountDir(key);
  if (worker) {
    requireDaemonAlive(key); // 「默认任务大脑」是进程内状态，不写入磁盘
    return await viaBridge(key, { kind: "brain.worker", target: agent });
  }
  if (daemonAlive(key)) return await viaBridge(key, { kind: "brain.switch", target: agent });
  updateBrainConfig({ agent }, dir);
  return `daemon 未在运行：已把 ${key} 的大脑写进 brain.json（agent=${agent}，下次启动生效）。\n运行中换大脑：先 wemind start ${key}`;
}

/** 会话命令归属的人：登录者（与 daemon 里 owner 的定义一致）。 */
function ownerOf(key: string): string {
  return process.env.WECHAT_OWNER_ID?.trim() || readAccount(accountDir(key))?.userId || "";
}

/** daemon 没在跑时用来定会话归属（按 agent 分开存）的大脑名（与 daemon 启动期同一个解析来源：配置 + 环境变量 + 自动探测）。 */
function agentNameOf(key: string): string {
  return resolveAgent(loadBrainConfig(accountDir(key))).name;
}

/**
 * 末尾那个「长得像账号」的位置参数摘出来当账号选择（`session list 工作号`）。
 * 认不出就当普通参数——session 的名字可能跟账号别名撞脸，宁可把它当名字。
 */
function splitKeyArg(args: string[]): { args: string[]; sel?: string } {
  const last = args[args.length - 1];
  if (args.length && last && listAccounts().some((a) => a.key === last || a.label === last))
    return { args: args.slice(0, -1), sel: last };
  return { args };
}

/**
 * `wemind session <new|list|resume|rename|delete>`。
 * 读写规则：**读**永远可用（直接读登记表）；**写**优先走 daemon（单一写者，且会话当前会话记录/agent 侧状态都是它的活状态）。
 * 例外：`rename`/`delete` 只动登记表这一个文件，daemon 没跑时直接改也是安全的；`resume` 必须真让 agent load，没 daemon 做不了。
 */
async function cmdSession(rest: string[]): Promise<string> {
  const argv = [...rest];
  const pi = argv.indexOf("--page");
  let page: number | undefined;
  if (pi >= 0) {
    page = Number(argv[pi + 1]) || undefined;
    argv.splice(pi, 2);
  }
  const pos = argv.filter((x) => x && !x.startsWith("--"));
  const sub = (pos[0] ?? "").toLowerCase();
  const { args, sel } = splitKeyArg(pos.slice(1));
  const USAGE =
    "用法: session list [--page N] | session new [名字] | session resume <序号|名字|id前缀> | " +
    "session rename <序号|名字> <新名字> | session delete <序号|名字|id前缀>   [<key|label>]";

  if (sub === "list") {
    const key = pickKey(sel);
    // 读优先走桥（daemon 里在用的那个大脑才是真的会话归属）；桥不可用就退回直接读文件——读永远不该失败。
    if (bridgeReady(key)) return await viaBridge(key, { kind: "session.list", page });
    const dir = accountDir(key);
    const agent = agentNameOf(key);
    const userId = ownerOf(key);
    if (!userId) throw new Error(`账号 ${key} 没有 userId（account.json 不全），先重新登录。`);
    const { entries, others, currentSessionId } = listSessions(agent, userId, dir);
    const why = daemonAlive(key)
      ? "（daemon 是升级前启动的旧版本，没法问它：以上按 brain.json/自动探测的「下次会用的大脑」列出；重启 daemon 后以进程内在用的为准。）"
      : "（daemon 未运行：按 brain.json/自动探测得到的「下次会用的大脑」列出。）";
    return (
      renderSessionList(entries, { agent, page, currentSessionId, others, verbose: true }) +
      "\n" +
      why
    );
  }

  if (sub === "new") {
    const key = pickKey(sel);
    const name = args.join(" ").trim() || undefined;
    if (daemonAlive(key))
      return await viaBridge(key, { kind: "session.new", ...(name ? { name } : {}) });
    // 没 daemon：能做的只有「丢掉当前会话记录」——下条消息会开新的。名字要等会话真的建好再 rename。
    const dir = accountDir(key);
    const userId = ownerOf(key);
    if (!userId) throw new Error(`账号 ${key} 没有 userId（account.json 不全），先重新登录。`);
    const cleared = clearSessionPointer(
      brainSessionMapPath(dir),
      sessionKey(agentNameOf(key), userId),
    );
    return [
      cleared ? "已清空当前会话记录" : "当前本来就没有会话当前会话记录",
      "（daemon 未运行：下次启动后你发的第一条消息会开一个新会话）",
      name ? `名字等新会话建好后再登记：wemind session rename 1 ${name}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (sub === "resume") {
    const key = pickKey(sel);
    if (!args[0]) throw new Error(USAGE);
    requireDaemonAlive(key); // 恢复要真的让 agent load 那条会话：只有 daemon 里有 ACP 连接，做不了假
    return await viaBridge(key, { kind: "session.resume", ref: args.join(" ") });
  }

  if (sub === "rename" || sub === "delete") {
    const key = pickKey(sel);
    const [ref, ...nameRest] = args;
    if (!ref || (sub === "rename" && !nameRest.length)) throw new Error(USAGE);
    if (bridgeReady(key))
      return await viaBridge(
        key,
        sub === "rename"
          ? { kind: "session.rename", ref, name: nameRest.join(" ") }
          : { kind: "session.delete", ref },
      );
    // 只动登记表（+ 删除时可能清当前会话记录），daemon 不在也不影响它下次读到的结果
    const dir = accountDir(key);
    const userId = ownerOf(key);
    if (!userId) throw new Error(`账号 ${key} 没有 userId（account.json 不全），先重新登录。`);
    const agent = agentNameOf(key);
    if (sub === "delete") {
      const r = deleteSession(agent, userId, ref, { dir });
      if (!r.ok) {
        process.exitCode = 1;
        return `❌ ${r.error}`;
      }
      return `已从列表删除：${r.entry.name ?? r.entry.title ?? r.entry.sessionId.slice(0, 8)}。${
        r.clearedPointer ? "它就是当前会话，下一条消息会开一个新的。" : "当前会话没有变。"
      }`;
    }
    const r = renameSession(agent, userId, ref, nameRest.join(" "), dir);
    if (!r.ok) {
      process.exitCode = 1;
      return `❌ ${r.error}`;
    }
    return `已重命名：${r.entry.name}（当前 brain=${agent} 的会话）`;
  }

  throw new Error(USAGE);
}

/** `wemind brain handoff`：让当前大脑写一份交接摘要（与微信「交接」同一段实现）。 */
async function cmdBrainHandoff(key: string): Promise<string> {
  requireDaemonAlive(key);
  return await viaBridge(key, { kind: "brain.handoff" });
}

/** 当前会话记录（供 CLI 展示；不常用但排查时值钱）。 */
function cmdSessionCurrent(key: string): string {
  const agent = agentNameOf(key);
  const userId = ownerOf(key);
  const sid = userId ? currentSessionIdOf(agent, userId, accountDir(key)) : undefined;
  return sid
    ? `${key} 当前会话：${sid}（agent=${agent}）`
    : `${key} 当前没有会话当前会话记录（下一条消息会开新会话）。agent=${agent}`;
}

async function cmdTask(
  text: string,
  cwd: string | undefined,
  sel?: string,
  agentKey?: string,
): Promise<string> {
  if (!text) throw new Error('用法: task "<任务描述>" [--cwd 目录] [--agent <名字>] [<key|label>]');
  const key = pickKey(sel);
  requireDaemonAlive(key);
  const useCwd = cwd || process.cwd();
  // 答复等 daemon：**起进程有结果之后**它才发（达上限/agent 起不来是那时才知道的），
  // 所以这里不能自己编「已派发」——旧写法轮询 task-state.json 的 active，会把「达上限被拒」和
  // 甚至上一条任务的编号报成成功。
  const ackId = writeTaskCmd(key, {
    kind: "dispatch",
    text,
    cwd: useCwd,
    ...(agentKey ? { agent: agentKey } : {}),
  });
  return await taskOutcome(
    key,
    ackId,
    `已发送任务（cwd=${useCwd}）。看进展用 task-list。`,
    // 派发的答复要等「起进程有结果」：冷启动一个 agent 可能要几十秒，等得久一点好过说假话
    30_000,
  );
}
async function cmdTaskReply(text: string, sel?: string, id?: number): Promise<string> {
  if (!text) throw new Error('用法: task-reply ["#编号"] "<内容>" [<key|label>]');
  const key = pickKey(sel);
  requireDaemonAlive(key);
  const ackId = writeTaskCmd(key, { kind: "reply", text, ...(id ? { id } : {}) });
  return await taskOutcome(key, ackId, `已发送给任务${id ? ` #${id}` : ""}：${text.slice(0, 40)}`);
}
async function cmdTaskStop(sel?: string, id?: number | "all"): Promise<string> {
  const key = pickKey(sel);
  requireDaemonAlive(key);
  const ackId = writeTaskCmd(key, { kind: "stop", ...(id ? { id } : {}) });
  const fallback =
    id === "all" ? "已发送「结束全部任务」指令。" : `已发送「结束任务${id ? ` ${id}` : ""}」指令。`;
  return await taskOutcome(key, ackId, fallback);
}

type WmTaskRow = {
  id: number;
  userId: string;
  agent: string;
  status: string;
  turns: number;
  startedAt: number;
  lastOutput?: string;
  cwd?: string;
};
const STATUS_ZH: Record<string, string> = {
  running: "运行中",
  waiting: "等回复",
  interrupted: "已中断",
};

/**
 * 读任务表（daemon 没跑也能读：文件就是唯一真相）。
 * 先看 `tasks.json`——那是任务表的**持久**副本（重启后也在，编号跨重启不归零）；
 * 老版本只写过 `task-state.json`（状态记录），仍兼容读它。
 */
function readTaskRows(key: string): WmTaskRow[] | null {
  const dir = accountDir(key);
  for (const name of ["tasks.json", "task-state.json"]) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")) as {
        tasks?: WmTaskRow[];
      };
      if (Array.isArray(s.tasks)) return s.tasks;
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

function cmdTaskList(sel?: string): string {
  const key = pickKey(sel);
  const rows = readTaskRows(key);
  if (!rows)
    return `账号 ${key}：无任务表（tasks.json / task-state.json 都不存在，daemon 未跑过多任务）。`;
  // 任务表是 daemon 的活状态：它没在跑（或还在跑旧版）时，表里的「运行中」只是上次留下的，别当成现在时。
  const stale = daemonAlive(key)
    ? ""
    : "\n（daemon 未运行：以下状态是它上次留下的记录；未完成的任务会在下次启动时标为「已中断」，回「继续」可续跑。）";
  if (!rows.length) return `账号 ${key}：当前没有任务。${stale}`;
  const lines = [`账号 ${key} 任务（${rows.length} 条）：`];
  for (const t of rows) {
    const age = t.startedAt ? `${Math.round((Date.now() - t.startedAt) / 1000)}s` : "?";
    lines.push(
      `  #${t.id} [${t.agent}] ${STATUS_ZH[t.status] ?? t.status} · ${t.turns} 轮 · ${age}${t.cwd ? ` · cwd=${t.cwd}` : ""}`,
    );
    if (t.lastOutput) lines.push(`      ${t.lastOutput.replace(/\n/g, " ").slice(0, 140)}`);
  }
  return lines.join("\n") + stale;
}

function cmdTaskStatus(sel?: string): string {
  const key = pickKey(sel);
  const rows = readTaskRows(key);
  if (rows && rows.length) return cmdTaskList(sel);
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
  const ai = rest.indexOf("--agent");
  let agentKey: string | undefined;
  if (ai >= 0) {
    agentKey = rest[ai + 1];
    rest.splice(ai, 2);
  }

  switch (cmd) {
    case "version":
    case "--version":
    case "-v":
      console.log(versionLine());
      break;
    case "login":
      await cmdLogin(label, autoStart, runner);
      break;
    case "list":
      console.log(cmdList());
      break;
    case "brain":
      console.log(await cmdBrain(rest));
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
      console.log(cmdStart(rest[0], runner));
      break;
    case "stop": {
      const k = pickKey(rest[0]); // 省略账号 = 默认账号（答复带上解析到的账号，避免「静默换目标」）
      console.log(`账号 ${k}：${stopDaemon(k)}`);
      break;
    }
    case "task":
      console.log(await cmdTask(rest[0], cwd, rest[1], agentKey));
      break;
    case "task-reply": {
      // 兼容两种写法：`task-reply "#3 内容"` 与 `task-reply 3 "内容"`
      const first = rest[0] ?? "";
      const m = first.match(/^[#＃](\d+)\s*([\s\S]*)$/);
      if (m) console.log(await cmdTaskReply(m[2], rest[1], Number(m[1])));
      else if (rest.length >= 2 && /^\d+$/.test(first))
        console.log(await cmdTaskReply(rest[1], rest[2], Number(first)));
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
        a === "all" || a === "全部" ? "all" : a && /^\d+$/.test(a) ? Number(a) : undefined;
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
      const { msg } = finalizeStaging(label);
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
  stop [key|label]               停止某账号的 daemon（连带 brain 与全部 worker 进程树；省略 = 默认账号）
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
